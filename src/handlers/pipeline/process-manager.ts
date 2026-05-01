import { config } from "../../config.ts";
import { logger } from "../../logger.ts";
import type { ProcessLike, DownloadProcessEntry, ListingProcessEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Site canonicalizer registry
// ---------------------------------------------------------------------------

/**
 * A site-specific URL canonicalization rule.
 * Add new entries to SITE_CANONICALIZERS to extend normalization support.
 */
interface SiteCanonicalizer {
  /** Human-readable name for logging/debugging */
  name: string;
  /** Return true if this rule should be applied to the given hostname */
  match: (hostname: string) => boolean;
  /**
   * Canonicalize the URL. Receives a mutable URL object (already protocol-
   * normalized, trailing-slash stripped, and tracking-param cleaned).
   * Returns the final canonical URL string.
   */
  canonicalize: (url: URL) => string;
}

/** Tracking/noise query parameters stripped from all URLs before site rules. */
const STRIP_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "si", "pp",
]);

/** YouTube video ID pattern (11 chars, base64url alphabet). */
const YT_VIDEO_ID_RE = /[A-Za-z0-9_-]{11}/;

/**
 * Extract a YouTube video ID from various URL forms:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://youtu.be/ID
 *   - https://m.youtube.com/watch?v=ID
 */
function extractYouTubeVideoId(url: URL): string | null {
  // youtu.be/{id}
  if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    if (YT_VIDEO_ID_RE.test(id)) return id;
    return null;
  }
  // watch?v=ID
  const v = url.searchParams.get("v");
  if (v && YT_VIDEO_ID_RE.test(v)) return v;
  // /shorts/ID  or  /embed/ID
  const shortMatch = url.pathname.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  return null;
}

const SITE_CANONICALIZERS: SiteCanonicalizer[] = [
  // -------------------------------------------------------------------------
  // YouTube
  // -------------------------------------------------------------------------
  {
    name: "youtube",
    match: (h) => [
      "youtube.com", "www.youtube.com", "m.youtube.com", "www.m.youtube.com",
      "youtu.be", "www.youtu.be",
      "youtube-nocookie.com", "www.youtube-nocookie.com",
    ].includes(h),
    canonicalize: (url) => {
      const videoId = extractYouTubeVideoId(url);
      if (videoId) {
        // It's a video URL — rebuild to the single canonical form.
        // Drop all query params (list=, start_radio=, index=, etc.) except the ID.
        return `https://www.youtube.com/watch?v=${videoId}`;
      }

      // Not a video URL (playlist, channel, etc.) — use www.youtube.com host,
      // and append /videos to channel handles as before.
      url.hostname = "www.youtube.com";
      url.protocol = "https:";
      const path = url.pathname;
      if (path.includes("/@") && !/\/videos\/?$/.test(path)) {
        url.pathname = path.replace(/\/$/, "") + "/videos";
      }
      return url.toString();
    },
  },

  // -------------------------------------------------------------------------
  // iwara.tv — strip optional trailing slug: /video/{id}/{slug} → /video/{id}
  // -------------------------------------------------------------------------
  {
    name: "iwara",
    match: (h) => h === "iwara.tv" || h.endsWith(".iwara.tv"),
    canonicalize: (url) => {
      const m = url.pathname.match(/^(\/video\/[A-Za-z0-9]+)/);
      if (m) {
        url.pathname = m[1];
        url.search = "";
      }
      return url.toString();
    },
  },
  // -------------------------------------------------------------------------
  // spankbang.com — strip title slug: /{id}/video/{slug} → /{id}/video
  // -------------------------------------------------------------------------
  {
    name: "spankbang",
    match: (h) => h === "spankbang.com" || h.endsWith(".spankbang.com"),
    canonicalize: (url) => {
      const m = url.pathname.match(/^(\/[A-Za-z0-9]+\/video)/);
      if (m) {
        url.pathname = m[1];
        url.search = "";
      }
      return url.toString();
    },
  },

  // -------------------------------------------------------------------------
  // Add more site rules here as needed, e.g.:
  //
  // {
  //   name: "pornhub",
  //   match: (h) => h === "pornhub.com" || h.endsWith(".pornhub.com"),
  //   canonicalize: (url) => { ... return url.toString(); },
  // },
  // -------------------------------------------------------------------------
];

// ---------------------------------------------------------------------------
// Main normalizeUrl()
// ---------------------------------------------------------------------------

