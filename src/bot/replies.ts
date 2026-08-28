import { logger } from "../logger.ts";
import type { BotRuntime, PendingSubmission } from "./runtime.ts";
import type { BotAdapter, DeliveryTarget, MessageRef } from "./types.ts";

/**
 * Longest reply the bot will send.
 *
 * Telegram rejects anything past 4096 characters outright, and a full /list or
 * /search page can get there. Truncating is strictly better than the whole
 * reply failing to send.
 */
const MAX_REPLY_CHARS = 3800;

export function clip(text: string): string {
  return text.length <= MAX_REPLY_CHARS
    ? text
    : `${text.slice(0, MAX_REPLY_CHARS)}\n…(truncated)`;
}

export async function reply(
  adapter: BotAdapter,
  target: DeliveryTarget,
  rawText: string,
): Promise<MessageRef | null> {
  const text = clip(rawText);
  try {
    return await adapter.sendText(target, text);
  } catch (error) {
    logger.warn("Bot failed to send a message", {
      chatId: target.chatId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

export async function editAck(entry: PendingSubmission, rawText: string) {
  if (!entry.ack) {
    return;
  }
  try {
    await entry.adapter.editText(entry.ack, clip(rawText));
  } catch (error) {
    // Editing is best-effort: a rate-limited or already-identical edit must
    // never fail the submission itself.
    logger.debug("Bot failed to edit the acknowledgement", {
      chatId: entry.target.chatId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Builds a "keep updating one message" writer.
 *
 * Editing keeps a long-running command to a single message in the chat; if
 * the edit is rejected (deleted message, rate limit) it falls back to a new
 * one rather than losing the reply altogether.
 */
export function speaker(
  adapter: BotAdapter,
  target: DeliveryTarget,
  ack: MessageRef | null,
): (text: string) => Promise<void> {
  return async (text: string) => {
    if (ack) {
      try {
        await adapter.editText(ack, clip(text));
        return;
      } catch {
        // Fall through to a fresh message if the edit is rejected.
      }
    }
    await reply(adapter, target, text);
  };
}

export async function settle(
  rt: BotRuntime,
  entry: PendingSubmission,
  canonicalUrl: string,
  updates: Record<string, unknown>,
) {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  if (entry.watchdog !== null) {
    clearTimeout(entry.watchdog);
  }
  rt.pending.delete(canonicalUrl);

  try {
    await rt.deps.store.updateSubmission(entry.submissionId, updates);
  } catch (error) {
    logger.error("Failed to record submission outcome", {
      submissionId: entry.submissionId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function fail(
  rt: BotRuntime,
  entry: PendingSubmission,
  canonicalUrl: string,
  message: string,
) {
  // A listing failure arrives twice — once on the bus, once as the awaited
  // ListingResult. Whichever lands first reports it; re-editing with the same
  // text makes Telegram reject the edit as "message is not modified".
  if (entry.settled) {
    return;
  }
  await settle(rt, entry, canonicalUrl, {
    status: "failed",
    errorMessage: message,
  });
  await editAck(entry, message);
}
