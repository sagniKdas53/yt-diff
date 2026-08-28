import { NO_MONITORING } from "./commands.ts";
import { runPlaylistIndex } from "./indexing.ts";
import {
  deliverVideo,
  hasFileOnDisk,
  queuePositionFor,
  resolveIndexedVideo,
} from "./deliver.ts";
import { editAck, fail, reply, settle } from "./replies.ts";
import { formatBytes } from "./deliver.ts";
import {
  type BotRuntime,
  pendingCountForChat,
  type PendingSubmission,
} from "./runtime.ts";
import type { BotAdapter, DeliveryTarget, IncomingMessage } from "./types.ts";
import type { DeliveryMode, ListingResultLike } from "./runtime.ts";

/**
 * How long a submission may sit with no bus event before it is failed.
 *
 * Without this a submission hangs forever if the pipeline dies before emitting
 * a terminal event.
 */
const WATCHDOG_MS = 30 * 60 * 1000;

export function armWatchdog(
  rt: BotRuntime,
  canonicalUrl: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const entry = rt.pending.get(canonicalUrl);
    if (!entry || entry.settled) {
      return;
    }
    void fail(
      rt,
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
export async function handleSubmission(
  rt: BotRuntime,
  adapter: BotAdapter,
  message: IncomingMessage,
  rawUrl: string,
  mode: DeliveryMode,
) {
  const target: DeliveryTarget = {
    platform: adapter.platform,
    chatId: message.chatId,
  };

  if (pendingCountForChat(rt, message.chatId) >= rt.deps.maxPendingPerChat) {
    await reply(
      adapter,
      target,
      "You already have the maximum number of requests in flight. Wait for one to finish.",
    );
    return;
  }

  const canonicalUrl = rt.deps.normalizeUrl(rawUrl);

  // Checked before the submission row is opened, so a duplicate leaves no
  // half-finished row behind. A playlist is tracked in `listings`, not
  // `pending`, so both maps have to be consulted.
  if (rt.pending.has(canonicalUrl) || rt.listings.has(canonicalUrl)) {
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
  rt.pending.set(canonicalUrl, entry);

  const isPlaylist = rt.deps.isPlaylistUrl(canonicalUrl);

  let submission: { id: string };
  try {
    submission = await rt.deps.store.createSubmission({
      platform: adapter.platform,
      chatId: message.chatId,
      messageId: message.messageId,
      requestedUrl: rawUrl,
      kind: isPlaylist ? "playlist" : "video",
      retention: rt.deps.retentionMode,
    });
  } catch (error) {
    // Release the reservation, otherwise the URL is wedged until restart.
    rt.pending.delete(canonicalUrl);
    throw error;
  }
  entry.submissionId = submission.id;

  if (isPlaylist) {
    // Release the download reservation — runPlaylistIndex tracks its own
    // progress, and nothing here is going to emit a download event.
    rt.pending.delete(canonicalUrl);
    await runPlaylistIndex(rt, {
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
  const known = await resolveIndexedVideo(rt, canonicalUrl);
  if (known && await hasFileOnDisk(rt, known)) {
    if (mode === "store") {
      // Nothing to do: /download asked for it on the server, and it is.
      entry.ack = await reply(
        adapter,
        target,
        `Already downloaded: ${known.title}`,
      );
      await settle(rt, entry, canonicalUrl, {
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
    entry.watchdog = armWatchdog(rt, canonicalUrl);
    await rt.deps.store.updateSubmission(submission.id, {
      canonicalUrl: known.videoUrl,
      status: "downloading",
    });
    await deliverVideo(rt, entry, canonicalUrl, known, false);
    return;
  }

  // Tier 2: indexed but not downloaded — skip listing entirely.
  if (known) {
    entry.ack = await reply(adapter, target, "Queued for download…");
    entry.watchdog = armWatchdog(rt, canonicalUrl);
    await rt.deps.store.updateSubmission(submission.id, {
      canonicalUrl: known.videoUrl,
      status: "downloading",
    });
    entry.estimatedSize = known.approximateSize;
    await enqueue(rt, entry, canonicalUrl, known.videoUrl);
    return;
  }

  // Tier 3: unknown — index first.
  const listingQueueDepth = rt.deps.getListingQueueDepth();
  entry.ack = await reply(
    adapter,
    target,
    listingQueueDepth > 0
      ? `Indexing… (${listingQueueDepth} ahead in the listing queue)`
      : "Indexing…",
  );
  entry.watchdog = armWatchdog(rt, canonicalUrl);
  await rt.deps.store.updateSubmission(submission.id, { status: "indexing" });

  let results: ListingResultLike[];
  try {
    results = await rt.deps.listItemsConcurrently(
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
      rt.deps.chunkSize,
      false,
    );
  } catch (error) {
    await fail(
      rt,
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
      rt,
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
  const indexed = await resolveIndexedVideo(rt, canonicalUrl);
  if (!indexed) {
    await fail(
      rt,
      entry,
      canonicalUrl,
      "That link indexed but produced no video entry.",
    );
    return;
  }

  await rt.deps.store.updateSubmission(submission.id, {
    canonicalUrl: indexed.videoUrl,
    status: "downloading",
  });
  entry.estimatedSize = indexed.approximateSize;
  await enqueue(rt, entry, canonicalUrl, indexed.videoUrl);
}

export async function enqueue(
  rt: BotRuntime,
  entry: PendingSubmission,
  canonicalUrl: string,
  videoUrl: string,
) {
  let enqueued;
  try {
    enqueued = await rt.deps.resolveAndEnqueue([videoUrl], "None");
  } catch (error) {
    await fail(
      rt,
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
      rt,
      entry,
      canonicalUrl,
      "That link indexed but produced no video entry.",
    );
    return;
  }

  // Re-key the pending entry on the URL the pipeline will actually emit.
  if (videoUrl !== canonicalUrl) {
    rt.pending.delete(canonicalUrl);
    rt.pending.set(videoUrl, entry);
  }

  const fallback = enqueued.items[0]?.queuePosition ?? 1;
  const position = queuePositionFor(rt, videoUrl, fallback);
  const size = entry.estimatedSize;
  // Flag big files up front: they take a while and will very likely come back
  // as a link rather than an upload. Neither half applies to /download, which
  // uploads nothing and is expected to take as long as it takes.
  const warning = entry.mode === "store"
    ? "\nIt stays on the server; nothing will be sent here."
    : size > rt.deps.largeFileWarnBytes
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
