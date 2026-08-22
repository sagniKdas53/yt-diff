/**
 * The one place a URL is judged, named and reduced to canonical form.
 *
 * Three concerns live here because they are the same concern seen from
 * different sides, and splitting them is what let them drift before:
 *
 * - **Admissibility** (`isHttpUrl`, `toHttpUrl`, `appendUrlArg`). Every URL
 *   that ends up in a `yt-dlp` argv clears this bar first. The check used to
 *   live in `bot/commands.ts` and guarded the chat path alone, while the HTTP
 *   path accepted any string — including ones starting with `-`, which
 *   yt-dlp's option parser reads as a flag rather than as a URL.
 * - **Host identity** (`isHostOrSubdomain` and the `isSite*` predicates).
 * - **Canonical form** (`normalizeUrl`, `canonicalizePlaylistUrl`). The
 *   ingest path writes `normalizeUrl`'s output as the `videoUrl` primary key
 *   and the dedup path groups by it. When these were two implementations in
 *   two files they disagreed, so the deduplicator computed canonical forms the
 *   writer would never produce.
 */
import { logger } from "../logger.ts";

/**
 * True when `text` parses as a URL carrying an http(s) scheme.
 *
 * Anything that fails to parse — or that parses as `file:`, `data:` and
 * friends — is rejected. That also rules out the `--config-location=…` shaped
 * strings that would otherwise reach yt-dlp as positional arguments.
 */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when a hostname is worth handing to yt-dlp.
 *
 * Only used on the scheme-less path, to tell `youtube.com/watch?v=…` (a URL a
 * person pasted without typing the scheme) from `notaurl` (a typo). A dot, the
 * literal `localhost`, or a bracketed IPv6 literal is the same bar a browser
 * omnibox applies.
 */
function isPlausibleHost(hostname: string): boolean {
  return hostname.length > 0 &&
    (hostname.includes(".") || hostname === "localhost" ||
      hostname.startsWith("["));
}

/**
 * Normalizes submitted text into a serialized http(s) URL, or returns null.
 *
 * People paste `youtube.com/watch?v=…` far more often than they type the
 * scheme, and yt-dlp accepts that across its ~2,500 supported sites, so
 * demanding an explicit scheme would be a usability regression for no security
 * gain. What C1 actually needs is the *output* invariant: whatever comes back
 * from here is a URL serialization beginning with `http://` or `https://`, so
 * it can never be read as an option no matter which argv it lands in.
 *
 * Rejected: anything starting with `-`, any other scheme (`file:`, `data:`,
 * `javascript:`), and yt-dlp's own non-URL prefix forms (`ytsearch:`,
 * `:ytfav`, `gvsearch:` and the ~20 others). Those last ones are deliberate —
 * this app keys playlists by URL, and the account-scoped ones (`:ytfav`,
 * `:ytsubs`, `:ythistory`) would read the operator's cookies on behalf of
 * whoever submitted them.
 *
 * The bot path keeps the stricter `isHttpUrl` instead: in a chat stream a bare
 * word has to stay chatter rather than silently become a submission.
 */
export function toHttpUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // An argv element must never begin with a hyphen. This is also what stops
  // `--config-location=/tmp/x` from being laundered by the scheme-prefixing
  // branch below, where it would otherwise parse with `--config-location=` as
  // its hostname.
  if (trimmed.startsWith("-")) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // Falls through: no scheme at all.
  }

  // A parse that succeeded with some other protocol still lands here, because
  // `example.com:8443/v` parses as scheme `example.com:` rather than as a
  // host and a port. Prefixing sorts the two apart — a real scheme like
  // `file:` ends up as a dot-less hostname and fails isPlausibleHost, while
  // `ytsearch:cats` fails to parse at all because `cats` is not a port.
  try {
    const parsed = new URL(`https://${trimmed}`);
    if (parsed.protocol === "https:" && isPlausibleHost(parsed.hostname)) {
      return parsed.href;
    }
  } catch {
    // Not recoverable as a URL.
  }

  return null;
}

/**
 * Appends `url` to a `yt-dlp` argv behind a literal `--` terminator.
 *
 * `--` closes option parsing, so everything after it is positional no matter
 * what it starts with. Without it a URL beginning with `-` is read as a flag —
 * `--config-location=…` being the worst of them, since yt-dlp will then load
 * arbitrary options from disk. Every argv the pipeline builds ends with a call
 * to this, so the terminator cannot be forgotten at a new call site.
 *
 * @param options - Argv built so far; option parsing still applies to these.
 * @param url - The positional URL, appended after the terminator.
 */
