import type { AppEventBus } from "../events.ts";
import { logger } from "../logger.ts";
import { exists } from "../utils/fs.ts";
import { join } from "../utils/path.ts";
import { HELP_TEXT, NO_MONITORING, parseCommand } from "./commands.ts";
import type { Delivery } from "./delivery.ts";
import type { BotStore, VideoRecord } from "./store.ts";
import type {
  BotAdapter,
  DeliveryTarget,
  IncomingMessage,
  MessageRef,
} from "./types.ts";

/**
 * Progress is a heartbeat, not a progress bar.
 *
 * Small files finish in seconds, so reporting percentages immediately is pure
 * churn (and Telegram rate-limits edits aggressively). Nothing is said until a
 * download has been running for QUIET_MS, and only once per HEARTBEAT_MS after
 * that.
 */
const PROGRESS_QUIET_MS = 45_000;
const PROGRESS_HEARTBEAT_MS = 60_000;

/**
 * How long a submission may sit with no bus event before it is failed.
 *
 * Without this a submission hangs forever if the pipeline dies before emitting
 * a terminal event.
 */
const WATCHDOG_MS = 30 * 60 * 1000;

/**
 * How often a running playlist listing reports in.
 *
 * Listing a large playlist takes minutes and emits nothing else the user can
 * see, so unlike a download it says something straight away and keeps saying
 * it — silence here reads as a hung bot.
 */
const LISTING_HEARTBEAT_MS = 20_000;

/**
 * Longest reply the bot will send.
 *
 * Telegram rejects anything past 4096 characters outright, and a full /list or
 * /search page can get there. Truncating is strictly better than the whole
 * reply failing to send.
 */
const MAX_REPLY_CHARS = 3800;

export interface ListingResultLike {
  url: string;
  status: string;
  title?: string;
  error?: string;
}

export interface BotCoreDependencies {
  adapters: BotAdapter[];
  events: AppEventBus;
  delivery: Delivery;
  listItemsConcurrently: (
    items: {
      url: string;
      type: string;
      currentMonitoringType: string;
      reason: string;
    }[],
    chunkSize: number,
    isScheduledUpdate: boolean,
  ) => Promise<ListingResultLike[]>;
  resolveAndEnqueue: (
    urlList: string[],
    playlistUrl: string,
  ) => Promise<{
    items: { url: string; queuePosition: number }[];
    notIndexed: string[];
  }>;
  getQueueSnapshot: () => {
    url: string;
    title: string;
    status: string;
    queuePosition: number;
  }[];
  /** True listing backlog: in-flight plus queued. See getListingQueueDepth. */
  getListingQueueDepth: () => number;
  setPlaylistMonitoring: (url: string, monitoringType: string) => Promise<void>;
  store: BotStore;
  normalizeUrl: (url: string) => string;
  isPlaylistUrl: (url: string) => boolean;
  allowedChatIds: string[];
  maxPendingPerChat: number;
  retentionMode: "ephemeral" | "persistent";
  retentionHours: number;
  saveLocation: string;
  chunkSize: number;
  /** Warn the user when a queued item's estimate exceeds this many bytes. */
  largeFileWarnBytes: number;
}

/**
 * What the user wants done with the file once it exists.
 *
 * - "file"  upload it into the chat, falling back to a link when it is too big
 * - "link"  always answer with a signed URL  (/link)
 * - "store" leave it on the server and send nothing back  (/download)
 */
type DeliveryMode = "file" | "link" | "store";

