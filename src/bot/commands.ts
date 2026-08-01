import type { BotCommand } from "./types.ts";

/** Monitoring types accepted by /index, matching the web UI's vocabulary. */
const MONITORING_TYPES = ["Start", "End", "Full"];

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * A bare URL is the main path, so anything that parses as http(s) counts as a
 * submission even without a command prefix.
 */
function looksLikeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

  if (!text.startsWith("/")) {
    return looksLikeUrl(text) ? { kind: "get", url: text } : { kind: "ignore" };
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  // "/get@yt_diff_bot" -> "get"
  const command = rawCommand.slice(1).split("@")[0].toLowerCase();

  switch (command) {
    case "get":
    case "link": {
      const url = args[0];
      if (!url || !looksLikeUrl(url)) {
        return { kind: "unknown", text };
      }
      return command === "get" ? { kind: "get", url } : { kind: "link", url };
    }

    case "index": {
      const url = args[0];
      if (!url || !looksLikeUrl(url)) {
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
      return { kind: "index", url, monitoringType };
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
  "",
  "GET A VIDEO",
  "<link>          download it and send the file  (just paste a link)",
  "/get <link>     same thing, spelled out",
  "/link <link>    send me a download link instead of the file itself —",
  "                useful for big files, or to save the upload wait",
  "",
  "BROWSE WHAT'S STORED",
  "/search <text>  find videos already indexed, by title or link",
  "/history [n]    your recent requests (default 10)",
  "/status         what's downloading right now",
  "",
  "INDEX WITHOUT DOWNLOADING",
  "/index <link>   catalogue it so it's searchable, but don't download",
  "/index <playlist-link> Start|End|Full   also keep it updated",
  "                Start = watch for new items at the top",
  "                End   = watch for new items at the bottom",
  "                Full  = re-scan everything (slowest)",
  "",
  "MANAGE FILES",
  "/keep <id>      stop this file being auto-deleted later",
  "/rm <id>        delete this file now",
  "",
  "The <id> is the short code at the start of each /history line.",
].join("\n");
