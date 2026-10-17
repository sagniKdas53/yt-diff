import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { reply } from "./replies.ts";
import type { BotRuntime, DeliveryMode } from "./runtime.ts";
import { handleSubmission } from "./submissions.ts";
import type { BotStore, UnsettledSubmissionRecord } from "./store.ts";
import type { DeliveryTarget } from "./types.ts";

/**
 * Telegram keeps an undelivered update for 24 h and then drops it. Nothing on
 * this side can get an older message back, and a bot cannot read chat history,
 * so this is the only fact the outage notice has to work from.
 */
export const TELEGRAM_UPDATE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How stale the heartbeat has to be before a boot counts as an outage.
 *
 * The heartbeat is stamped once a minute, so a gap longer than this is not
 * scheduling jitter.
 */
export const OUTAGE_AFTER_MS = 5 * 60 * 1000;

/** Chats older than this are not told about an outage they slept through. */
const OUTAGE_CHAT_LOOKBACK_DAYS = 30;

/**
 * How many submissions one pass of the backlog reads.
 *
 * A page size and not a total: the replay walks every page until the backlog
 * runs out, so a long outage's hundred-and-first message is replayed in the
 * same boot as the first. Sized so each page is one query's worth of work and
 * one batch's worth of log lines.
 */
const RESUME_PAGE_SIZE = 100;

/**
 * The slice of the store the boot replay needs. Narrower than `BotStore` on
 * purpose: a test for this module hands over four functions, not sixteen.
 */
export type RecoveryStore = Pick<
  BotStore,
  | "listUnsettledSubmissions"
  | "listActiveChatsSince"
  | "getLastSeenAt"
  | "touchLastSeenAt"
>;

