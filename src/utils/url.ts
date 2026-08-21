/**
 * Shared URL safety helpers.
 *
 * Every URL that ends up in a `yt-dlp` argv has to clear this bar first. The
 * check used to live in `bot/commands.ts` and guarded the chat path alone,
 * while the HTTP path accepted any string — including ones starting with `-`,
 * which yt-dlp's option parser reads as a flag rather than as a URL.
 */

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