export function appendUrlArg(options: string[], url: string): string[] {
  return [...options, "--", url];
}

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

/**
 * True when `hostname` is exactly `domain` or a subdomain of it.
 *
 * The one host matcher for the whole tree. Five hand-rolled copies of this
 * comparison used to exist — two of them byte-identical, one declared two
 * functions below an existing copy — and each carried its own decision about
 * whether an unparseable URL logs, throws or silently misses. Matching on
 * `hostname` rather than on the raw string is what keeps `evil-x.com` from
 * passing as `x.com`.
 */
export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Hostname of `url`, lowercased, or `""` when it does not parse.
 *
 * Every site predicate below funnels through this, so "not a URL" is one
 * behaviour rather than four.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when `url` points at x.com or a subdomain of it. */
export function isSiteXDotCom(url: string): boolean {
  return isHostOrSubdomain(hostnameOf(url), "x.com");
}

/** True when `url` points at iwara.tv or a subdomain of it. */
export function isSiteIwaraDotTv(url: string): boolean {
  return isHostOrSubdomain(hostnameOf(url), "iwara.tv");
}

/**
 * True when `url` points at YouTube.
 *
 * Used to decide whether to attach cookies for private playlists (Watch Later,
 * Liked Videos) that the YouTube Data API cannot reach.
 */
export function isSiteYouTube(url: string): boolean {
  const hostname = hostnameOf(url);
  return isHostOrSubdomain(hostname, "youtube.com") ||
    isHostOrSubdomain(hostname, "youtu.be");
}

/**
 * True for sites that hand out signed thumbnail URLs which expire quickly.
 *
 * Persisting one of those as stable metadata just stores a link that will be
 * dead by the time anybody clicks it.
 */
