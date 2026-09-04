import { config } from "../../config.ts";
import { logger } from "../../logger.ts";
import { appendUrlArg } from "../../utils/url.ts";
import type {
  ManagedProcess,
  SiteArgBuilder,
  SpawnPythonProcess,
} from "./types.ts";

/** What one launch adds on top of the shared preamble. */
export interface YtDlpLaunchSpec {
  /** The URL being worked on. Always lands last, behind a literal `--`. */
  url: string;
  /** yt-dlp flags for this particular job, placed ahead of the URL. */
  flags: string[];
  /**
   * Options that must precede everything else, such as the download profile.
   * Kept separate from `flags` only because that is where they sit in the
   * argv today; yt-dlp does not care about the order.
   */
  options?: string[];
  /** What the debug line says this launch is for. */
  reason: string;
  /** Extra fields for the debug line. */
  context?: Record<string, unknown>;
}

/** Stands in for anything that must not reach a log. */
const REDACTED = "<redacted>";

/**
 * Flags whose argument is a secret outright.
 *
 * `--netrc-cmd` is here because the command it names is usually a password
 * manager invocation carrying its own arguments.
 */
const SECRET_VALUE_FLAGS = new Set([
  "--username",
  "--password",
  "--twofactor",
  "--video-password",
  "--ap-username",
  "--ap-password",
  "--netrc-cmd",
]);

/** Flags whose argument is a URL that may carry `user:pass@` in front of it. */
const CREDENTIALED_URL_FLAGS = new Set([
  "--proxy",
  "--geo-verification-proxy",
]);

/**
 * Strips `user:pass@` from a URL, keeping everything that aids debugging.
 *
 * Deliberately a regex and not `new URL()`: a malformed proxy string is
 * exactly the case you want the log line for, and throwing here would lose it.
 */
function redactUrlUserinfo(value: string): string {
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i,
    `$1${REDACTED}@`,
  );
}

/**
 * Replaces credential arguments with a placeholder, leaving the rest intact.
 *
 * The point is to keep the log line diagnostic. Which flags were passed, in
 * what order, against which URL and which proxy host — all of that is what the
 * line is read for, and all of it survives. Only the values that authenticate
 * are dropped.
 *
 * Both `--password x` and `--password=x` are handled. Only the first form is
 * produced today, but the argv is assembled in three places and a log that
 * leaks on a spelling nobody thought about is the failure mode being closed.
 */
export function redactSecretArgs(args: string[]): string[] {
  const redacted: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);

    if (SECRET_VALUE_FLAGS.has(flag)) {
      if (separator !== -1) {
        redacted.push(`${flag}=${REDACTED}`);
        continue;
      }
      redacted.push(arg);
      // A trailing flag with no value is malformed, not a leak; leave it.
      if (index + 1 < args.length) {
        redacted.push(REDACTED);
        index++;
      }
      continue;
    }

    if (CREDENTIALED_URL_FLAGS.has(flag)) {
      if (separator !== -1) {
        redacted.push(`${flag}=${redactUrlUserinfo(arg.slice(separator + 1))}`);
        continue;
      }
      redacted.push(arg);
      if (index + 1 < args.length) {
        redacted.push(redactUrlUserinfo(args[index + 1]));
        index++;
      }
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}

/**
 * Renders an argv the way a person would have to type it, minus the secrets.
 *
 * Only for logs. Arguments containing whitespace are quoted, which the
 * download path's own version did not do — so a save path with a space in it
 * used to log as a command that would not run if pasted.
 *
 * Credentials are removed on the way through. Every yt-dlp launch logs this
 * string at debug level, and for iwara that argv carries `--username`,
 * `--password` and a `--proxy` URL with its own `user:pass@` — so before this,
 * two live passwords were written to the container log on every single listing
 * and download, and travelled onward in any log anyone was asked to look at.
 * The consequence is that the rendered line is no longer runnable as-is for
 * those flags, which is the intended trade.
 */
function renderCommand(args: string[]): string {
  return [
    "yt-dlp",
    ...redactSecretArgs(args).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)),
  ].join(" ");
}

/**
 * The one place a `yt-dlp` subprocess is started.
 *
 * Three call sites — the listing stream, the playlist-title probe, and the
 * downloader — each built the same argv by hand: append the URL, prepend the
 * per-site arguments, render a command string for the log, spawn. They agreed
 * on the shape but not on the details, which is exactly the failure mode the
 * `--` separator was added for: a builder that forgets a step is not visibly
 * different from one that does not.
 *
 * `appendUrlArg` is what puts the URL behind `--`, so option parsing is closed
 * before the URL is reached and a stored URL beginning with `-` cannot become
 * a flag. Routing every spawn through here is what keeps that true for the
 * next call site as well as these three.
 */
export function createYtDlpLauncher(deps: {
  buildSiteArgs: SiteArgBuilder;
  spawnPythonProcess: SpawnPythonProcess;
}) {
  const { buildSiteArgs, spawnPythonProcess } = deps;

  return function launchYtDlp(
    { url, flags, options = [], reason, context = {} }: YtDlpLaunchSpec,
  ): { process: ManagedProcess; args: string[] } {
    const args = appendUrlArg([...buildSiteArgs(url, config), ...flags], url);
    const fullArgs = options.length > 0 ? [...options, ...args] : args;

    logger.debug(reason, {
      ...context,
      url,
      fullCommand: renderCommand(fullArgs),
    });

    return { process: spawnPythonProcess(fullArgs), args: fullArgs };
  };
}

export type YtDlpLauncher = ReturnType<typeof createYtDlpLauncher>;
