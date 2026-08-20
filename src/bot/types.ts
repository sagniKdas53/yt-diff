/**
 * Platform-agnostic contracts for the chat bot.
 *
 * `BotCore` holds every command, dedupe and dispatch decision; an adapter only
 * translates between a chat platform's SDK and these types. If a second
 * platform ever needs `BotCore` to change, the seam is in the wrong place.
 */

export type BotPlatform = "telegram" | "discord";

/** Where a reply should go. */
export interface DeliveryTarget {
  platform: BotPlatform;
  chatId: string;
}

/** Handle to a sent message, so it can be edited in place as work progresses. */
export interface MessageRef {
  platform: BotPlatform;
  chatId: string;
  messageId: string;
}

/** A message the bot received, already normalised across platforms. */
export interface IncomingMessage {
  platform: BotPlatform;
  chatId: string;
  messageId: string;
  /** Raw message text, trimmed. */
  text: string;
}

export interface BotAdapter {
  readonly platform: BotPlatform;
  /**
   * Largest file this platform will accept as an upload. Anything larger is
   * delivered as a signed URL instead.
   */
  readonly maxUploadBytes: number;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendText(to: DeliveryTarget, text: string): Promise<MessageRef>;
  editText(ref: MessageRef, text: string): Promise<void>;
  sendFile(
    to: DeliveryTarget,
    absPath: string,
    caption: string,
  ): Promise<MessageRef>;
}

/** Parsed form of an incoming message. */
export type BotCommand =
  | { kind: "get"; url: string }
  | { kind: "link"; url: string }
  /** Fetch it to the server's library, but do not send anything back. */
  | { kind: "download"; url: string }
  | { kind: "keep"; id: string }
  /**
   * Catalogue only. `monitoringType` null means no monitoring: a video is
   * indexed into the "None" pseudo-playlist, a playlist is recorded with
   * monitoringType "N/A".
   */
  | { kind: "index"; url: string; monitoringType: string | null }
  /** One page of a playlist's entries, in playlist order. */
  | { kind: "list"; url: string; start: number; limit: number }
  /** The index of known playlists, for when the URL is not to hand. */
  | { kind: "playlists"; limit: number }
  | { kind: "search"; query: string; limit: number }
  | { kind: "remove"; id: string }
  | { kind: "status" }
  | { kind: "history"; limit: number }
  | { kind: "help" }
  | { kind: "unknown"; text: string }
  /** Not addressed to the bot at all — no reply, not even an error. */
  | { kind: "ignore" };
