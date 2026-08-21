import { isHttpUrl } from "../utils/url.ts";
import type { BotCommand } from "./types.ts";

/**
 * Monitoring types accepted by /index, matching the web UI's vocabulary.
 *
 * Matching is case-insensitive and the canonical spelling here is what reaches
 * the pipeline, so `end`, `End` and `END` are all the same request. "N/A" is
 * included so an already-monitored playlist can be un-monitored from chat —
 * it is the same value a playlist gets when no mode is given.
 */
const MONITORING_TYPES = ["Start", "End", "Full", "N/A"];

/** What a playlist's monitoringType is set to when nothing is monitoring it. */
export const NO_MONITORING = "N/A";

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 25;

/** Parses an optional numeric argument, floored at 0. */
function clampNonNegative(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parses an optional numeric argument, kept in [1, max]. */
function clampPositive(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

/**
 * Parses an incoming message into a command.
 *
 * Telegram appends `@botname` to commands in group chats, which is stripped
 * here so group and direct chats behave identically.
 *
 * @param raw - Raw message text
 */
export function parseCommand(raw: string): BotCommand {
  const text = raw.trim();

  if (text.length === 0) {
    return { kind: "ignore" };
  }

  // A bare URL is the main path, so anything that parses as http(s) counts as
  // a submission even without a command prefix.
  if (!text.startsWith("/")) {
    return isHttpUrl(text) ? { kind: "get", url: text } : { kind: "ignore" };
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  // "/get@yt_diff_bot" -> "get"
  const command = rawCommand.slice(1).split("@")[0].toLowerCase();

  switch (command) {
    case "get":
    case "link":
    case "download": {
      const url = args[0];
      if (!url || !isHttpUrl(url)) {
        return { kind: "unknown", text };
      }
      if (command === "get") {
        return { kind: "get", url };
      }
      return command === "link"
        ? { kind: "link", url }
        : { kind: "download", url };
    }

    case "index": {
      const url = args[0];
      if (!url || !isHttpUrl(url)) {
        return { kind: "unknown", text };
      }
      // No mode means a plain index into the "None" pseudo-playlist: catalogue
      // it, do not download it, do not monitor it.
      const requested = args[1];
      if (!requested) {
        return { kind: "index", url, monitoringType: null };
      }
      const monitoringType = MONITORING_TYPES.find(
        (type) => type.toLowerCase() === requested.toLowerCase(),
      );
      if (!monitoringType) {
        return { kind: "unknown", text };
      }
      // "N/A" is spelled out only to be explicit; it means the same thing as
      // omitting the mode, so it collapses to the same command.
      return {
        kind: "index",
        url,
        monitoringType: monitoringType === NO_MONITORING
          ? null
          : monitoringType,
      };
    }

    case "list": {
      const url = args[0];
      // A bare /list is the index of playlists — without it the only way to
      // browse one is to already know its URL.
      if (!url) {
        return { kind: "playlists", limit: DEFAULT_LIST_LIMIT };
      }
      if (!isHttpUrl(url)) {
        return { kind: "unknown", text };
      }
      const start = clampNonNegative(args[1], 0);
      const limit = clampPositive(args[2], DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      return { kind: "list", url, start, limit };
    }

    case "search": {
      const query = args.join(" ").trim();
      if (!query) {
        return { kind: "unknown", text };
      }
      return { kind: "search", query, limit: DEFAULT_SEARCH_LIMIT };
    }

    case "keep":
    case "rm": {
      const id = args[0];
      if (!id) {
        return { kind: "unknown", text };
      }
      return command === "keep" ? { kind: "keep", id } : { kind: "remove", id };
    }

    case "status":
      return { kind: "status" };

    case "history": {
      const parsed = Number.parseInt(args[0] ?? "", 10);
      const limit = Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;
      return { kind: "history", limit };
    }

    case "help":
    case "start":
      return { kind: "help" };

    default:
      return { kind: "unknown", text };
  }
}

export const HELP_TEXT = [
  "Send me a link and I'll download the video and send the file back.",
  "If it's too big to upload, you get a download link instead.",
  "A playlist link is indexed instead of downloaded — nothing is fetched",
  "until you ask for it.",
  "",
  "GET A VIDEO",
  "<link>          download it and send the file  (just paste a link)",
  "/get <link>     same thing, spelled out",
  "/link <link>    send me a download link instead of the file itself —",
  "                useful for big files, or to save the upload wait",
  "/download <link>  download it to the server but don't send it back",
  "",
  "BROWSE WHAT'S STORED",
  "/search <text>  find videos already indexed, by title or link",
  "/list           the playlists I know about",
  "/list <playlist-link> [start] [count]   entries in one playlist,",
  "                starting at [start] (default 0), [count] at a time",
  "                (default 10, max 25)",
  "/history [n]    your recent requests (default 10)",
  "/status         what's downloading right now",
  "",
  "INDEX WITHOUT DOWNLOADING",
  "/index <link>   catalogue it so it's searchable, but don't download",
  "/index <playlist-link> Start|End|Full   also keep it updated",
  "                Start = watch for new items at the top",
  "                End   = watch for new items at the bottom",
  "                Full  = re-scan everything (slowest)",
  "                N/A   = stop watching it",
  "                (case doesn't matter — 'end' works too)",
  "",
  "MANAGE FILES",
  "/keep <id>      stop this file being auto-deleted later",
  "/rm <id>        delete this file now",
  "",
  "The <id> is the short code at the start of each /history line.",
].join("\n");
