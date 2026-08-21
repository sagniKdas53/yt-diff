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