function formatStamp(at: Date): string {
  return at.toLocaleString("en-GB", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The one message that says what was lost.
 *
 * It cannot name the links — they are gone from Telegram's side — so it states
 * the window instead: everything before `boot - 24 h` is unrecoverable, and
 * anything after it is being picked up now.
 */
export function buildOutageNotice(lastSeenAt: Date, now: Date): string {
  const cutoff = new Date(now.getTime() - TELEGRAM_UPDATE_RETENTION_MS);
  const gap = `I was offline from ${formatStamp(lastSeenAt)} to ${
    formatStamp(now)
  }.`;
  // Asking people to resend work that was never lost is worse than saying
  // nothing: they cannot tell a resend from a duplicate. Only an outage that
  // reaches back past Telegram's own retention window has genuinely dropped
  // messages, and that is the only case where a resend is the answer.
  if (lastSeenAt.getTime() >= cutoff.getTime()) {
    return `${gap} Nothing was lost — links sent while I was down are being picked up now.`;
  }
  return `${gap} Anything you sent before ${
    formatStamp(cutoff)
  } never reached me — please resend it. Links from after that are being picked up now.`;
}

export interface RecoverySummary {
  announcedChats: number;
  resumed: number;
}

/**
 * What a restart owes the chat: one honest message about the gap, then the
 * work that was in flight.
 *
 * The notice goes first so the chat reads in the order things happened. The
 * backlog is replayed oldest-first and one at a time, which both preserves the
 * order a burst was sent in and keeps a large backlog from starting a hundred
 * yt-dlp processes at once.
 *
 * Every replayed submission goes through `handleSubmission` again rather than
 * being re-driven from the pipeline: the three dedupe tiers make it idempotent,
 * so a file that finished downloading before the crash is delivered instead of
 * downloaded twice, and an unknown link is indexed rather than assumed. The
 * row is reused rather than reopened, so one user request stays one row.
 */
export async function runBootRecovery(
  rt: BotRuntime,
  store: RecoveryStore,
  now: Date = new Date(),
): Promise<RecoverySummary> {
  const summary: RecoverySummary = { announcedChats: 0, resumed: 0 };
  const lastSeenAt = await store.getLastSeenAt();

  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() > OUTAGE_AFTER_MS) {
    summary.announcedChats = await announceOutage(rt, store, lastSeenAt, now);
  } else if (!lastSeenAt) {
    logger.info("No previous bot heartbeat; skipping outage notice", {});
  }

  // Stamped before the replay so an adapter failure in the middle of it cannot
  // leave a stale heartbeat behind and make the next boot announce an outage
  // that never happened.
  await store.touchLastSeenAt(now);

  // Paged rather than read once. A backlog larger than RESUME_PAGE_SIZE is not a
  // hypothetical — a long outage queues every message the chat sent, and the
  // first hundred were all this replayed, so everything past them waited for a
  // second restart that might never come.
  let cursor: { createdAt: Date; id: string } | null = null;
  let visited = 0;
  while (true) {
    const page = await store.listUnsettledSubmissions(RESUME_PAGE_SIZE, cursor);
    if (page.length === 0) {
      break;
    }
    if (visited === 0 && page.length > 0) {
      logger.info("Replaying submissions that were in flight at shutdown", {
        count: page.length,
      });
    }

    // Advanced before anything on the page is replayed. A row that has no
    // adapter, comes from a chat off the allowlist, or throws on the way
    // through still has to move the cursor: otherwise the next page selects it
    // again and the submissions behind it are never reached.
    const last = page.at(-1)!;
    cursor = { createdAt: last.createdAt, id: last.id };
    visited += page.length;

    await replayPage(rt, page, summary);

    // A short page means the backlog is exhausted.
    if (page.length < RESUME_PAGE_SIZE) {
      break;
    }
  }

  if (visited > 0) {
    logger.info("Replayed the in-flight backlog", { visited });
  }

  return summary;
}

/**
 * Replays one page of in-flight submissions, oldest first.
 *
 * Every failure is contained: one submission that cannot be replayed is logged
 * and left behind, because the ones after it are still somebody's waiting.
 */
async function replayPage(
  rt: BotRuntime,
  page: readonly UnsettledSubmissionRecord[],
  summary: RecoverySummary,
): Promise<void> {
  for (const row of page) {
    const adapter = rt.adaptersByPlatform.get(row.platform);
    if (!adapter) {
      logger.warn("Skipping resumed submission with no adapter", {
        platform: row.platform,
        submissionId: row.id,
      });
      continue;
    }

    if (!rt.deps.allowedChatIds.includes(row.chatId)) {
      logger.warn(
        "Skipping resumed submission from a chat off the allowlist",
        { chatId: row.chatId, submissionId: row.id },
      );
      continue;
    }

    const target: DeliveryTarget = {
      platform: row.platform,
      chatId: row.chatId,
    };
    try {
      await reply(
        adapter,
        target,
        "Picking up where I left off — this one was still in flight when I restarted.",
      );
      await handleSubmission(
        rt,
        adapter,
        {
          platform: row.platform,
          chatId: row.chatId,
          // No message to edit: the ack from before the crash may be days old,
          // and Telegram refuses edits to messages older than 48 h anyway.
          messageId: "",
          text: row.requestedUrl,
        },
        row.requestedUrl,
        (row.requestedDeliveryMode ?? "file") as DeliveryMode,
        { submissionId: row.id },
      );
      summary.resumed++;
    } catch (error) {
      logger.error("Could not replay a submission after restart", {
        submissionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * One message per chat that has used the bot recently.
 *
 * Skipped entirely on a clean restart: the heartbeat is fresh, so there is no
 * gap to report, and a bot that apologises for a restart it did not have is
 * just noise.
 */
async function announceOutage(
  rt: BotRuntime,
  store: RecoveryStore,
  lastSeenAt: Date,
  now: Date,
): Promise<number> {
  const chats = await store.listActiveChatsSince(
    new Date(now.getTime() - OUTAGE_CHAT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
  );
  const notice = buildOutageNotice(lastSeenAt, now);
  let announced = 0;

  for (const chat of chats) {
    if (!rt.deps.allowedChatIds.includes(chat.chatId)) {
      continue;
    }
    const adapter = rt.adaptersByPlatform.get(chat.platform);
    if (!adapter) {
      continue;
    }
    try {
      await reply(
        adapter,
        { platform: chat.platform, chatId: chat.chatId },
        notice,
      );
      announced++;
    } catch (error) {
      logger.error("Could not send the outage notice", {
        chatId: chat.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Sent the outage notice", {
    lastSeenAt: lastSeenAt.toISOString(),
    now: now.toISOString(),
    chats: announced,
  });
  return announced;
}