/**
 * Canonicalizes a URL to a stable primary-key form:
 *   1. Forces https:// protocol
 *   2. Removes trailing slashes from pathname
 *   3. Strips known tracking query parameters (utm_*, fbclid, si, pp)
 *   4. Applies the first matching SiteCanonicalizer (if any)
 *
 * Unknown sites receive only the generic transformations above.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    logger.warn(`normalizeUrl: invalid URL, returning as-is: ${url}`, {
      error: (e as Error).message,
    });
    return url;
  }

  // 1. Force https
  parsed.protocol = "https:";

  // 2. Remove trailing slash from pathname (unless it's the root "/")
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  // 3. Strip generic tracking params
  for (const param of STRIP_PARAMS) {
    parsed.searchParams.delete(param);
  }

  // 4. Apply site-specific canonicalizer
  const rule = SITE_CANONICALIZERS.find((r) => r.match(parsed.hostname));
  if (rule) {
    const result = rule.canonicalize(parsed);
    logger.debug(`normalizeUrl [${rule.name}]: ${url} → ${result}`);
    return result;
  }

  const result = parsed.toString();
  if (result !== url) {
    logger.debug(`normalizeUrl [generic]: ${url} → ${result}`);
  }
  return result;
}

export function urlToTitle(url: string) {
  try {
    const pathSegments = new URL(url).pathname.split("/");
    const unwantedSegments = new Set(["videos", "channel", "user", "playlist"]);
    const titleSegments = pathSegments.filter((segment) =>
      segment && !unwantedSegments.has(segment.toLowerCase())
    );
    return titleSegments.join("_") || url;
  } catch (error) {
    logger.error("Failed to generate title from URL", {
      url,
      error: (error as Error).message,
    });
    return url;
  }
}

export function truncateText(text: string, maxLength: number) {
  if (!text || typeof text !== "string") {
    logger.warn("Invalid text provided for truncation", {
      text,
      type: typeof text,
    });
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  const truncated = text.slice(0, maxLength);
  logger.debug(
    `Truncated text from ${text.length} to ${truncated.length} characters`,
  );
  return truncated;
}

export function isSiteXDotCom(videoUrl: string): boolean {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${videoUrl}`, {
      error: (e as Error).message,
    });
  }
  const allowedXHost = "x.com";
  // Only match x.com or its subdomains, not unrelated hostnames that merely
  // contain the string.
  return hostname === allowedXHost || hostname.endsWith("." + allowedXHost);
}

export function hasEphemeralThumbnails(videoUrl: string): boolean {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch {
    return false;
  }
  // These sites commonly return signed thumbnail URLs that expire quickly, so
  // we avoid persisting them as stable metadata.
  const ephemeralHosts = ["facebook.com", "instagram.com", "pornhub.com"];
  return ephemeralHosts.some((h) => hostname === h || hostname.endsWith("." + h));
}

export function getProcessStates(processMap: Map<string, ProcessLike>) {
  const states: Record<string, { status: string; type: string; lastActive: number }> = {};
  for (const [processId, process] of processMap.entries()) {
    states[processId] = {
      status: process.status,
      type: process.spawnType,
      lastActive: process.lastActivity,
    };
  }
  return JSON.stringify(states);
}

export function cleanupStaleProcesses(
  processMap: Map<string, ProcessLike>,
  {
    maxIdleTime = config.queue.maxIdle,
    maxLifetime = config.queue.maxLifetime,
    forceKill = false,
  } = {},
  processType: string,
) {
  const now = Date.now();
  let cleanedCount = 0;

  logger.info(
    `Cleaning up processes older than ${
      maxIdleTime / 1000
    } seconds in ${processType} processes`,
  );
  logger.trace("Current process states:", {
    states: getProcessStates(processMap),
  });

  for (const [processId, process] of processMap.entries()) {
    const {
      status,
      lastActivity,
      lastStdoutActivity,
      spawnTimeStamp,
      spawnedProcess,
    } = process;

    const age = now - spawnTimeStamp;
    const idleTime = now - lastActivity;
    const stdoutIdleTime = lastStdoutActivity ? now - lastStdoutActivity : age;
    const isErrorOnly = lastStdoutActivity &&
      (lastActivity > lastStdoutActivity) && (stdoutIdleTime > maxIdleTime);

    if (status === "completed" || status === "failed") {
      processMap.delete(processId);
      cleanedCount++;
      continue;
    }

    if (
      status === "running" &&
      (idleTime > maxIdleTime || age > maxLifetime || isErrorOnly)
    ) {
      const isActivelyProducingData = lastStdoutActivity &&
        (now - lastStdoutActivity < maxIdleTime);
      if (
        processType === "list" && isActivelyProducingData &&
        !(idleTime > maxIdleTime) && !isErrorOnly
      ) {
        logger.info(
          `Skipping cleanup for active list process ${processId} (age: ${Math.round(age / 1000)}s, last stdout: ${Math.round((now - lastStdoutActivity) / 1000)}s ago)`,
        );
        continue;
      }

      if (spawnedProcess?.kill && forceKill) {
        try {
          const killed = spawnedProcess.kill("SIGKILL");
          if (!killed) {
            const terminated = spawnedProcess.kill("SIGTERM");
            if (!terminated) {
              throw new Error("Failed to terminate process");
            }
          }
        } catch (error) {
          logger.error(`Failed to kill process ${processId}`, {
            error: (error as Error).message,
          });
        }
      }

      processMap.delete(processId);
      cleanedCount++;
    }
  }

  logger.info(`Cleaned up ${cleanedCount} processes`);
  logger.trace("Updated process states:", {
    states: getProcessStates(processMap),
  });

  return cleanedCount;
}

export function createProcessManager(
  downloadProcesses: Map<string, DownloadProcessEntry>,
  listProcesses: Map<string, ListingProcessEntry>
) {
  function updateProcessActivity(processKey: string, isStdout = false) {
    const downloadEntry = downloadProcesses.get(processKey);
    if (downloadEntry) {
      const now = Date.now();
      downloadEntry.lastActivity = now;
      if (isStdout) {
        downloadEntry.lastStdoutActivity = now;
      }
    }

    const listEntry = listProcesses.get(processKey);
    if (listEntry) {
      const now = Date.now();
      listEntry.lastActivity = now;
      if (isStdout) {
        listEntry.lastStdoutActivity = now;
      }
    }
  }

  function cleanupProcess(processKey: string, pid: number | undefined) {
    if (downloadProcesses.has(processKey)) {
      downloadProcesses.delete(processKey);
      logger.trace(`Removed process from cache: ${pid}`, { pid });
      logger.trace(`Process map state: ${getProcessStates(downloadProcesses)}`);
      logger.trace(`Process map size: ${downloadProcesses.size}`);
    }
  }

  return { updateProcessActivity, cleanupProcess };
}
