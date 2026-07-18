/**
 * Shared types for the yt-diff bot core library.
 * Used by platform adapters (Discord, Telegram) to communicate with yt-diff.
 */

/** What the bot receives from a platform */
export interface BotIncomingMessage {
  text: string;
  senderId: string;
  chatId: string;
  platform: "discord" | "telegram";
}

/** URL extracted from a message, with its canonical form */
export interface ParsedUrl {
  original: string;
  canonical: string;
  site: "youtube" | "x.com" | "other";
  isShorts: boolean;
  isValidVideo: boolean;
  reason?: string;
}

/** Result of looking up a URL in the yt-diff database */
export interface VideoLookupResult {
  found: boolean;
  indexed: boolean;
  downloaded: boolean;
  title?: string;
  fileName?: string;
  fileSizeBytes?: number;
  fileExists: boolean;
  needsListing: boolean;
  needsDownload: boolean;
}

/** What the bot sends back to the platform */
export interface BotOutgoingMessage {
  chatId: string;
  text?: string;
  file?: {
    path: string;
    mimeType: string;
    sizeBytes: number;
    fileName: string;
  };
  signedUrl?: {
    url: string;
    expiryUnix: number;
    fileName: string;
    mimeType: string;
  };
  error?: string;
}

/** Bot configuration */
export interface BotConfig {
  mode: "ephemeral" | "persistent";
  ephemeralTtlHours: number;
  ytdiffApiBase: string;
  ytdiffAuthToken: string;
  maxDirectFileSize: number;
  signedUrlTtlSeconds: number;
}
