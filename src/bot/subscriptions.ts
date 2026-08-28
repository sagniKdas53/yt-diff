import { deliverVideo } from "./deliver.ts";
import { editAck, fail, speaker } from "./replies.ts";
import type { BotRuntime } from "./runtime.ts";

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
 * How often a running playlist listing reports in.
 *
 * Listing a large playlist takes minutes and emits nothing else the user can
 * see, so unlike a download it says something straight away and keeps saying
 * it — silence here reads as a hung bot.
 */
const LISTING_HEARTBEAT_MS = 20_000;

export function onPercent(
  rt: BotRuntime,
  payload: { url: string; percentage: number },
) {
  const entry = rt.pending.get(payload.url);
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
export function onListingChunk(
  rt: BotRuntime,
  payload: {
    url: string;
    processedChunks: number;
    playlistTitle: string;
  },
) {
  const entry = rt.listings.get(payload.url);
  if (!entry) {
    return;
  }

  const now = Date.now();
  if (now - entry.lastProgressAt < LISTING_HEARTBEAT_MS) {
    return;
  }

  const seen = payload.processedChunks * rt.deps.chunkSize;
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

export function onStarted(
  rt: BotRuntime,
  payload: { url: string },
) {
  const entry = rt.pending.get(payload.url);
  if (entry && !entry.settled) {
    // Reset the clock: queue wait should not count toward the quiet period.
    entry.startedAt = Date.now();
  }
}

export function onDone(
  rt: BotRuntime,
  payload: {
    url: string;
    title?: string | null;
    fileName?: string | null;
    saveDirectory?: string;
  },
) {
  const entry = rt.pending.get(payload.url);
  if (!entry || entry.settled) {
    return;
  }
  void deliverVideo(rt, entry, payload.url, payload, true);
}

export function onFailed(
  rt: BotRuntime,
  payload: { url: string; error?: string },
) {
  const entry = rt.pending.get(payload.url);
  if (!entry || entry.settled) {
    return;
  }
  void fail(
    rt,
    entry,
    payload.url,
    `Download failed: ${payload.error ?? "unknown reason"}`,
  );
}

export function onListingError(
  rt: BotRuntime,
  payload: { url: string; error: string },
) {
  const entry = rt.pending.get(payload.url);
  if (!entry || entry.settled) {
    return;
  }
  void fail(
    rt,
    entry,
    payload.url,
    `Couldn't index that link: ${payload.error}`,
  );
}

/**
 * Binds the handlers above to one runtime and manages their registration.
 *
 * The listeners have to be bound once and kept: `events.off` removes by
 * function identity, so re-wrapping them at unsubscribe time would leave every
 * listener attached and the bot answering events after it had been told to
 * stop. That identity is the only thing this closure holds — the handlers
 * themselves are plain exports above, callable with a runtime and nothing
 * else.
 */
export function createSubscriptions(rt: BotRuntime) {
  // Payload types come from the handlers themselves, so a bus payload that
  // changes shape is an error here rather than a silently mistyped listener.
  const listeners = {
    started: (payload: Parameters<typeof onStarted>[1]) =>
      onStarted(rt, payload),
    percent: (payload: Parameters<typeof onPercent>[1]) =>
      onPercent(rt, payload),
    done: (payload: Parameters<typeof onDone>[1]) => onDone(rt, payload),
    failed: (payload: Parameters<typeof onFailed>[1]) => onFailed(rt, payload),
    listingError: (payload: Parameters<typeof onListingError>[1]) =>
      onListingError(rt, payload),
    listingChunk: (payload: Parameters<typeof onListingChunk>[1]) =>
      onListingChunk(rt, payload),
  };

  function subscribe() {
    rt.deps.events.on("download-started", listeners.started);
    rt.deps.events.on("downloading-percent-update", listeners.percent);
    rt.deps.events.on("download-done", listeners.done);
    rt.deps.events.on("download-failed", listeners.failed);
    rt.deps.events.on("listing-error", listeners.listingError);
    rt.deps.events.on(
      "listing-playlist-chunk-complete",
      listeners.listingChunk,
    );
  }

  function unsubscribe() {
    rt.deps.events.off("download-started", listeners.started);
    rt.deps.events.off("downloading-percent-update", listeners.percent);
    rt.deps.events.off("download-done", listeners.done);
    rt.deps.events.off("download-failed", listeners.failed);
    rt.deps.events.off("listing-error", listeners.listingError);
    rt.deps.events.off(
      "listing-playlist-chunk-complete",
      listeners.listingChunk,
    );
    rt.listings.clear();
    for (const entry of rt.pending.values()) {
      if (entry.watchdog !== null) {
        clearTimeout(entry.watchdog);
      }
    }
    rt.pending.clear();
  }

  return { subscribe, unsubscribe };
}
