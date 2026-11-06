import { coreHostname } from "../pipeline/dedup.ts";

/** Longest value stored in any facet column. */
const MAX_LENGTH = 255;
/** Leaves room for the `auto:` prefix inside a 255-character playlistUrl. */
const MAX_KEY_LENGTH = 250;

export interface VideoFacets {
  site: string; // hostname, lowercased, without www. or m.
  siteName: string; // extractor_key, else site. For labels only.
  channelKey: string | null; // "<site>:<lowercased id>"
  channelName: string | null; // channel, else uploader, else uploader_id
  channelUrl: string | null; // channel_url, else uploader_url
  channelHandle: string | null; // uploader_id, lowercased, without a leading @
  uploadDate: string | null; // "YYYY-MM-DD" from upload_date "YYYYMMDD"
  durationSeconds: number | null;
}

/**
 * A usable string from stored metadata, or null. yt-dlp writes "NA" for
 * fields it couldn't fill, and some extractors leave empty strings.
 */
function text(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "NA") return null;
  return trimmed.slice(0, MAX_LENGTH);
}

function stripAt(value: string): string {
  return value.replace(/^@/, "");
}

function parseUploadDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  // Round-trip through Date so 20240230 is rejected instead of rolling over.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function parseDuration(value: unknown): number | null {
  const n = typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Site, channel and length for a video, from metadata already stored.
 *
 * The site is the hostname rather than `extractor_key`: 844 Unlisted rows have
 * no extractor_key, so using it would split one site into two groups.
 */
export function deriveFacets(
  raw: Record<string, unknown> | null,
  videoUrl: string,
): VideoFacets {
  const site = coreHostname(videoUrl) || "unknown";
  const meta = raw ?? {};

  // Id order: a stable id beats a display name, which beats a free-text one.
  const id = text(meta.channel_id) ?? text(meta.uploader_id) ??
    text(meta.uploader_url) ?? text(meta.uploader) ?? text(meta.channel);
  const channelKey = id === null
    ? null
    : `${site}:${stripAt(id).toLowerCase()}`.slice(0, MAX_KEY_LENGTH);

  const handle = text(meta.uploader_id);

  return {
    site,
    siteName: text(meta.extractor_key) ?? site,
    channelKey,
    channelName: text(meta.channel) ?? text(meta.uploader) ?? handle,
    channelUrl: text(meta.channel_url) ?? text(meta.uploader_url),
    channelHandle: handle === null ? null : stripAt(handle).toLowerCase(),
    uploadDate: parseUploadDate(meta.upload_date),
    durationSeconds: parseDuration(meta.duration),
  };
}