export function hasEphemeralThumbnails(url: string): boolean {
  const hostname = hostnameOf(url);
  return ["facebook.com", "instagram.com", "pornhub.com"].some((domain) =>
    isHostOrSubdomain(hostname, domain)
  );
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Tracking parameters stripped from every URL, whatever the site.
 *
 * `normalizeUrl`'s docstring has promised this since the registry was written,
 * but the step was never implemented — grepping the tree for these names
 * returned the comment and nothing else. Because `normalizeUrl`'s output *is*
 * the `videoUrl` primary key, the same video shared with different `?si=` or
 * `utm_*` values became a distinct row on every site without a rule below.
 */
const TRACKING_PARAMS = new Set(["fbclid", "si", "pp"]);

/** Prefixes whose whole family is tracking noise (`utm_source`, `utm_medium`, …). */
const TRACKING_PARAM_PREFIXES = ["utm_"];

/**
 * Deletes tracking parameters from `url` in place.
 *
 * Collected before deleting because `URLSearchParams` iteration and mutation
 * do not mix.
 */
function stripTrackingParams(url: URL): void {
  const doomed = [...url.searchParams.keys()].filter((key) => {
    const lower = key.toLowerCase();
    return TRACKING_PARAMS.has(lower) ||
      TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
  for (const key of doomed) {
    url.searchParams.delete(key);
  }
}

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

/** YouTube video ID pattern (11 chars, base64url alphabet). */
const YT_VIDEO_ID_RE = /[A-Za-z0-9_-]{11}/;

/**
 * Extract a YouTube video ID from various URL forms:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://youtu.be/ID
 *   - https://m.youtube.com/watch?v=ID
 */
function extractYouTubeVideoId(url: URL): string | null {
  // youtu.be/{id}
  if (isHostOrSubdomain(url.hostname, "youtu.be")) {
    const id = url.pathname.slice(1).split("/")[0];
    if (YT_VIDEO_ID_RE.test(id)) return id;
    return null;
  }
  // watch?v=ID
  const v = url.searchParams.get("v");
  if (v && YT_VIDEO_ID_RE.test(v)) return v;
  // /shorts/ID  or  /embed/ID
  const shortMatch = url.pathname.match(
    /\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/,
  );
  if (shortMatch) return shortMatch[1];
  return null;
}

/**
 * The site rules, in match order.
 *
 * This registry is the single canonical form for a URL: the ingest path writes
 * its output as the `videoUrl` primary key and the dedup path groups by it, so
 * a rule added here changes both at once. It used to be two registries — this
 * one, and an if/else chain in `dedup.ts` covering the same sites — and they
 * disagreed: dedup *appended* `?s=20` to x.com URLs, a canonical form ingest
 * would never write, while the pornhub and xhamster rules existed only there,
 * beside a commented-out placeholder here saying "add pornhub".
 */
const SITE_CANONICALIZERS: SiteCanonicalizer[] = [
  // -------------------------------------------------------------------------
  // YouTube
  // -------------------------------------------------------------------------
  {
    name: "youtube",
    match: (h) =>
      isHostOrSubdomain(h, "youtube.com") ||
      isHostOrSubdomain(h, "youtu.be") ||
      isHostOrSubdomain(h, "youtube-nocookie.com"),
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
    match: (h) => isHostOrSubdomain(h, "iwara.tv"),
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
    match: (h) => isHostOrSubdomain(h, "spankbang.com"),
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
  // pornhub.com — the viewkey is the whole identity; everything else is
  // navigation state (pkey=, from=, channel ordering).
  // -------------------------------------------------------------------------
  {
    name: "pornhub",
    match: (h) => isHostOrSubdomain(h, "pornhub.com"),
    canonicalize: (url) => {
      const viewkey = url.searchParams.get("viewkey");
      url.search = "";
      if (viewkey) url.searchParams.set("viewkey", viewkey);
      return url.toString();
    },
  },
  // -------------------------------------------------------------------------
  // xhamster.com — the path identifies the video; the query never does.
  // -------------------------------------------------------------------------
  {
    name: "xhamster",
    match: (h) => isHostOrSubdomain(h, "xhamster.com"),
    canonicalize: (url) => {
      url.search = "";
      return url.toString();
    },
  },
  // -------------------------------------------------------------------------
  // x.com / twitter.com — the share sheet appends `?s=20&t=<token>`, which is
  // per-share and not part of the post's identity. dedup.ts used to *add*
  // `?s=20` here, canonicalizing towards a form the ingest path never wrote;
  // stripping is the direction that makes the two paths agree.
  // -------------------------------------------------------------------------
  {
    name: "x",
    match: (h) =>
      isHostOrSubdomain(h, "x.com") || isHostOrSubdomain(h, "twitter.com"),
    canonicalize: (url) => {
      url.searchParams.delete("s");
      url.searchParams.delete("t");
      return url.toString();
    },
  },
];

/**
 * Canonicalizes a URL to a stable primary-key form:
 *   1. Forces https:// protocol
 *   2. Removes trailing slashes from pathname
 *   3. Strips known tracking query parameters (utm_*, fbclid, si, pp)
 *   4. Applies the first matching SiteCanonicalizer (if any)
 *
 * Unknown sites receive only the generic transformations above.
 *
 * The output *is* the `videoUrl` primary key, so changing what this returns
 * changes which rows are considered the same video. Existing rows written
 * before a rule landed keep their old spelling until `/dedup` runs — which is
 * safe now that dedup groups by this same function rather than by its own.
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

  // 3. Strip tracking parameters
  stripTrackingParams(parsed);

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

/**
 * Canonicalizes a *playlist* URL to a stable primary-key form.
 *
 * Separate from `normalizeUrl` because the two answer different questions
 * about the same host: `normalizeUrl` reduces a YouTube URL to the video it
 * points at, while a playlist URL's identity is the `list=` id and the video
 * that happened to be playing is the noise. Everything below the site switch —
 * https, trailing slash, tracking params — is shared.
 */
export function canonicalizePlaylistUrl(urlStr: string): string {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return urlStr;
  }

  url.protocol = "https:";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  stripTrackingParams(url);

  const hostname = url.hostname.toLowerCase();

  if (
    isHostOrSubdomain(hostname, "youtube.com") ||
    isHostOrSubdomain(hostname, "youtu.be")
  ) {
    url.hostname = "www.youtube.com";
    const list = url.searchParams.get("list");
    if (list) {
      url.pathname = "/playlist";
      url.search = `?list=${list}`;
    } else if (url.pathname === "/playlist") {
      url.search = "";
    }
  } else if (isHostOrSubdomain(hostname, "iwara.tv")) {
    url.searchParams.delete("sort");
    url.searchParams.delete("page");
  } else if (isHostOrSubdomain(hostname, "spankbang.com")) {
    url.searchParams.delete("o");
    url.searchParams.delete("p");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[1] === "playlist") {
      let pid = parts[0];
      if (pid.endsWith("-nohrcs")) pid = pid.replace("-nohrcs", "");
      url.pathname = `/${pid}/playlist`;
    }
  } else if (isHostOrSubdomain(hostname, "xhamster.com")) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "creators") {
      url.pathname = `/creators/${parts[1]}`;
    }
  } else if (
    isHostOrSubdomain(hostname, "x.com") ||
    isHostOrSubdomain(hostname, "twitter.com")
  ) {
    // Same share-sheet params as the video rule, same reason.
    url.searchParams.delete("s");
    url.searchParams.delete("t");
  }

  return url.toString();
}
