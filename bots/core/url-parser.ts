/**
 * URL parser for bot messages.
 * Extracts URLs from chat messages, detects the site (YouTube, x.com, other),
 * canonicalizes video URLs, and rejects playlists/channels.
 *
 * YouTube video URL canonicalization mirrors the backend's
 * SITE_CANONICALIZERS in `src/handlers/pipeline/process-manager.ts`.
 */

import type { ParsedUrl } from "./types.ts";

const YT_SHORTS_RE = /\/shorts\//;
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_RE = /[?&]list=|playlist\?list=/;
const X_STATUS_RE = /\/status\/\d+/;

/**
 * Extract and parse a URL from a raw chat message.
 * Returns null if no valid single-video URL was found.
 * Returns a ParsedUrl with isValidVideo=false if the URL is a playlist/channel.
 */
export function parseUrl(raw: string): ParsedUrl | null {
  const trimmed = raw.trim();

  // Extract URL from message text
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return null;

  const original = urlMatch[0];
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return {
      original,
      canonical: original,
      site: "other",
      isShorts: false,
      isValidVideo: false,
      reason: "Invalid URL",
    };
  }

  const host = url.hostname.replace(/^www\./, "");

  // ── YouTube ─────────────────────────────────────────────────────
  if (
    ["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"]
      .includes(host)
  ) {
    const isShorts = YT_SHORTS_RE.test(url.pathname);
    const isPlaylist = PLAYLIST_RE.test(url.search) ||
      /\/playlist/.test(url.pathname) ||
      /\/@/.test(url.pathname); // channel handles are not single videos

    if (isPlaylist) {
      return {
        original,
        canonical: original,
        site: "youtube",
        isShorts: false,
        isValidVideo: false,
        reason:
          "Playlists and channels are not supported — send a single video URL",
      };
    }

    // Canonicalize: extract video ID, rebuild as watch?v=ID
    let videoId: string | null = null;

    // watch?v=ID
    const v = url.searchParams.get("v");
    if (v && YT_VIDEO_ID_RE.test(v)) videoId = v;

    // /shorts/ID or /embed/ID
    if (!videoId) {
      const match = url.pathname.match(
        /\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/,
      );
      if (match) videoId = match[1];
    }

    // youtu.be/ID
    if (!videoId && (host === "youtu.be" || host === "www.youtu.be")) {
      const id = url.pathname.slice(1).split("/")[0];
      if (YT_VIDEO_ID_RE.test(id)) videoId = id;
    }

    if (!videoId) {
      return {
        original,
        canonical: original,
        site: "youtube",
        isShorts,
        isValidVideo: false,
        reason: "Could not extract a video ID from this URL",
      };
    }

    const canonical = `https://www.youtube.com/watch?v=${videoId}`;
    return { original, canonical, site: "youtube", isShorts, isValidVideo: true };
  }

  // ── x.com / Twitter ─────────────────────────────────────────────
  if (["x.com", "twitter.com"].includes(host)) {
    const isStatus = X_STATUS_RE.test(url.pathname);
    return {
      original,
      canonical: original,
      site: "x.com",
      isShorts: false,
      isValidVideo: isStatus,
      reason: isStatus
        ? undefined
        : "x.com URLs must be status/post links (e.g. x.com/user/status/123)",
    };
  }

  // ── Other sites (yt-dlp supports hundreds) ───────────────────────
  return {
    original,
    canonical: original,
    site: "other",
    isShorts: false,
    isValidVideo: true,
  };
}
