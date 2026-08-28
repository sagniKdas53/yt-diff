import type { AppEventBus } from "../events.ts";
import type { Delivery } from "./delivery.ts";
import type { BotStore } from "./store.ts";
import type { BotAdapter, DeliveryTarget, MessageRef } from "./types.ts";

export interface ListingResultLike {
  url: string;
  status: string;
  title?: string;
  error?: string;
}

export interface BotCoreDependencies {
  adapters: BotAdapter[];
  events: AppEventBus;
  delivery: Delivery;
  listItemsConcurrently: (
    items: {
      url: string;
      type: string;
      currentMonitoringType: string;
      reason: string;
    }[],
    chunkSize: number,
    isScheduledUpdate: boolean,
  ) => Promise<ListingResultLike[]>;
  resolveAndEnqueue: (
    urlList: string[],
    playlistUrl: string,
  ) => Promise<{
    items: { url: string; queuePosition: number }[];
    notIndexed: string[];
  }>;
  getQueueSnapshot: () => {
    url: string;
    title: string;
    status: string;
    queuePosition: number;
  }[];
  /** True listing backlog: in-flight plus queued. See getListingQueueDepth. */
  getListingQueueDepth: () => number;
  setPlaylistMonitoring: (url: string, monitoringType: string) => Promise<void>;
  store: BotStore;
  normalizeUrl: (url: string) => string;
  isPlaylistUrl: (url: string) => boolean;
  allowedChatIds: string[];
  maxPendingPerChat: number;
  retentionMode: "ephemeral" | "persistent";
  retentionHours: number;
  saveLocation: string;
  chunkSize: number;
  /** Warn the user when a queued item's estimate exceeds this many bytes. */
  largeFileWarnBytes: number;
}

/**
 * What the user wants done with the file once it exists.
 *
 * - "file"  upload it into the chat, falling back to a link when it is too big
 * - "link"  always answer with a signed URL  (/link)
 * - "store" leave it on the server and send nothing back  (/download)
 */
export type DeliveryMode = "file" | "link" | "store";

/** In-flight state for one submission, keyed by canonical URL. */
export interface PendingSubmission {
  submissionId: string;
  adapter: BotAdapter;
  target: DeliveryTarget;
  ack: MessageRef | null;
  mode: DeliveryMode;
  /** When the download actually started, for the quiet period. */
  startedAt: number;
  /** yt-dlp's size estimate in bytes, 0 when unknown. */
  estimatedSize: number;
  lastProgressAt: number;
  lastProgressText: string;
  watchdog: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/**
 * In-flight state for one playlist listing, keyed by canonical playlist URL.
 *
 * Deliberately not a `PendingSubmission`: a listing has no download to watch,
 * no watchdog and no file to deliver, and folding it into that map would make
 * every download-event handler check which kind of entry it just found.
 */
export interface PendingListing {
  adapter: BotAdapter;
  target: DeliveryTarget;
  ack: MessageRef | null;
  lastProgressAt: number;
  lastProgressText: string;
}

/**
 * Everything the bot's handlers share for the life of one core.
 *
 * This was closure state inside `createBotCore`, a 1,200-line factory holding
 * two in-flight maps that thirty-three nested functions read and wrote: the
 * command handlers, the delivery path, the watchdog timers and the six bus
 * subscriptions all reached the same `pending` and `listings` by capture. It
 * is an explicit parameter now, so each of those is a plain export a test can
 * call without building a bot.
 *
 * Unlike the listing pipeline's sort-order counter, none of this can be moved
 * into the database and deleted: it is in-flight request state with live
 * timers and adapter handles attached. Making it explicit is the whole of the
 * available win, and it is enough — the handlers below no longer share a
 * scope, only a value they are handed.
 */
export interface BotRuntime {
  deps: BotCoreDependencies;
  /** Platform name -> the adapter that speaks it. */
  adaptersByPlatform: Map<string, BotAdapter>;
  /** Canonical URL -> in-flight submission. */
  pending: Map<string, PendingSubmission>;
  /** Canonical playlist URL -> in-flight listing. */
  listings: Map<string, PendingListing>;
}

/** Assembles the runtime. Pure wiring — nothing here reads or writes state. */
export function createBotRuntime(deps: BotCoreDependencies): BotRuntime {
  return {
    deps,
    adaptersByPlatform: new Map(
      deps.adapters.map((adapter) => [adapter.platform, adapter]),
    ),
    pending: new Map<string, PendingSubmission>(),
    listings: new Map<string, PendingListing>(),
  };
}

export function isAllowed(rt: BotRuntime, chatId: string): boolean {
  return rt.deps.allowedChatIds.includes(chatId);
}

/** Downloads and playlist listings both count against the per-chat cap. */
export function pendingCountForChat(rt: BotRuntime, chatId: string): number {
  let count = 0;
  for (const entry of rt.pending.values()) {
    if (entry.target.chatId === chatId) {
      count++;
    }
  }
  for (const entry of rt.listings.values()) {
    if (entry.target.chatId === chatId) {
      count++;
    }
  }
  return count;
}
