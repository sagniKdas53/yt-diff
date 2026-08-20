import { logger } from "./logger.ts";

/**
 * Typed in-process event bus.
 *
 * The pipeline already announces its progress over socket.io through `safeEmit`.
 * This bus is a second, in-process fan-out of those same events so server-side
 * consumers (the bot) can react without holding a socket connection to itself.
 *
 * The payload shapes below mirror the existing emit sites exactly; this bus adds
 * no events of its own.
 */

/** Emitted once when a download process is spawned (`download.ts`). */
export interface DownloadStartedPayload {
  url: string;
  /** 101 is the pipeline's sentinel for "started, no progress yet". */
  percentage: number;
}

/** Emitted repeatedly as yt-dlp reports progress (`download.ts`). */
export interface DownloadingPercentUpdatePayload {
  url: string;
  percentage: number;
}

/**
 * Emitted when a download exits successfully (`download.ts`).
 *
 * Everything except `url` and `saveDirectory` is optional because the
 * error-fallback emit site sends a reduced payload.
 */
export interface DownloadDonePayload {
  url: string;
  saveDirectory: string;
  title?: string | null;
  fileName?: string | null;
  isMetaDataSynced?: boolean;
  thumbNailFile?: string | null;
  subTitleFile?: string | null;
  descriptionFile?: string | null;
}

/** Emitted when a download exits non-zero or is killed (`download.ts`). */
export interface DownloadFailedPayload {
  url: string;
  title?: string | null;
  /** Distinguishes a SIGTERM kill from a non-zero exit code. */
  error?: string;
}

/** Emitted when listing yields nothing or throws (`listing.ts`). */
export interface ListingErrorPayload {
  url: string;
  error: string;
}

/**
 * Emitted after every chunk of a playlist listing is persisted (`listing.ts`).
 *
 * Playlist listing is the one pipeline stage that can run for minutes with no
 * other signal, so this is what lets the bot say something while it waits
 * instead of going silent until the whole playlist is done.
 */
export interface ListingPlaylistChunkCompletePayload {
  url: string;
  type: string;
  status: string;
  /** Chunks persisted so far; multiply by the chunk size for a rough count. */
  processedChunks: number;
  playlistTitle: string;
  seekPlaylistListTo: number;
}

export interface AppEventMap {
  "download-started": DownloadStartedPayload;
  "downloading-percent-update": DownloadingPercentUpdatePayload;
  "download-done": DownloadDonePayload;
  "download-failed": DownloadFailedPayload;
  "listing-error": ListingErrorPayload;
  "listing-playlist-chunk-complete": ListingPlaylistChunkCompletePayload;
}

export type AppEventName = keyof AppEventMap;

/**
 * Return values are ignored, so this is deliberately `unknown` rather than
 * `void | Promise<void>` — the latter rejects concise arrow bodies that happen
 * to evaluate to a value. A returned promise is still awaited for rejections.
 */
export type AppEventHandler<E extends AppEventName> = (
  payload: AppEventMap[E],
) => unknown;

/** Event names this bus forwards, for runtime filtering in `safeEmit`. */
const APP_EVENT_NAMES: ReadonlySet<string> = new Set<AppEventName>([
  "download-started",
  "downloading-percent-update",
  "download-done",
  "download-failed",
  "listing-error",
  "listing-playlist-chunk-complete",
]);

/**
 * Narrows an arbitrary event name to one this bus knows about.
 *
 * `safeEmit` is typed as `(event: string, payload: unknown)`, so the fan-out
 * needs this guard to stay type-safe without widening the bus.
 */
export function isAppEventName(event: string): event is AppEventName {
  return APP_EVENT_NAMES.has(event);
}

export interface AppEventBus {
  on<E extends AppEventName>(event: E, handler: AppEventHandler<E>): void;
  off<E extends AppEventName>(event: E, handler: AppEventHandler<E>): void;
  emit<E extends AppEventName>(event: E, payload: AppEventMap[E]): void;
  /** Number of registered handlers, for teardown assertions and tests. */
  listenerCount(event: AppEventName): number;
}

export function createEventBus(): AppEventBus {
  // Handlers are stored untyped and re-narrowed on emit; the public methods
  // are what enforce the payload/event pairing.
  const handlers = new Map<AppEventName, Set<AppEventHandler<AppEventName>>>();

  function on<E extends AppEventName>(event: E, handler: AppEventHandler<E>) {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as AppEventHandler<AppEventName>);
  }

  function off<E extends AppEventName>(event: E, handler: AppEventHandler<E>) {
    const set = handlers.get(event);
    if (!set) {
      return;
    }
    set.delete(handler as AppEventHandler<AppEventName>);
    if (set.size === 0) {
      handlers.delete(event);
    }
  }

  function emit<E extends AppEventName>(event: E, payload: AppEventMap[E]) {
    const set = handlers.get(event);
    if (!set || set.size === 0) {
      return;
    }

    // Iterate a copy so a handler that unsubscribes itself mid-dispatch does
    // not perturb the live set.
    for (const handler of [...set]) {
      try {
        // A handler may be async; a rejected promise must not become an
        // unhandled rejection that takes the process down.
        const result = (handler as AppEventHandler<E>)(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            logger.warn("Event handler rejected", {
              event,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          });
        }
      } catch (error) {
        logger.warn("Event handler threw", {
          event,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  function listenerCount(event: AppEventName): number {
    return handlers.get(event)?.size ?? 0;
  }

  return { on, off, emit, listenerCount };
}

/**
 * Process-wide bus instance.
 *
 * `safeEmit` publishes to it unconditionally; when the bot is disabled nothing
 * subscribes and `emit` returns on the empty-set check above.
 */
export const appEvents: AppEventBus = createEventBus();
