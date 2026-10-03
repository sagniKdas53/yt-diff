import { config } from "../config.ts";
import type { AppEventBus } from "../events.ts";
import { logger } from "../logger.ts";
import { createTelegramAdapter } from "./adapters/telegram.ts";
import { parseCommand } from "./commands.ts";
import { type BotCoreDependencies, createBotCore } from "./core.ts";
import { createDelivery } from "./delivery.ts";
import { createMessageDispatcher } from "./dispatcher.ts";
import { runBootRecovery } from "./recovery.ts";
import { type BotStore, createSequelizeBotStore } from "./store.ts";
import type { BotAdapter } from "./types.ts";

export type { BotAdapter } from "./types.ts";

export interface BotServiceDependencies {
  events: AppEventBus;
  listItemsConcurrently: BotCoreDependencies["listItemsConcurrently"];
  resolveAndEnqueue: BotCoreDependencies["resolveAndEnqueue"];
  getQueueSnapshot: BotCoreDependencies["getQueueSnapshot"];
  getListingQueueDepth: BotCoreDependencies["getListingQueueDepth"];
  setPlaylistMonitoring: (url: string, monitoringType: string) => Promise<void>;
  /** Defaults to the Sequelize-backed store; injectable for tests. */
  store?: BotStore;
  /** Stamped while polling and on every update; see bot/recovery.ts. */
  syncExtras: BotCoreDependencies["syncExtras"];
  cancelDownload: BotCoreDependencies["cancelDownload"];
  cancelListing: BotCoreDependencies["cancelListing"];
  locateVideo: BotCoreDependencies["locateVideo"];
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
 * Commands that end in a yt-dlp process, and so have to queue for a slot.
 *
 * A bare link parses as `get`, which is how most submissions arrive. Every
 * other command is a database read and a reply — see the dispatcher's two
 * lanes for why the difference is worth naming.
 */
const SLOW_COMMANDS = new Set(["get", "link", "download", "index", "sync"]);

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

  // BOT_PUBLIC_BASE_URL is an override, not a requirement: unset, links are
  // built from the same origin the server logs at startup. It only needs
  // setting when that origin is not what a chat client can reach — a
  // container-internal HOSTNAME, or a reverse proxy on a different name.
  const publicBaseUrl = config.bot.publicBaseUrl || config.publicOrigin;

  // One store for the whole service: the boot replay and the handlers have to
  // agree about what is in flight, and two instances would still agree only by
  // accident.
  const store = deps.store ?? createSequelizeBotStore();

  const delivery = createDelivery({
    createSignedUrlForPath: deps.createSignedUrlForPath,
    saveLocation: config.saveLocation,
    publicBaseUrl,
    urlBase: config.urlBase,
  });

  const core = createBotCore({
    adapters,
    events: deps.events,
    delivery,
    listItemsConcurrently: deps.listItemsConcurrently,
    resolveAndEnqueue: deps.resolveAndEnqueue,
    getQueueSnapshot: deps.getQueueSnapshot,
    getListingQueueDepth: deps.getListingQueueDepth,
    setPlaylistMonitoring: deps.setPlaylistMonitoring,
    syncExtras: deps.syncExtras,
    cancelDownload: deps.cancelDownload,
    cancelListing: deps.cancelListing,
    locateVideo: deps.locateVideo,
    store,
    normalizeUrl: deps.normalizeUrl,
    isPlaylistUrl: deps.isPlaylistUrl,
    allowedChatIds: config.bot.allowedChatIds,
    maxPendingPerChat: config.bot.maxPendingPerChat,
    retentionMode: config.bot.retentionMode,
    retentionHours: config.bot.retentionHours,
    saveLocation: config.saveLocation,
    chunkSize: config.chunkSize,
    largeFileWarnBytes: config.bot.largeFileWarnBytes,
  });

  // One minute is finer than any outage the bot could notice, and coarse
  // enough that a chatty user is not writing to the database on every
  // message. The stamp has to survive the crash to be worth anything, which
  // is why it is a row rather than a variable.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  async function touchHeartbeat() {
    try {
      await store.touchLastSeenAt(new Date());
    } catch (error) {
      logger.error("Could not record the bot heartbeat", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Handlers run here rather than inside the adapter's update loop, so a
  // message that takes minutes — a playlist index, a large download — never
  // stops the next one from being read. See dispatcher.ts.
  const dispatcher = createMessageDispatcher({
    concurrency: config.bot.maxConcurrentMessages,
    // Stamped per update as well as on the timer: the timestamp has to mean
    // "the bot was reachable", and an update only arrives if it was.
    handle: (message) => {
      void touchHeartbeat();
      return core.handleMessage(message);
    },
    isSlow: (message) => SLOW_COMMANDS.has(parseCommand(message.text).kind),
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
          await adapter.start(dispatcher.dispatch);
        } catch (error) {
          logger.error("Failed to start a bot adapter", {
            platform: adapter.platform,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      heartbeatTimer = setInterval(() => {
        void touchHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
      // Never hold the process open on the bot's account; index.ts already
      // bounds shutdown with a failsafe.
      heartbeatTimer.unref?.();

      // Anything the last process accepted and never settled. Announced and
      // replayed after the adapters are up, so the bot can actually send.
      try {
        const summary = await runBootRecovery(core.runtime, store);
        if (summary.announcedChats > 0 || summary.resumed > 0) {
          logger.info("Recovered from a previous run", { ...summary });
        }
      } catch (error) {
        logger.error("Bot could not replay its in-flight submissions", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      logger.info("Chat bot started", {
        platforms: adapters.map((a) => a.platform).join(","),
        allowedChats: config.bot.allowedChatIds.length,
        concurrentMessages: config.bot.maxConcurrentMessages,
        maxPendingPerChat: config.bot.maxPendingPerChat,
        retention: config.bot.retentionMode,
        // Logged because a link to an unreachable origin looks fine in chat and
        // only fails on the device that taps it.
        linkBase: `${publicBaseUrl}${config.urlBase}`,
        linkBaseFrom: config.bot.publicBaseUrl
          ? "BOT_PUBLIC_BASE_URL"
          : "server origin",
      });
    },

    async stop() {
      if (!started) {
        return;
      }
      started = false;

      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
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

      // Adapters are down, so nothing new arrives; this is only the backlog
      // finishing. Bounded by the caller's shutdown failsafe, not by hope.
      if (dispatcher.inFlight > 0 || dispatcher.queueDepth > 0) {
        logger.info("Waiting for in-flight chat messages", {
          inFlight: dispatcher.inFlight,
          queued: dispatcher.queueDepth,
        });
      }
      await dispatcher.drain();
    },
  };
}
