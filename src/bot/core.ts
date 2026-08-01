import type { AppEventBus } from "../events.ts";
import { logger } from "../logger.ts";
import { exists } from "../utils/fs.ts";
import { join } from "../utils/path.ts";
import { HELP_TEXT, parseCommand } from "./commands.ts";
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
  listProcesses: Map<string, unknown>;
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

/** In-flight state for one submission, keyed by canonical URL. */
interface PendingSubmission {
  submissionId: string;
  adapter: BotAdapter;
  target: DeliveryTarget;
  ack: MessageRef | null;
  forceLink: boolean;
  /** When the download actually started, for the quiet period. */
  startedAt: number;
  /** yt-dlp's size estimate in bytes, 0 when unknown. */
  estimatedSize: number;
  lastProgressAt: number;
  lastProgressText: string;
  watchdog: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export function createBotCore(deps: BotCoreDependencies) {
  const adaptersByPlatform = new Map(
    deps.adapters.map((adapter) => [adapter.platform, adapter]),
  );
  /** Canonical URL -> in-flight submission. */
  const pending = new Map<string, PendingSubmission>();

  function isAllowed(chatId: string): boolean {
    return deps.allowedChatIds.includes(chatId);
  }

  function pendingCountForChat(chatId: string): number {
    let count = 0;
    for (const entry of pending.values()) {
      if (entry.target.chatId === chatId) {
        count++;
      }
    }
    return count;
  }

  async function reply(
    adapter: BotAdapter,
    target: DeliveryTarget,
    text: string,
  ): Promise<MessageRef | null> {
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

  async function editAck(entry: PendingSubmission, text: string) {
    if (!entry.ack) {
      return;
    }
    try {
      await entry.adapter.editText(entry.ack, text);
    } catch (error) {
      // Editing is best-effort: a rate-limited or already-identical edit must
      // never fail the submission itself.
      logger.debug("Bot failed to edit the acknowledgement", {
        chatId: entry.target.chatId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
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

    try {
      const outcome = await deps.delivery.deliver({
        adapter: entry.adapter,
        to: entry.target,
        saveDirectory: video.saveDirectory || "",
        fileName: video.fileName,
        caption: video.title || video.fileName,
        forceLink: entry.forceLink,
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
        await editAck(entry, `Ready: ${outcome.url}`);
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

  async function handleSubmission(
    adapter: BotAdapter,
    message: IncomingMessage,
    rawUrl: string,
    forceLink: boolean,
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

    if (pending.has(canonicalUrl)) {
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
      forceLink,
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

    // Tier 1: already downloaded and the file is still on disk. No listing, no
    // download, no yt-dlp process — and downloadedByBot stays false so the
    // reaper never touches a file the bot did not fetch.
    const known = await resolveIndexedVideo(canonicalUrl);
    if (known && await hasFileOnDisk(known)) {
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
    const listingQueueDepth = deps.listProcesses.size;
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
          currentMonitoringType: "None",
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
    // as a link rather than an upload.
    const warning = size > deps.largeFileWarnBytes
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
   * Catalogues a link without downloading it.
   *
   * With no monitoring type this is a plain index into the "None" pseudo
   * playlist — the item becomes searchable and can be fetched later with /get.
   * With Start/End/Full it is also registered for scheduled updates.
   */
  async function handleIndex(
    adapter: BotAdapter,
    target: DeliveryTarget,
    url: string,
    monitoringType: string | null,
  ) {
    const canonicalUrl = deps.normalizeUrl(url);
    const isPlaylist = deps.isPlaylistUrl(canonicalUrl);
    const ack = await reply(
      adapter,
      target,
      monitoringType ? "Indexing and setting up monitoring…" : "Indexing…",
    );

    const say = async (text: string) => {
      if (ack) {
        try {
          await adapter.editText(ack, text);
          return;
        } catch {
          // Fall through to a fresh message if the edit is rejected.
        }
      }
      await reply(adapter, target, text);
    };

    try {
      const results = await deps.listItemsConcurrently(
        [{
          url: canonicalUrl,
          // Let executeListing classify unless the user asked for monitoring,
          // which only makes sense for a playlist.
          type: monitoringType ? "playlist" : "undetermined",
          currentMonitoringType: monitoringType ?? "None",
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

      if (monitoringType) {
        await deps.setPlaylistMonitoring(canonicalUrl, monitoringType);
        await say(
          `Indexed, and now monitoring it (${monitoringType}).`,
        );
        return;
      }

      const indexed = isPlaylist
        ? null
        : await resolveIndexedVideo(canonicalUrl);
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
        case "search":
          await handleSearch(adapter, target, command.query, command.limit);
          return;
        case "get":
          await handleSubmission(adapter, message, command.url, false);
          return;
        case "link":
          await handleSubmission(adapter, message, command.url, true);
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
  }

  function unsubscribe() {
    deps.events.off("download-started", onStarted);
    deps.events.off("downloading-percent-update", onPercent);
    deps.events.off("download-done", onDone);
    deps.events.off("download-failed", onFailed);
    deps.events.off("listing-error", onListingError);
    for (const entry of pending.values()) {
      if (entry.watchdog !== null) {
        clearTimeout(entry.watchdog);
      }
    }
    pending.clear();
  }

  return { handleMessage, subscribe, unsubscribe };
}
