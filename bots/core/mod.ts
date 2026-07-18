/**
 * Bot-core public API surface.
 * Re-exports everything platform adapters need.
 */

export { parseUrl } from "./url-parser.ts";
export { YtdiffApiClient } from "./api-client.ts";
export type {
  BotConfig,
  BotIncomingMessage,
  BotOutgoingMessage,
  ParsedUrl,
  VideoLookupResult,
} from "./types.ts";
