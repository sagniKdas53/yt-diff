import { config } from "../config.ts";
import type { VideoMetadata } from "../db/models.ts";
import type { AppEventBus } from "../events.ts";
import { logger } from "../logger.ts";
import { createTelegramAdapter } from "./adapters/telegram.ts";
import { type BotCoreDependencies, createBotCore } from "./core.ts";
import { createDelivery } from "./delivery.ts";
import type { BotAdapter } from "./types.ts";

export type { BotAdapter } from "./types.ts";

export interface BotServiceDependencies {
  events: AppEventBus;
  listItemsConcurrently: BotCoreDependencies["listItemsConcurrently"];
  resolveAndEnqueue: BotCoreDependencies["resolveAndEnqueue"];
  getQueueSnapshot: BotCoreDependencies["getQueueSnapshot"];
  listProcesses: Map<string, unknown>;
  setPlaylistMonitoring: (url: string, monitoringType: string) => Promise<void>;
  removeVideoFiles: (video: VideoMetadata) => Promise<boolean>;
  createSignedUrlForPath: (
    absPath: string,
    ttlSeconds?: number,
  ) => Promise<{ signedUrlId: string; expiry: number }>;
  normalizeUrl: (url: string) => string;
  isPlaylistUrl: (url: string) => boolean;
}

export interface BotService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Builds the chat bot, or a no-op service when it is disabled.
 *
 * Nothing is constructed when `config.bot.enabled` is false, which includes
 * every fail-closed case (empty allowlist, missing token, bad retention mode).
 * The reason is logged here rather than in config.ts, which cannot import the
 * logger without a cycle.
 */
export function createBotService(deps: BotServiceDependencies): BotService {
  if (config.bot._configError) {
    logger.error("Chat bot is disabled due to a configuration error", {
      error: config.bot._configError.message,
    });
  }

  if (!config.bot.enabled) {
    return {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  }

  const adapters: BotAdapter[] = [
    createTelegramAdapter({
      token: config.bot.telegramToken,
      maxUploadBytes: config.bot.telegramMaxUpload,
    }),
  ];

  const delivery = createDelivery({
    createSignedUrlForPath: deps.createSignedUrlForPath,
    saveLocation: config.saveLocation,
    signedUrlTtl: config.bot.signedUrlTtl,
    // Falls back to the configured origin so a missing BOT_PUBLIC_BASE_URL
    // yields a wrong-but-obvious link rather than a malformed one.
    publicBaseUrl: config.bot.publicBaseUrl ||
      `${config.protocol}://${config.host}${
        config.hidePorts ? "" : `:${config.port}`
      }`,
    urlBase: config.urlBase,
  });

  const core = createBotCore({
    adapters,
    events: deps.events,
    delivery,
    listItemsConcurrently: deps.listItemsConcurrently,
    resolveAndEnqueue: deps.resolveAndEnqueue,
    getQueueSnapshot: deps.getQueueSnapshot,
    listProcesses: deps.listProcesses,
    setPlaylistMonitoring: deps.setPlaylistMonitoring,
    removeVideoFiles: deps.removeVideoFiles,
    normalizeUrl: deps.normalizeUrl,
    isPlaylistUrl: deps.isPlaylistUrl,
    allowedChatIds: config.bot.allowedChatIds,
    maxPendingPerChat: config.bot.maxPendingPerChat,
    retentionMode: config.bot.retentionMode,
    retentionHours: config.bot.retentionHours,
    saveLocation: config.saveLocation,
    chunkSize: config.chunkSize,
  });

  let started = false;

  return {
    async start() {
      if (started) {
        return;
      }
      started = true;
      core.subscribe();

      for (const adapter of adapters) {
        try {
          await adapter.start(core.handleMessage);
        } catch (error) {
          logger.error("Failed to start a bot adapter", {
            platform: adapter.platform,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      logger.info("Chat bot started", {
        platforms: adapters.map((a) => a.platform).join(","),
        allowedChats: config.bot.allowedChatIds.length,
        retention: config.bot.retentionMode,
      });
    },

    async stop() {
      if (!started) {
        return;
      }
      started = false;
      core.unsubscribe();

      for (const adapter of adapters) {
        try {
          await adapter.stop();
        } catch (error) {
          logger.warn("Failed to stop a bot adapter cleanly", {
            platform: adapter.platform,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    },
  };
}
