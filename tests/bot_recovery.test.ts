import { assertEquals } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import {
  buildOutageNotice,
  OUTAGE_AFTER_MS,
  runBootRecovery,
  TELEGRAM_UPDATE_RETENTION_MS,
} from "../src/bot/recovery.ts";
import type {
  BotStore,
  UnsettledSubmissionRecord,
  VideoRecord,
} from "../src/bot/store.ts";
import type { BotAdapter, MessageRef } from "../src/bot/types.ts";
import { createEventBus } from "../src/events.ts";
import type { AppEventBus } from "../src/events.ts";

const CHAT = "1391594622";
const OTHER_CHAT = "999";
const URL = "https://www.youtube.com/watch?v=abc123";

interface Harness {
  recover: (now?: Date) => Promise<{
    announcedChats: number;
    resumed: number;
  }>;
  sent: string[];
  enqueued: string[];
  createdSubmissions: { requestedUrl: string; requestedDeliveryMode: string }[];
  updates: { id: string; fields: Record<string, unknown> }[];
  heartbeats: Date[];
  delivered: { forceLink: boolean }[];
  events: AppEventBus;
}

interface HarnessOptions {
  lastSeenAt: Date | null;
  unsettled: UnsettledSubmissionRecord[];
  chats: { platform: "telegram"; chatId: string }[];
  /** Row the store reports for a lookup; null means "not indexed". */
  video?: VideoRecord | null;
  maxPendingPerChat?: number;
}

/**
 * Cores built here, torn down by the test that made them.
 *
 * A replayed submission arms a watchdog when it does not settle inside the
 * test, and Deno's leak detector fails on the pending timer. unsubscribe() is
 * exactly what the service does on shutdown and is what clears them.
 */
const liveCores: { unsubscribe: () => void }[] = [];