/** In-flight state for one submission, keyed by canonical URL. */
interface PendingSubmission {
  submissionId: string;
  adapter: BotAdapter;
  target: DeliveryTarget;
  ack: MessageRef | null;
  mode: DeliveryMode;
  /** When the download actually started, for the quiet period. */
  startedAt: number;
  /** yt-dlp's size estimate in bytes, 0 when unknown. */
  estimatedSize: number;
  lastProgressAt: number;
  lastProgressText: string;
  watchdog: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/**
 * In-flight state for one playlist listing, keyed by canonical playlist URL.
 *
 * Deliberately not a `PendingSubmission`: a listing has no download to watch,
 * no watchdog and no file to deliver, and folding it into that map would make
 * every download-event handler check which kind of entry it just found.
 */
interface PendingListing {
  adapter: BotAdapter;
  target: DeliveryTarget;
  ack: MessageRef | null;
  lastProgressAt: number;
  lastProgressText: string;
}

export function createBotCore(deps: BotCoreDependencies) {
  const adaptersByPlatform = new Map(
    deps.adapters.map((adapter) => [adapter.platform, adapter]),
  );
  /** Canonical URL -> in-flight submission. */
  const pending = new Map<string, PendingSubmission>();
  /** Canonical playlist URL -> in-flight listing. */
  const listings = new Map<string, PendingListing>();

  function isAllowed(chatId: string): boolean {
    return deps.allowedChatIds.includes(chatId);
  }

  /** Downloads and playlist listings both count against the per-chat cap. */
  function pendingCountForChat(chatId: string): number {
    let count = 0;
    for (const entry of pending.values()) {
      if (entry.target.chatId === chatId) {
        count++;
      }
    }
    for (const entry of listings.values()) {
      if (entry.target.chatId === chatId) {
        count++;
      }
    }
    return count;
  }

  /** Keeps a reply inside the platform's message ceiling. */
  function clip(text: string): string {
    return text.length <= MAX_REPLY_CHARS
      ? text
      : `${text.slice(0, MAX_REPLY_CHARS)}\n…(truncated)`;
  }

  async function reply(
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

  async function editAck(entry: PendingSubmission, rawText: string) {
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
  function speaker(
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

  async function settle(
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
    pending.delete(canonicalUrl);

    try {
      await deps.store.updateSubmission(entry.submissionId, updates);
    } catch (error) {
      logger.error("Failed to record submission outcome", {
        submissionId: entry.submissionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async function fail(
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
    await settle(entry, canonicalUrl, {
      status: "failed",
      errorMessage: message,
    });
    await editAck(entry, message);
  }

  /**
   * Looks up the row listing actually produced for a URL.
   *
   * Listing stores yt-dlp's `webpage_url`, which can differ from
   * `normalizeUrl(input)`, so a direct hit is tried first and a videoId + host
   * match is the fallback.
   */
  async function resolveIndexedVideo(
    canonicalUrl: string,
  ): Promise<VideoRecord | null> {
    const direct = await deps.store.findVideoByUrl(canonicalUrl);
    if (direct) {
      return direct;
    }

    let host: string;
    let videoId: string | null;
    try {
      const parsed = new URL(canonicalUrl);
      host = parsed.hostname.replace(/^www\./, "");
      videoId = parsed.searchParams.get("v") ??
        parsed.pathname.split("/").filter(Boolean).pop() ?? null;
    } catch {
      return null;
    }

    if (!videoId) {
      return null;
    }

    const candidates = await deps.store.findVideosByVideoId(videoId);
    return candidates.find((candidate) => {
      try {
        return new URL(candidate.videoUrl).hostname.replace(/^www\./, "") ===
          host;
      } catch {
        return false;
      }
    }) ?? null;
  }

  /** True when the row claims a download and the media file is really there. */
  async function hasFileOnDisk(video: VideoRecord): Promise<boolean> {
    if (!video.downloadStatus || !video.fileName) {
      return false;
    }
    return await exists(
      join(deps.saveLocation, video.saveDirectory || "", video.fileName),
    );
  }

  /** Human-readable size, for warnings. */
  function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) {
      return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    }
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  function queuePositionFor(url: string, fallback: number): number {
    const snapshot = deps.getQueueSnapshot();
    return snapshot.find((entry) => entry.url === url)?.queuePosition ??
      fallback;
  }

  async function deliverVideo(
    entry: PendingSubmission,
    canonicalUrl: string,
    video: {
      title?: string | null;
      fileName?: string | null;
      saveDirectory?: string | null;
    },
    downloadedByBot: boolean,
  ) {
    if (!video.fileName) {
      await fail(
        entry,
        canonicalUrl,
        "Download finished but produced no file.",
      );
      return;
    }

    if (entry.mode === "store") {
      // /download puts the file in the library and stops there. It is recorded
      // as "downloaded" rather than "delivered", which is also what keeps the
      // reaper away from it: the reaper only ever looks at delivered
      // submissions, and expiresAt stays null to say the same thing twice.
      await settle(entry, canonicalUrl, {
        status: "downloaded",
        deliveryMode: "none",
        downloadedByBot,
        retention: "persistent",
        expiresAt: null,
      });
      await editAck(
        entry,
        `Downloaded: ${
          video.title || video.fileName
        }\nIt's on the server — /get sends it here.`,
      );
      return;
    }

    try {
      const outcome = await deps.delivery.deliver({
        adapter: entry.adapter,
        to: entry.target,
        saveDirectory: video.saveDirectory || "",
        fileName: video.fileName,
        caption: video.title || video.fileName,
        forceLink: entry.mode === "link",
      });

      // Only files the bot actually fetched are ever eligible for reaping, and
      // only when retention is ephemeral.
      const reapable = downloadedByBot &&
        deps.retentionMode === "ephemeral";

      await settle(entry, canonicalUrl, {
        status: "delivered",
        deliveryMode: outcome.mode,
        downloadedByBot,
        retention: deps.retentionMode,
        expiresAt: reapable
          ? new Date(Date.now() + deps.retentionHours * 3600 * 1000)
          : null,
      });

      if (outcome.mode === "signed_url") {
        // Always say why a link came back instead of a file. The pre-download
        // estimate is frequently unavailable (yt-dlp reports -1 for x.com), so
        // this measured size is the only reliable warning the user ever gets.
        const size = outcome.sizeBytes > 0
          ? formatBytes(outcome.sizeBytes)
          : "unknown size";
        const why = outcome.reason === "too_large"
          ? `That's ${size} — too big to upload here (limit ${
            formatBytes(entry.adapter.maxUploadBytes)
          }), so here's a download link instead.`
          : outcome.reason === "upload_failed"
          ? `Upload failed, so here's a download link instead (${size}).`
          : `Download link (${size}).`;
        await editAck(entry, `${why}\n${outcome.url}`);
      } else {
        await editAck(entry, video.title || "Done");
      }
    } catch (error) {
      await fail(
        entry,
        canonicalUrl,
        `Couldn't deliver that file: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  function armWatchdog(canonicalUrl: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = pending.get(canonicalUrl);
      if (!entry || entry.settled) {
        return;
      }
      void fail(
        entry,
        canonicalUrl,
        "Gave up waiting — the download never reported back.",
      );
    }, WATCHDOG_MS);
  }

  /**
   * Handles a link the user wants fetched.
   *
   * A playlist link never reaches the download tiers: listing one produces
   * hundreds of videos, so it is catalogued instead and the user pulls
   * individual entries out of it with /list and /get.
   */
  async function handleSubmission(
    adapter: BotAdapter,
    message: IncomingMessage,
    rawUrl: string,
    mode: DeliveryMode,
  ) {
    const target: DeliveryTarget = {
      platform: adapter.platform,
      chatId: message.chatId,
    };

    if (pendingCountForChat(message.chatId) >= deps.maxPendingPerChat) {
      await reply(
        adapter,
        target,
        "You already have the maximum number of requests in flight. Wait for one to finish.",
      );
      return;
    }

    const canonicalUrl = deps.normalizeUrl(rawUrl);

    // Checked before the submission row is opened, so a duplicate leaves no
    // half-finished row behind. A playlist is tracked in `listings`, not
    // `pending`, so both maps have to be consulted.
    if (pending.has(canonicalUrl) || listings.has(canonicalUrl)) {
      await reply(adapter, target, "That one is already in progress.");
      return;
    }

    // Reserve the slot synchronously. Everything below awaits, so two messages
    // arriving together would both clear the check above and double-queue the
    // same download (which also defeats the per-chat backpressure).
    const entry: PendingSubmission = {
      submissionId: "",
      adapter,
      target,
      ack: null,
      mode,
      startedAt: Date.now(),
      estimatedSize: 0,
      lastProgressAt: 0,
      lastProgressText: "",
      watchdog: null,
      settled: false,
    };
    pending.set(canonicalUrl, entry);

    const isPlaylist = deps.isPlaylistUrl(canonicalUrl);

    let submission: { id: string };
    try {
      submission = await deps.store.createSubmission({
        platform: adapter.platform,
        chatId: message.chatId,
        messageId: message.messageId,
        requestedUrl: rawUrl,
        kind: isPlaylist ? "playlist" : "video",
        retention: deps.retentionMode,
      });
    } catch (error) {
      // Release the reservation, otherwise the URL is wedged until restart.
      pending.delete(canonicalUrl);
      throw error;
    }
    entry.submissionId = submission.id;

    if (isPlaylist) {
      // Release the download reservation — runPlaylistIndex tracks its own
      // progress, and nothing here is going to emit a download event.
      pending.delete(canonicalUrl);
      await runPlaylistIndex({
        adapter,
        target,
        canonicalUrl,
        monitoringType: null,
        submissionId: submission.id,
      });
      return;
    }

    // Tier 1: already downloaded and the file is still on disk. No listing, no
    // download, no yt-dlp process — and downloadedByBot stays false so the
    // reaper never touches a file the bot did not fetch.
    const known = await resolveIndexedVideo(canonicalUrl);
    if (known && await hasFileOnDisk(known)) {
      if (mode === "store") {
        // Nothing to do: /download asked for it on the server, and it is.
        entry.ack = await reply(
          adapter,
          target,
          `Already downloaded: ${known.title}`,
        );
        await settle(entry, canonicalUrl, {
          canonicalUrl: known.videoUrl,
          status: "downloaded",
          deliveryMode: "none",
        });
        return;
      }
      entry.ack = await reply(
        adapter,
        target,
        "Already have that one, sending…",
      );
      entry.watchdog = armWatchdog(canonicalUrl);
      await deps.store.updateSubmission(submission.id, {
        canonicalUrl: known.videoUrl,
        status: "downloading",
      });
      await deliverVideo(entry, canonicalUrl, known, false);
      return;
    }

    // Tier 2: indexed but not downloaded — skip listing entirely.
    if (known) {
      entry.ack = await reply(adapter, target, "Queued for download…");
      entry.watchdog = armWatchdog(canonicalUrl);
      await deps.store.updateSubmission(submission.id, {
        canonicalUrl: known.videoUrl,
        status: "downloading",
      });
      entry.estimatedSize = known.approximateSize;
      await enqueue(entry, canonicalUrl, known.videoUrl);
      return;
    }

    // Tier 3: unknown — index first.
    const listingQueueDepth = deps.getListingQueueDepth();
    entry.ack = await reply(
      adapter,
      target,
      listingQueueDepth > 0
        ? `Indexing… (${listingQueueDepth} ahead in the listing queue)`
        : "Indexing…",
    );
    entry.watchdog = armWatchdog(canonicalUrl);
    await deps.store.updateSubmission(submission.id, { status: "indexing" });

    let results: ListingResultLike[];
    try {
      results = await deps.listItemsConcurrently(
        [{
          url: canonicalUrl,
          // executeListing decides playlist vs single item itself, including
          // the x.com exception, so "undetermined" is deliberate.
          type: "undetermined",
          // Nothing submitted for download is monitored. If executeListing does
          // classify this as a playlist after all, "N/A" is the watch mode the
          // web UI shows for one nobody is watching — "None" is the pseudo
          // playlist's URL, not a monitoring type, and storing it there leaves
          // the row with a watch mode the UI does not recognise.
          currentMonitoringType: NO_MONITORING,
          reason: "Chat bot submission",
        }],
        deps.chunkSize,
        false,
      );
    } catch (error) {
      await fail(
        entry,
        canonicalUrl,
        `Couldn't index that link: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return;
    }

    const result = results[0];
    if (
      !result || (result.status !== "completed" && result.status !== "success")
    ) {
      await fail(
        entry,
        canonicalUrl,
        `Couldn't index that link: ${
          result?.error ?? result?.status ?? "no result"
        }`,
      );
      return;
    }

    // Re-resolve: listing stores yt-dlp's webpage_url, which may differ from
    // the URL we canonicalised.
    const indexed = await resolveIndexedVideo(canonicalUrl);
    if (!indexed) {
      await fail(
        entry,
        canonicalUrl,
        "That link indexed but produced no video entry.",
      );
      return;
    }

    await deps.store.updateSubmission(submission.id, {
      canonicalUrl: indexed.videoUrl,
      status: "downloading",
    });
    entry.estimatedSize = indexed.approximateSize;
    await enqueue(entry, canonicalUrl, indexed.videoUrl);
  }

  async function enqueue(
    entry: PendingSubmission,
    canonicalUrl: string,
    videoUrl: string,
  ) {
    let enqueued;
    try {
      enqueued = await deps.resolveAndEnqueue([videoUrl], "None");
    } catch (error) {
      await fail(
        entry,
        canonicalUrl,
        `Couldn't queue that download: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return;
    }

    if (enqueued.notIndexed.length > 0) {
      await fail(
        entry,
        canonicalUrl,
        "That link indexed but produced no video entry.",
      );
      return;
    }

    // Re-key the pending entry on the URL the pipeline will actually emit.
    if (videoUrl !== canonicalUrl) {
      pending.delete(canonicalUrl);
      pending.set(videoUrl, entry);
    }

    const fallback = enqueued.items[0]?.queuePosition ?? 1;
    const position = queuePositionFor(videoUrl, fallback);
    const size = entry.estimatedSize;
    // Flag big files up front: they take a while and will very likely come back
    // as a link rather than an upload. Neither half applies to /download, which
    // uploads nothing and is expected to take as long as it takes.
    const warning = entry.mode === "store"
      ? "\nIt stays on the server; nothing will be sent here."
      : size > deps.largeFileWarnBytes
      ? `\nHeads up: this looks like ~${
        formatBytes(size)
      }, so it may take a while${
        size > entry.adapter.maxUploadBytes
          ? " and will arrive as a link rather than a file"
          : ""
      }.`
      : "";
    await editAck(
      entry,
      `Queued for download — position ${position}${warning}`,
    );
  }

  async function handleStatus(adapter: BotAdapter, target: DeliveryTarget) {
    const snapshot = deps.getQueueSnapshot();
    if (snapshot.length === 0) {
      await reply(adapter, target, "Queue is empty.");
      return;
    }
    const lines = snapshot.map((item) =>
      `${item.queuePosition}. ${item.title || item.url} — ${item.status}`
    );
    await reply(adapter, target, lines.join("\n"));
  }

  async function handleHistory(
    adapter: BotAdapter,
    target: DeliveryTarget,
    limit: number,
  ) {
    const rows = await deps.store.listSubmissions(target.chatId, limit);

    if (rows.length === 0) {
      await reply(adapter, target, "No submissions yet.");
      return;
    }

    const lines = rows.map((row) =>
      `${row.id.slice(0, 8)}  ${row.status}\n${
        row.canonicalUrl ?? row.requestedUrl
      }`
    );
    await reply(
      adapter,
      target,
      `${
        lines.join("\n\n")
      }\n\nThe code on each first line is the <id> for /keep and /rm.`,
    );
  }

  async function handleKeep(
    adapter: BotAdapter,
    target: DeliveryTarget,
    idPrefix: string,
  ) {
    const submission = await deps.store.findSubmissionByPrefix(
      target.chatId,
      idPrefix,
    );
    if (!submission) {
      await reply(adapter, target, "No single submission matches that id.");
      return;
    }
    await deps.store.updateSubmission(submission.id, {
      retention: "persistent",
      expiresAt: null,
    });
    await reply(
      adapter,
      target,
      "Kept — the reaper will leave that one alone.",
    );
  }

  async function handleRemove(
    adapter: BotAdapter,
    target: DeliveryTarget,
    idPrefix: string,
  ) {
    const submission = await deps.store.findSubmissionByPrefix(
      target.chatId,
      idPrefix,
    );
    if (!submission) {
      await reply(adapter, target, "No single submission matches that id.");
      return;
    }
    if (!submission.canonicalUrl) {
      await reply(adapter, target, "That submission has no file to remove.");
      return;
    }

    const purged = await deps.store.purgeVideoFiles(submission.canonicalUrl);
    if (!purged) {
      await reply(adapter, target, "Some files could not be removed.");
      return;
    }

    await deps.store.updateSubmission(submission.id, { status: "reaped" });
    await reply(adapter, target, "Removed.");
  }

  /**
   * Indexes a playlist, saying so while it runs.
   *
   * Listing a playlist can take minutes and emits nothing a chat user can see,
   * so this is the one command that reports progress from the first message
   * rather than after a quiet period — silence here reads as a hung bot.
   *
   * @param monitoringType - Start/End/Full to also schedule updates, or null to
   *                         index once and leave the watch mode at "N/A"
   * @param submissionId - Submission row to settle, when the caller opened one
   */
  async function runPlaylistIndex(opts: {
    adapter: BotAdapter;
    target: DeliveryTarget;
    canonicalUrl: string;
    monitoringType: string | null;
    submissionId: string | null;
  }): Promise<void> {
    const { adapter, target, canonicalUrl, monitoringType, submissionId } =
      opts;

    if (listings.has(canonicalUrl)) {
      await reply(adapter, target, "That playlist is already being indexed.");
      return;
    }

    const queueDepth = deps.getListingQueueDepth();
    const ahead = queueDepth > 0
      ? ` (${queueDepth} ahead in the listing queue)`
      : "";
    const ack = await reply(
      adapter,
      target,
      monitoringType
        ? `That's a playlist — indexing it and setting its watch mode to ${monitoringType}${ahead}. Nothing gets downloaded.`
        : `That's a playlist — indexing it${ahead}. Nothing gets downloaded; browse it with /list when it finishes.`,
    );
    const say = speaker(adapter, target, ack);

    listings.set(canonicalUrl, {
      adapter,
      target,
      ack,
      // 0, not now: the first chunk to land is the first concrete sign that
      // anything is happening, so it is reported immediately and only the
      // chunks after it are throttled.
      lastProgressAt: 0,
      lastProgressText: "",
    });

    if (submissionId) {
      await deps.store.updateSubmission(submissionId, {
        canonicalUrl,
        playlistUrl: canonicalUrl,
        status: "indexing",
      });
    }

    try {
      const results = await deps.listItemsConcurrently(
        [{
          url: canonicalUrl,
          type: "playlist",
          currentMonitoringType: monitoringType ?? NO_MONITORING,
          reason: "Chat bot playlist index",
        }],
        deps.chunkSize,
        false,
      );
      const result = results[0];
      const listed = result !== undefined &&
        (result.status === "completed" || result.status === "success");

      // A playlist that is already indexed at this watch mode lists nothing and
      // comes back as "No items found". That is not a failure worth reporting
      // as one when the playlist is sitting right there in the database, so the
      // row decides, not the listing result.
      const playlist = await deps.store.findPlaylistByUrl(canonicalUrl);
      if (!listed && !playlist) {
        const detail = result?.error ?? result?.status ?? "no result";
        if (submissionId) {
          await deps.store.updateSubmission(submissionId, {
            status: "failed",
            errorMessage: detail,
          });
        }
        await say(`Couldn't index that playlist: ${detail}`);
        return;
      }

      if (monitoringType) {
        try {
          await deps.setPlaylistMonitoring(canonicalUrl, monitoringType);
        } catch (error) {
          logger.warn("Bot failed to set playlist monitoring", {
            url: canonicalUrl,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      // Re-read: the count and title only exist once listing has written them,
      // and setPlaylistMonitoring may just have changed the watch mode.
      const summary = await deps.store.findPlaylistByUrl(canonicalUrl) ??
        playlist;
      const count = summary?.videoCount ?? 0;

      if (submissionId) {
        await deps.store.updateSubmission(submissionId, { status: "indexed" });
      }

      await say([
        `Indexed: ${summary?.title || "playlist"}`,
        `${count} ${count === 1 ? "entry" : "entries"} · watch mode: ${
          monitoringType ?? summary?.monitoringType ?? NO_MONITORING
        }`,
        "",
        `Browse it:  /list ${canonicalUrl}`,
        "Then /get <video-link> for anything you want downloaded.",
      ].join("\n"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      if (submissionId) {
        await deps.store.updateSubmission(submissionId, {
          status: "failed",
          errorMessage: detail,
        });
      }
      await say(`Couldn't index that playlist: ${detail}`);
    } finally {
      listings.delete(canonicalUrl);
    }
  }

  /**
   * Catalogues a link without downloading it.
   *
   * A playlist goes through runPlaylistIndex, with or without monitoring. A
   * single video is indexed into the "None" pseudo playlist — it becomes
   * searchable and can be fetched later with /get.
   */
  async function handleIndex(
    adapter: BotAdapter,
    target: DeliveryTarget,
    url: string,
    monitoringType: string | null,
  ) {
    const canonicalUrl = deps.normalizeUrl(url);
    // Asking for monitoring is itself a claim that the link is a playlist —
    // that is the only thing monitoring applies to — so it is honoured even
    // when the URL does not match the playlist pattern.
    if (deps.isPlaylistUrl(canonicalUrl) || monitoringType) {
      await runPlaylistIndex({
        adapter,
        target,
        canonicalUrl,
        monitoringType,
        submissionId: null,
      });
      return;
    }

    const ack = await reply(adapter, target, "Indexing…");
    const say = speaker(adapter, target, ack);

    try {
      const results = await deps.listItemsConcurrently(
        [{
          url: canonicalUrl,
          // Let executeListing classify it, including the x.com exception.
          type: "undetermined",
          currentMonitoringType: NO_MONITORING,
          reason: "Chat bot /index",
        }],
        deps.chunkSize,
        false,
      );
      const result = results[0];
      if (
        !result ||
        (result.status !== "completed" && result.status !== "success")
      ) {
        await say(
          `Couldn't index that link: ${
            result?.error ?? result?.status ?? "no result"
          }`,
        );
        return;
      }

      const indexed = await resolveIndexedVideo(canonicalUrl);
      await say(
        indexed
          ? `Indexed: ${indexed.title}\nUse /get to download it.`
          : "Indexed. Use /get to download it.",
      );
    } catch (error) {
      await say(
        `Couldn't index that link: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  /**
   * Shows one page of a playlist's entries, in playlist order.
   *
   * Indexing a playlist otherwise leaves the user with no way to see what it
   * produced from chat, which makes /get on an individual entry unusable.
   */
  async function handleList(
    adapter: BotAdapter,
    target: DeliveryTarget,
    url: string,
    start: number,
    limit: number,
  ) {
    const playlistUrl = deps.normalizeUrl(url);
    const playlist = await deps.store.findPlaylistByUrl(playlistUrl);
    if (!playlist) {
      await reply(
        adapter,
        target,
        `I haven't indexed that playlist. Send me the link, or /index it, first.`,
      );
      return;
    }

    const { total, items } = await deps.store.listPlaylistVideos(
      playlistUrl,
      start,
      limit,
    );

    if (items.length === 0) {
      await reply(
        adapter,
        target,
        total === 0
          ? `${playlist.title} has no entries yet.`
          : `Nothing at ${start} — ${playlist.title} has ${total} ${
            total === 1 ? "entry" : "entries"
          }, so start has to be below ${total}.`,
      );
      return;
    }

    const lines = items.map((item) =>
      `${item.position}. ${
        item.downloadStatus ? "[saved]" : "[not downloaded]"
      } ${item.title}\n${item.videoUrl}`
    );
    const shownTo = start + items.length;
    const more = shownTo < total
      ? `\n\nNext: /list ${playlistUrl} ${shownTo} ${limit}`
      : "";

    await reply(
      adapter,
      target,
      `${playlist.title} — showing ${
        start + 1
      }-${shownTo} of ${total} (watch: ${playlist.monitoringType})\n\n${
        lines.join("\n\n")
      }${more}`,
    );
  }

  /** Lists the playlists the bot knows about, so /list has a starting point. */
  async function handlePlaylists(
    adapter: BotAdapter,
    target: DeliveryTarget,
    limit: number,
  ) {
    const rows = await deps.store.listPlaylists(limit);
    if (rows.length === 0) {
      await reply(
        adapter,
        target,
        "No playlists indexed yet. Send me a playlist link to index one.",
      );
      return;
    }

    const lines = rows.map((row) =>
      `${row.title} — ${row.videoCount} ${
        row.videoCount === 1 ? "entry" : "entries"
      } (watch: ${row.monitoringType})\n${row.playlistUrl}`
    );
    await reply(
      adapter,
      target,
      `${
        lines.join("\n\n")
      }\n\nBrowse one with /list <playlist-link> [start] [count].`,
    );
  }

  async function handleSearch(
    adapter: BotAdapter,
    target: DeliveryTarget,
    query: string,
    limit: number,
  ) {
    const rows = await deps.store.searchVideos(query, limit);
    if (rows.length === 0) {
      await reply(adapter, target, `Nothing indexed matching "${query}".`);
      return;
    }

    const lines = rows.map((row) => {
      const mark = row.downloadStatus ? "[saved]" : "[not downloaded]";
      return `${mark} ${row.title}\n${row.videoUrl}`;
    });
    await reply(adapter, target, lines.join("\n\n"));
  }

  /**
   * Entry point for every incoming message.
   *
   * Messages from chats outside the allowlist are dropped silently — replying
   * would confirm the bot exists to anyone probing.
   */
  async function handleMessage(message: IncomingMessage): Promise<void> {
    if (!isAllowed(message.chatId)) {
      logger.debug("Ignoring message from a non-allowlisted chat", {
        platform: message.platform,
        chatId: message.chatId,
      });
      return;
    }

    const adapter = adaptersByPlatform.get(message.platform);
    if (!adapter) {
      return;
    }

    const target: DeliveryTarget = {
      platform: adapter.platform,
      chatId: message.chatId,
    };
    const command = parseCommand(message.text);

    try {
      switch (command.kind) {
        case "ignore":
          return;
        case "help":
          await reply(adapter, target, HELP_TEXT);
          return;
        case "status":
          await handleStatus(adapter, target);
          return;
        case "history":
          await handleHistory(adapter, target, command.limit);
          return;
        case "keep":
          await handleKeep(adapter, target, command.id);
          return;
        case "remove":
          await handleRemove(adapter, target, command.id);
          return;
        case "index":
          await handleIndex(
            adapter,
            target,
            command.url,
            command.monitoringType,
          );
          return;
        case "list":
          await handleList(
            adapter,
            target,
            command.url,
            command.start,
            command.limit,
          );
          return;
        case "playlists":
          await handlePlaylists(adapter, target, command.limit);
          return;
        case "search":
          await handleSearch(adapter, target, command.query, command.limit);
          return;
        case "get":
          await handleSubmission(adapter, message, command.url, "file");
          return;
        case "link":
          await handleSubmission(adapter, message, command.url, "link");
          return;
        case "download":
          await handleSubmission(adapter, message, command.url, "store");
          return;
        case "unknown":
          await reply(adapter, target, "I didn't understand that. Try /help.");
          return;
      }
    } catch (error) {
      logger.error("Bot failed to handle a message", {
        chatId: message.chatId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await reply(adapter, target, "Something went wrong handling that.");
    }
  }

  function onPercent(payload: { url: string; percentage: number }) {
    const entry = pending.get(payload.url);
    if (!entry || entry.settled || !entry.ack) {
      return;
    }

    // 101 is the pipeline's "started" sentinel, not a real percentage.
    if (payload.percentage > 100) {
      return;
    }

    const now = Date.now();
    // Stay quiet while the download is still plausibly about to finish.
    if (now - entry.startedAt < PROGRESS_QUIET_MS) {
      return;
    }
    if (now - entry.lastProgressAt < PROGRESS_HEARTBEAT_MS) {
      return;
    }

    const text = `Still downloading… ${Math.floor(payload.percentage)}%`;
    if (text === entry.lastProgressText) {
      return;
    }

    entry.lastProgressAt = now;
    entry.lastProgressText = text;
    void editAck(entry, text);
  }

  /**
   * Reports progress while a playlist is being listed.
   *
   * `processedChunks * chunkSize` is an upper bound on how far the listing has
   * read — the last chunk is usually partial — so the count is reported as
   * approximate rather than pretending to be exact.
   */
  function onListingChunk(payload: {
    url: string;
    processedChunks: number;
    playlistTitle: string;
  }) {
    const entry = listings.get(payload.url);
    if (!entry) {
      return;
    }

    const now = Date.now();
    if (now - entry.lastProgressAt < LISTING_HEARTBEAT_MS) {
      return;
    }

    const seen = payload.processedChunks * deps.chunkSize;
    const text = `Indexing ${
      payload.playlistTitle || "playlist"
    } — about ${seen} entries so far…`;
    if (text === entry.lastProgressText) {
      return;
    }

    entry.lastProgressAt = now;
    entry.lastProgressText = text;
    void speaker(entry.adapter, entry.target, entry.ack)(text);
  }

  function onStarted(payload: { url: string }) {
    const entry = pending.get(payload.url);
    if (entry && !entry.settled) {
      // Reset the clock: queue wait should not count toward the quiet period.
      entry.startedAt = Date.now();
    }
  }

  function onDone(payload: {
    url: string;
    title?: string | null;
    fileName?: string | null;
    saveDirectory?: string;
  }) {
    const entry = pending.get(payload.url);
    if (!entry || entry.settled) {
      return;
    }
    void deliverVideo(entry, payload.url, payload, true);
  }

  function onFailed(payload: { url: string; error?: string }) {
    const entry = pending.get(payload.url);
    if (!entry || entry.settled) {
      return;
    }
    void fail(
      entry,
      payload.url,
      `Download failed: ${payload.error ?? "unknown reason"}`,
    );
  }

  function onListingError(payload: { url: string; error: string }) {
    const entry = pending.get(payload.url);
    if (!entry || entry.settled) {
      return;
    }
    void fail(entry, payload.url, `Couldn't index that link: ${payload.error}`);
  }

  function subscribe() {
    deps.events.on("download-started", onStarted);
    deps.events.on("downloading-percent-update", onPercent);
    deps.events.on("download-done", onDone);
    deps.events.on("download-failed", onFailed);
    deps.events.on("listing-error", onListingError);
    deps.events.on("listing-playlist-chunk-complete", onListingChunk);
  }

  function unsubscribe() {
    deps.events.off("download-started", onStarted);
    deps.events.off("downloading-percent-update", onPercent);
    deps.events.off("download-done", onDone);
    deps.events.off("download-failed", onFailed);
    deps.events.off("listing-error", onListingError);
    deps.events.off("listing-playlist-chunk-complete", onListingChunk);
    listings.clear();
    for (const entry of pending.values()) {
      if (entry.watchdog !== null) {
        clearTimeout(entry.watchdog);
      }
    }
    pending.clear();
  }

  return { handleMessage, subscribe, unsubscribe };
}
