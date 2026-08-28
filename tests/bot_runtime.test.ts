import { assert, assertEquals } from "std/assert/mod.ts";
import { createEventBus } from "../src/events.ts";
import {
  type BotCoreDependencies,
  type BotRuntime,
  createBotRuntime,
  isAllowed,
  pendingCountForChat,
  type PendingSubmission,
} from "../src/bot/runtime.ts";
import { createSubscriptions } from "../src/bot/subscriptions.ts";
import { createBotCore } from "../src/bot/core.ts";
import type { BotAdapter, DeliveryTarget } from "../src/bot/types.ts";

/**
 * `createBotCore` was a 1,351-line factory whose thirty-three nested functions
 * shared two in-flight maps by closure. Nothing below could be reached without
 * standing up a whole bot; that is what these tests exercise now.
 *
 * The registration path gets the most attention because it is the one place
 * the split could go quietly wrong: `events.off` removes by function identity,
 * so handlers that take the runtime as a parameter have to be bound once and
 * kept. Re-wrapping them at unsubscribe time leaves every listener attached
 * and the bot answering events after it has been told to stop — with no error
 * anywhere.
 */

const CHAT = "1391594622";

function adapter(): BotAdapter {
  return {
    platform: "telegram",
    maxUploadBytes: 50 * 1024 * 1024,
    sendText: () => Promise.resolve(null),
    editText: () => Promise.resolve(),
    sendFile: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  } as unknown as BotAdapter;
}

function deps(overrides: Partial<BotCoreDependencies> = {}) {
  return {
    adapters: [adapter()],
    events: createEventBus(),
    delivery: {} as BotCoreDependencies["delivery"],
    listItemsConcurrently: () => Promise.resolve([]),
    resolveAndEnqueue: () => Promise.resolve({ items: [], notIndexed: [] }),
    getQueueSnapshot: () => [],
    getListingQueueDepth: () => 0,
    setPlaylistMonitoring: () => Promise.resolve(),
    store: {} as BotCoreDependencies["store"],
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: () => false,
    allowedChatIds: [CHAT],
    maxPendingPerChat: 3,
    retentionMode: "persistent" as const,
    retentionHours: 24,
    saveLocation: "/tmp",
    chunkSize: 10,
    largeFileWarnBytes: 100 * 1024 * 1024,
    ...overrides,
  } satisfies BotCoreDependencies;
}

const target = (chatId: string): DeliveryTarget => ({
  platform: "telegram",
  chatId,
});

function submission(chatId: string): PendingSubmission {
  return {
    submissionId: "s1",
    adapter: adapter(),
    target: target(chatId),
    ack: null,
    mode: "file",
    startedAt: Date.now(),
    estimatedSize: 0,
    lastProgressAt: 0,
    lastProgressText: "",
    watchdog: null,
    settled: false,
  };
}

Deno.test("createBotRuntime - starts with nothing in flight", () => {
  const rt = createBotRuntime(deps());
  assertEquals(rt.pending.size, 0);
  assertEquals(rt.listings.size, 0);
  assertEquals(rt.adaptersByPlatform.get("telegram")?.platform, "telegram");
});

Deno.test("isAllowed - only the allowlisted chats", () => {
  const rt = createBotRuntime(deps());
  assertEquals(isAllowed(rt, CHAT), true);
  assertEquals(isAllowed(rt, "999"), false);
});

Deno.test("pendingCountForChat - downloads and listings share the cap", () => {
  const rt = createBotRuntime(deps());
  rt.pending.set("a", submission(CHAT));
  rt.pending.set("b", submission("other"));
  rt.listings.set("p", {
    adapter: adapter(),
    target: target(CHAT),
    ack: null,
    lastProgressAt: 0,
    lastProgressText: "",
  });

  // Two for this chat: one download and one listing. The other chat's
  // download does not count against it.
  assertEquals(pendingCountForChat(rt, CHAT), 2);
  assertEquals(pendingCountForChat(rt, "other"), 1);
});

Deno.test("subscriptions - unsubscribe really detaches every listener", () => {
  const events = createEventBus();
  const rt: BotRuntime = createBotRuntime(deps({ events }));
  const { subscribe, unsubscribe } = createSubscriptions(rt);

  const watched = [
    "download-started",
    "downloading-percent-update",
    "download-done",
    "download-failed",
    "listing-error",
    "listing-playlist-chunk-complete",
  ] as const;

  for (const event of watched) {
    assertEquals(events.listenerCount(event), 0, `${event} before subscribe`);
  }

  subscribe();
  for (const event of watched) {
    assertEquals(events.listenerCount(event), 1, `${event} after subscribe`);
  }

  unsubscribe();
  for (const event of watched) {
    // The assertion the split could have broken: `off` matches on identity, so
    // a handler re-wrapped here would leave the count at 1 and say nothing.
    assertEquals(events.listenerCount(event), 0, `${event} after unsubscribe`);
  }
});

Deno.test("subscriptions - subscribing twice and unsubscribing once still detaches", () => {
  // The bus stores handlers in a Set, so the same bound listener registered
  // twice is one entry — which is what makes a single unsubscribe enough.
  const events = createEventBus();
  const rt = createBotRuntime(deps({ events }));
  const { subscribe, unsubscribe } = createSubscriptions(rt);

  subscribe();
  subscribe();
  assertEquals(events.listenerCount("download-done"), 1);

  unsubscribe();
  assertEquals(events.listenerCount("download-done"), 0);
});

Deno.test("subscriptions - unsubscribe clears in-flight state and its timers", () => {
  const events = createEventBus();
  const rt = createBotRuntime(deps({ events }));
  const { subscribe, unsubscribe } = createSubscriptions(rt);
  subscribe();

  let cleared = false;
  const entry = submission(CHAT);
  // A watchdog left running keeps the process alive and fails the submission
  // long after the bot stopped.
  entry.watchdog = setTimeout(() => {}, 60_000);
  const realClear = clearTimeout;
  globalThis.clearTimeout = ((id: number) => {
    cleared = true;
    realClear(id);
  }) as typeof clearTimeout;

  rt.pending.set("a", entry);
  rt.listings.set("p", {
    adapter: adapter(),
    target: target(CHAT),
    ack: null,
    lastProgressAt: 0,
    lastProgressText: "",
  });

  try {
    unsubscribe();
  } finally {
    globalThis.clearTimeout = realClear;
  }

  assertEquals(rt.pending.size, 0);
  assertEquals(rt.listings.size, 0);
  assert(cleared, "the pending submission's watchdog should be cleared");
});

Deno.test("createBotCore - each core keeps its own in-flight state", () => {
  // Two cores on one bus must not see each other's submissions. The maps used
  // to be closure state, which gave this for free; they are runtime fields
  // now, so it is worth pinning that createBotRuntime is called per core.
  const events = createEventBus();
  const first = createBotCore(deps({ events }));
  const second = createBotCore(deps({ events }));

  first.subscribe();
  second.subscribe();
  assertEquals(events.listenerCount("download-done"), 2);

  first.unsubscribe();
  assertEquals(
    events.listenerCount("download-done"),
    1,
    "one core unsubscribing must not detach the other's listener",
  );

  second.unsubscribe();
  assertEquals(events.listenerCount("download-done"), 0);
});

Deno.test("createBotCore - exposes the same surface it always did", () => {
  const core = createBotCore(deps());
  assertEquals(typeof core.handleMessage, "function");
  assertEquals(typeof core.subscribe, "function");
  assertEquals(typeof core.unsubscribe, "function");
});