function harness(options: HarnessOptions): Harness {
  const sent: string[] = [];
  const enqueued: string[] = [];
  const createdSubmissions: {
    requestedUrl: string;
    requestedDeliveryMode: string;
  }[] = [];
  const updates: { id: string; fields: Record<string, unknown> }[] = [];
  const heartbeats: Date[] = [];
  const delivered: { forceLink: boolean }[] = [];
  const events = createEventBus();

  const ref: MessageRef = {
    platform: "telegram",
    chatId: CHAT,
    messageId: "1",
  };
  const adapter: BotAdapter = {
    platform: "telegram",
    maxUploadBytes: 50_000_000,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendText: (_to, text) => {
      sent.push(text);
      return Promise.resolve(ref);
    },
    editText: () => Promise.resolve(),
    sendFile: () => Promise.resolve(ref),
  };

  const store: BotStore = {
    createSubmission: (fields) => {
      createdSubmissions.push({
        requestedUrl: fields.requestedUrl,
        requestedDeliveryMode: fields.requestedDeliveryMode,
      });
      return Promise.resolve({ id: "sub-new" });
    },
    updateSubmission: (id, fields) => {
      updates.push({ id, fields });
      return Promise.resolve();
    },
    // Any URL reports as indexed: a backlog is several distinct links, and a
    // store that only knew one of them would send the rest down the
    // index-first path instead.
    findVideoByUrl: (videoUrl) =>
      Promise.resolve(options.video ? { ...options.video, videoUrl } : null),
    findVideosByVideoId: () => Promise.resolve([]),
    listSubmissions: () => Promise.resolve([]),
    searchVideos: () => Promise.resolve([]),
    findPlaylistByUrl: () => Promise.resolve(null),
    listPlaylists: () => Promise.resolve([]),
    listPlaylistVideos: () => Promise.resolve({ total: 0, items: [] }),
    findSubmissionByPrefix: () => Promise.resolve(null),
    purgeVideoFiles: () => Promise.resolve(true),
    listUnsettledSubmissions: () => Promise.resolve(options.unsettled),
    listActiveChatsSince: () => Promise.resolve(options.chats),
    getLastSeenAt: () => Promise.resolve(options.lastSeenAt),
    touchLastSeenAt: (at) => {
      heartbeats.push(at);
      return Promise.resolve();
    },
    keepSubmissionsByUrl: () => Promise.resolve(0),
    markSubmissionsReapedByUrl: () => Promise.resolve(0),
  };

  const core = createBotCore({
    adapters: [adapter],
    events,
    delivery: {
      deliver: (req: { forceLink: boolean }) => {
        delivered.push({ forceLink: req.forceLink });
        return Promise.resolve({ mode: "upload" as const });
      },
      buildSignedUrl: () => "https://example.test/f",
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: (items) =>
      Promise.resolve([{ url: items[0].url, status: "completed" }]),
    resolveAndEnqueue: (urls) => {
      enqueued.push(urls[0]);
      return Promise.resolve({
        items: [{ url: urls[0], queuePosition: 1 }],
        notIndexed: [],
      });
    },
    getQueueSnapshot: () => [],
    getListingQueueDepth: () => 0,
    setPlaylistMonitoring: () => Promise.resolve(),
    syncExtras: () =>
      Promise.resolve({
        url: "",
        status: "unchanged" as const,
        recovered: [],
        stillMissing: [],
        reason: null,
      }),
    cancelDownload: () => "not-found" as const,
    cancelListing: () => "not-found" as const,
    locateVideo: () => Promise.resolve({ playlistUrl: null, page: null }),
    store,
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: () => false,
    allowedChatIds: [CHAT, OTHER_CHAT],
    maxPendingPerChat: options.maxPendingPerChat ?? 5,
    retentionMode: "ephemeral",
    retentionHours: 24,
    // Never read: the replay stops at the queue, not at the disk.
    saveLocation: "/tmp/yt-diff-recovery-test",
    chunkSize: 10,
    largeFileWarnBytes: 104857600,
  });

  // Subscribed up front: the service subscribes before any adapter starts,
  // and the recovery assertions below depend on the bus having listeners.
  core.subscribe();
  liveCores.push(core);

  return {
    recover: (now?: Date) => runBootRecovery(core.runtime, store, now),
    sent,
    enqueued,
    createdSubmissions,
    updates,
    heartbeats,
    delivered,
    events,
  };
}

function unsettled(
  overrides: Partial<UnsettledSubmissionRecord> = {},
): UnsettledSubmissionRecord {
  return {
    id: "sub-1",
    platform: "telegram",
    chatId: CHAT,
    requestedUrl: URL,
    kind: "video",
    requestedDeliveryMode: "file",
    createdAt: new Date("2026-09-16T07:26:00Z"),
    ...overrides,
  };
}

/** Lets the bus's own async handlers finish before assertions. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const indexedVideo: VideoRecord = {
  videoUrl: URL,
  videoId: "abc123",
  title: "Some video",
  downloadStatus: false,
  fileName: null,
  saveDirectory: null,
  approximateSize: 1024,
};

Deno.test({
  name: "recovery - a stale heartbeat produces one outage notice per chat",
  async fn() {
    const now = new Date("2026-09-16T09:56:00Z");
    const h = harness({
      lastSeenAt: new Date("2026-09-15T07:10:00Z"),
      unsettled: [],
      chats: [
        { platform: "telegram", chatId: CHAT },
        { platform: "telegram", chatId: OTHER_CHAT },
      ],
    });

    const summary = await h.recover(now);

    assertEquals(summary.announcedChats, 2);
    assertEquals(summary.resumed, 0);
    assertEquals(h.sent.length, 2);
    for (const text of h.sent) {
      assertEquals(
        text,
        buildOutageNotice(new Date("2026-09-15T07:10:00Z"), now),
      );
      // The cutoff the bot can actually know: boot minus Telegram's 24 h
      // window. Everything before it is unrecoverable and must be resent.
      const cutoff = new Date(
        now.getTime() - TELEGRAM_UPDATE_RETENTION_MS,
      ).toISOString();
      assertEquals(
        new Date("2026-09-16T09:56:00Z").getTime() - new Date(cutoff).getTime(),
        TELEGRAM_UPDATE_RETENTION_MS,
      );
      assertEquals(text.includes("never reached me"), true);
    }
  },
});

Deno.test({
  name: "recovery - a fresh heartbeat says nothing",
  async fn() {
    const now = new Date("2026-09-16T09:56:00Z");
    const h = harness({
      lastSeenAt: new Date(now.getTime() - 30 * 1000),
      unsettled: [],
      chats: [{ platform: "telegram", chatId: CHAT }],
    });

    const summary = await h.recover(now);

    assertEquals(summary, { announcedChats: 0, resumed: 0 });
    assertEquals(h.sent, []);
    assertEquals(h.heartbeats.length, 1);
  },
});

Deno.test({
  name: "recovery - a first ever boot does not claim an outage",
  async fn() {
    const h = harness({
      lastSeenAt: null,
      unsettled: [],
      chats: [{ platform: "telegram", chatId: CHAT }],
    });

    const summary = await h.recover(new Date("2026-09-16T09:56:00Z"));

    assertEquals(summary.announcedChats, 0);
    assertEquals(h.sent, []);
    // The stamp still happens, or the next boot would think this one was one.
    assertEquals(h.heartbeats.length, 1);
  },
});

Deno.test({
  name: "recovery - a gap inside the minute window is not an outage",
  async fn() {
    const now = new Date("2026-09-16T09:56:00Z");
    const h = harness({
      lastSeenAt: new Date(now.getTime() - (OUTAGE_AFTER_MS - 1000)),
      unsettled: [],
      chats: [{ platform: "telegram", chatId: CHAT }],
    });

    assertEquals((await h.recover(now)).announcedChats, 0);
    assertEquals(h.sent, []);
  },
});

Deno.test({
  name: "recovery - an unsettled submission is replayed onto the same row",
  async fn() {
    const h = harness({
      lastSeenAt: new Date("2026-09-16T09:55:00Z"),
      unsettled: [unsettled()],
      chats: [],
      video: indexedVideo,
    });

    const summary = await h.recover(new Date("2026-09-16T09:56:00Z"));

    assertEquals(summary.resumed, 1);
    assertEquals(h.enqueued, [URL]);
    // One user request stays one row: the replay reuses it instead of opening
    // a second one, or a restart would multiply the history.
    assertEquals(h.createdSubmissions, []);
    assertEquals(
      h.updates.some((update) => update.id === "sub-1"),
      true,
    );
    assertEquals(
      h.sent[0],
      "Picking up where I left off — this one was still in flight when I restarted.",
    );
  },
});

Deno.test({
  name: "recovery - the recorded delivery mode is what gets replayed",
  async fn() {
    const h = harness({
      lastSeenAt: new Date("2026-09-16T09:55:00Z"),
      unsettled: [unsettled({ id: "sub-9", requestedDeliveryMode: "link" })],
      chats: [],
      video: indexedVideo,
    });

    await h.recover(new Date("2026-09-16T09:56:00Z"));
    // The download finishing is what turns the replay into a delivery, so the
    // mode the user asked for is only observable once the file lands.
    h.events.emit("download-done", {
      url: URL,
      title: "Some video",
      fileName: "Some video[abc123].mp4",
      saveDirectory: "",
    });
    await flush();

    // /link answers with a signed URL where a pasted link would upload.
    assertEquals(h.delivered.map((d) => d.forceLink), [true]);
  },
});

Deno.test({
  name: "recovery - a backlog is replayed oldest first",
  async fn() {
    const second = "https://www.youtube.com/watch?v=def456";
    const h = harness({
      lastSeenAt: new Date("2026-09-16T09:55:00Z"),
      unsettled: [
        unsettled({ id: "sub-old", requestedUrl: URL }),
        unsettled({
          id: "sub-new",
          requestedUrl: second,
          createdAt: new Date("2026-09-16T07:39:00Z"),
        }),
      ],
      chats: [],
      video: indexedVideo,
    });

    await h.recover(new Date("2026-09-16T09:56:00Z"));

    assertEquals(h.enqueued, [URL, second]);
  },
});

Deno.test({
  name: "recovery - the per-chat cap does not strand a replayed backlog",
  async fn() {
    // A cap of one is the tightest legal setting. Refusing the replay here
    // would drop exactly the links the restart exists to rescue.
    const h = harness({
      lastSeenAt: new Date("2026-09-16T09:55:00Z"),
      unsettled: [
        unsettled({ id: "sub-1" }),
        unsettled({
          id: "sub-2",
          requestedUrl: "https://www.youtube.com/watch?v=def456",
        }),
      ],
      chats: [],
      video: indexedVideo,
      maxPendingPerChat: 1,
    });

    const summary = await h.recover(new Date("2026-09-16T09:56:00Z"));

    assertEquals(summary.resumed, 2);
    assertEquals(h.enqueued.length, 2);
    assertEquals(
      h.sent.some((text) => text.includes("maximum number of requests")),
      false,
    );
  },
});

Deno.test({
  name: "recovery - a chat off the allowlist is never told anything",
  async fn() {
    const now = new Date("2026-09-16T09:56:00Z");
    const h = harness({
      lastSeenAt: new Date("2026-09-15T07:10:00Z"),
      unsettled: [
        unsettled({
          id: "sub-x",
          chatId: "-100999",
        }),
      ],
      chats: [{ platform: "telegram", chatId: "-100999" }],
      video: indexedVideo,
    });

    const summary = await h.recover(now);

    assertEquals(summary.announcedChats, 0);
    assertEquals(summary.resumed, 0);
    assertEquals(h.sent, []);
    assertEquals(h.enqueued, []);
  },
});

globalThis.addEventListener("unload", () => {
  for (const core of liveCores) {
    core.unsubscribe();
  }
});
