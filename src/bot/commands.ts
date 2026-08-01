import type { BotCommand } from "./types.ts";

/** Monitoring types accepted by /watch, matching the web UI's vocabulary. */
const MONITORING_TYPES = ["Start", "End", "Full"];

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;

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

    case "keep":
    case "rm": {
      const id = args[0];
      if (!id) {
        return { kind: "unknown", text };
      }
      return command === "keep" ? { kind: "keep", id } : { kind: "remove", id };
    }

    case "watch": {
      const url = args[0];
      if (!url || !looksLikeUrl(url)) {
        return { kind: "unknown", text };
      }
      // Default to Full: a /watch with no mode should track the whole feed
      // rather than silently monitoring one end of it.
      const requested = args[1];
      const monitoringType = MONITORING_TYPES.find(
        (type) => type.toLowerCase() === requested?.toLowerCase(),
      ) ?? (requested ? null : "Full");

      if (!monitoringType) {
        return { kind: "unknown", text };
      }
      return { kind: "watch", url, monitoringType };
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
  "Send me a link and I'll fetch the video and send it back.",
  "",
  "<url>            index, download, deliver",
  "/get <url>       same as sending a bare link",
  "/link <url>      always reply with a link, never upload",
  "/watch <url> [Start|End|Full]   monitor a playlist",
  "/keep <id>       keep an ephemeral file from being reaped",
  "/rm <id>         delete a submission's files now",
  "/status          what the queue is doing",
  "/history [n]     recent submissions",
  "/help            this message",
].join("\n");
