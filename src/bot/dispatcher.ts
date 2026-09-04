import { logger } from "../logger.ts";
import type { IncomingMessage } from "./types.ts";

export interface MessageDispatcher {
  /**
   * Accepts a message and returns immediately. The returned promise says the
   * message was queued, not that it was handled — that is the whole point.
   */
  dispatch(message: IncomingMessage): Promise<void>;
  /** Messages accepted but not started yet. */
  readonly queueDepth: number;
  /** Messages being handled right now, in either lane. */
  readonly inFlight: number;
  /** Resolves once everything accepted so far has finished. */
  drain(): Promise<void>;
}

export interface MessageDispatcherOptions {
  /** How many slow messages are handled at once. Below 1 is read as 1. */
  concurrency: number;
  handle: (message: IncomingMessage) => Promise<void>;
  /**
   * Which messages have to queue for a slot. Everything else runs the moment
   * it arrives. Defaults to treating every message as slow.
   */
  isSlow?: (message: IncomingMessage) => boolean;
  /** Backlog size that earns a warning in the log. */
  warnQueueDepth?: number;
}

/**
 * Runs message handlers off the platform's update loop, a bounded number at a
 * time.
 *
 * grammy's polling loop awaits each update's handler before asking Telegram
 * for the next batch, so for as long as the bot handled messages inline, one
 * slow message was one silent bot: on 2026-09-04 a playlist submission wedged
 * inside yt-dlp and every message sent after it was never even fetched, let
 * alone answered. The adapter now hands messages here and returns, so the loop
 * only ever waits for an array push.
 *
 * Two lanes, because the messages are not alike. A submission ends in a yt-dlp
 * process and can hold its slot for minutes, so those queue: `concurrency` are
 * worked on and the rest wait their turn, FIFO, none dropped. A question —
 * /status, /list, /search — is a database read and a reply, and runs straight
 * away rather than waiting behind twenty downloads for a slot it barely needs.
 * Without that split, one burst of links makes the bot unable to answer even
 * "what are you doing", which is the state this whole change exists to end.
 */
export function createMessageDispatcher(
  {
    concurrency,
    handle,
    isSlow = () => true,
    warnQueueDepth = 50,
  }: MessageDispatcherOptions,
): MessageDispatcher {
  const workers = Math.max(1, Math.floor(concurrency));
  const queue: IncomingMessage[] = [];
  /** Slow messages holding one of the `workers` slots. */
  let slotsInUse = 0;
  /** Quick messages in flight. Bounded by nothing but the allowlist. */
  let quickInFlight = 0;
  let idleWaiters: (() => void)[] = [];
  let warnedAboutBacklog = false;

  function releaseIdleWaiters() {
    if (slotsInUse > 0 || quickInFlight > 0 || queue.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function run(message: IncomingMessage, holdsSlot: boolean) {
    try {
      await handle(message);
    } catch (error) {
      // handleMessage answers its own failures; anything arriving here would
      // otherwise be an unhandled rejection, which in Deno ends the process.
      logger.error("Bot message handler threw", {
        platform: message.platform,
        chatId: message.chatId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      if (holdsSlot) {
        slotsInUse--;
      } else {
        quickInFlight--;
      }
      if (queue.length === 0) {
        warnedAboutBacklog = false;
      }
      pump();
      releaseIdleWaiters();
    }
  }

  function pump() {
    while (slotsInUse < workers && queue.length > 0) {
      const message = queue.shift();
      if (!message) return;
      slotsInUse++;
      void run(message, true);
    }
  }

  return {
    dispatch(message: IncomingMessage) {
      if (!isSlow(message)) {
        quickInFlight++;
        void run(message, false);
        return Promise.resolve();
      }

      queue.push(message);
      if (queue.length >= warnQueueDepth && !warnedAboutBacklog) {
        warnedAboutBacklog = true;
        logger.warn("Bot message backlog is growing", {
          queueDepth: queue.length,
          inFlight: slotsInUse,
          concurrency: workers,
        });
      }
      pump();
      return Promise.resolve();
    },

    get queueDepth() {
      return queue.length;
    },

    get inFlight() {
      return slotsInUse + quickInFlight;
    },

    drain() {
      if (slotsInUse === 0 && quickInFlight === 0 && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
