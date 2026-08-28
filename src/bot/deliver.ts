import { exists } from "../utils/fs.ts";
import { join } from "../utils/path.ts";
import type { VideoRecord } from "./store.ts";
import type { BotRuntime, PendingSubmission } from "./runtime.ts";
import { editAck, fail, settle } from "./replies.ts";

/**
 * Looks up the row listing actually produced for a URL.
 *
 * Listing stores yt-dlp's `webpage_url`, which can differ from
 * `normalizeUrl(input)`, so a direct hit is tried first and a videoId + host
 * match is the fallback.
 */
export async function resolveIndexedVideo(
  rt: BotRuntime,
  canonicalUrl: string,
): Promise<VideoRecord | null> {
  const direct = await rt.deps.store.findVideoByUrl(canonicalUrl);
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

  const candidates = await rt.deps.store.findVideosByVideoId(videoId);
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
export async function hasFileOnDisk(
  rt: BotRuntime,
  video: VideoRecord,
): Promise<boolean> {
  if (!video.downloadStatus || !video.fileName) {
    return false;
  }
  return await exists(
    join(rt.deps.saveLocation, video.saveDirectory || "", video.fileName),
  );
}

/** Human-readable size, for warnings. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function queuePositionFor(
  rt: BotRuntime,
  url: string,
  fallback: number,
): number {
  const snapshot = rt.deps.getQueueSnapshot();
  return snapshot.find((entry) => entry.url === url)?.queuePosition ??
    fallback;
}

export async function deliverVideo(
  rt: BotRuntime,
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
      rt,
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
    await settle(rt, entry, canonicalUrl, {
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
    const outcome = await rt.deps.delivery.deliver({
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
      rt.deps.retentionMode === "ephemeral";

    await settle(rt, entry, canonicalUrl, {
      status: "delivered",
      deliveryMode: outcome.mode,
      downloadedByBot,
      retention: rt.deps.retentionMode,
      expiresAt: reapable
        ? new Date(Date.now() + rt.deps.retentionHours * 3600 * 1000)
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
      rt,
      entry,
      canonicalUrl,
      `Couldn't deliver that file: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
