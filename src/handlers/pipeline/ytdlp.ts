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

/**
 * Renders an argv the way a person would have to type it.
 *
 * Only for logs. Arguments containing whitespace are quoted, which the
 * download path's own version did not do — so a save path with a space in it
 * used to log as a command that would not run if pasted.
 */
function renderCommand(args: string[]): string {
  return ["yt-dlp", ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))]
    .join(" ");
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
