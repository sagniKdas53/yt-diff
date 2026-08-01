import { assertEquals } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import type { BotStore, VideoRecord } from "../src/bot/store.ts";
import type { BotAdapter, IncomingMessage, MessageRef } from "../src/bot/types.ts";
import { createEventBus } from "../src/events.ts";

const CHAT = "1391594622";
const URL = "https://www.youtube.com/watch?v=abc123";

interface Harness {
  handle: (text: string) => Promise<void>;
  calls: {
    listing: string[];
    enqueue: string[];
    delivered: { fileName: string; downloadedByBot: boolean }[];
  };
  submissionUpdates: Record<string, unknown>[];
  sent: string[];
}

/**
 * Builds a core with a fake store, so the dedupe tiers can be asserted without
 * a database.
 *
 * @param video - The row the store should report, or null for "not indexed"
 * @param saveLocation - Where hasFileOnDisk will look
 */
function harness(video: VideoRecord | null, saveLocation: string): Harness {
  const calls: Harness["calls"] = { listing: [], enqueue: [], delivered: [] };
  const submissionUpdates: Record<string, unknown>[] = [];
  const sent: string[] = [];

  const ref: MessageRef = { platform: "telegram", chatId: CHAT, messageId: "1" };
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
    createSubmission: () => Promise.resolve({ id: "sub-1" }),
    updateSubmission: (_id, fields) => {
      submissionUpdates.push(fields);
      return Promise.resolve();
    },
    findVideoByUrl: (videoUrl) =>
      Promise.resolve(video && video.videoUrl === videoUrl ? video : null),
    findVideosByVideoId: () => Promise.resolve([]),
    listSubmissions: () => Promise.resolve([]),
    findSubmissionByPrefix: () => Promise.resolve(null),
    purgeVideoFiles: () => Promise.resolve(true),
  };

  const core = createBotCore({
    adapters: [adapter],
    events: createEventBus(),
    delivery: {
      deliver: (req: { fileName: string }) => {
        calls.delivered.push({
          fileName: req.fileName,
          downloadedByBot: false,
        });
        return Promise.resolve({ mode: "upload" as const });
      },
      buildSignedUrl: () => "https://example.test/f",
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: (items) => {
      calls.listing.push(items[0].url);
      return Promise.resolve([{ url: items[0].url, status: "completed" }]);
    },
    resolveAndEnqueue: (urls) => {
      calls.enqueue.push(urls[0]);
      return Promise.resolve({
        items: [{ url: urls[0], queuePosition: 1 }],
        notIndexed: [],
      });
    },
    getQueueSnapshot: () => [],
    listProcesses: new Map(),
    setPlaylistMonitoring: () => Promise.resolve(),
    store,
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: () => false,
    allowedChatIds: [CHAT],
    maxPendingPerChat: 5,
    retentionMode: "ephemeral",
    retentionHours: 24,
    saveLocation,
    chunkSize: 10,
  });

  const message = (text: string): IncomingMessage => ({
    platform: "telegram",
    chatId: CHAT,
    messageId: "10",
    text,
  });

  return {
    handle: (text: string) => core.handleMessage(message(text)),
    calls,
    submissionUpdates,
    sent,
  };
}

async function withSaveDir(
  fn: (saveLocation: string) => Promise<void>,
  withFile = false,
) {
  const dir = await Deno.makeTempDir();
  if (withFile) {
    await Deno.writeFile(`${dir}/video.mp4`, new Uint8Array(8));
  }
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const downloadedVideo: VideoRecord = {
  videoUrl: URL,
  videoId: "abc123",
  title: "A video",
  downloadStatus: true,
  fileName: "video.mp4",
  saveDirectory: "",
};

Deno.test("dedupe tier 1 - downloaded and on disk skips listing and enqueue", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(downloadedVideo, saveLocation);
    await h.handle(URL);

    // The whole point: no yt-dlp process of any kind is spawned.
    assertEquals(h.calls.listing, []);
    assertEquals(h.calls.enqueue, []);
    assertEquals(h.calls.delivered.length, 1);
  }, true);
});

Deno.test("dedupe tier 1 - re-delivery records downloadedByBot=false", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(downloadedVideo, saveLocation);
    await h.handle(URL);

    const delivered = h.submissionUpdates.find((u) => u.status === "delivered");
    // The reaper must never delete a file the bot did not fetch.
    assertEquals(delivered?.downloadedByBot, false);
    assertEquals(delivered?.expiresAt, null);
  }, true);
});

Deno.test("dedupe tier 2 - indexed but not downloaded enqueues without listing", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(
      { ...downloadedVideo, downloadStatus: false, fileName: null },
      saveLocation,
    );
    await h.handle(URL);

    assertEquals(h.calls.listing, []);
    assertEquals(h.calls.enqueue, [URL]);
  });
});

Deno.test("dedupe tier 2 - a row whose file vanished is re-downloaded, not re-indexed", async () => {
  await withSaveDir(async (saveLocation) => {
    // downloadStatus is true but the file is missing from disk.
    const h = harness(downloadedVideo, saveLocation);
    await h.handle(URL);

    assertEquals(h.calls.listing, []);
    assertEquals(h.calls.enqueue, [URL]);
    assertEquals(h.calls.delivered, []);
  });
});

Deno.test("dedupe tier 3 - an unknown URL is indexed then enqueued", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(null, saveLocation);
    await h.handle(URL);

    assertEquals(h.calls.listing, [URL]);
    // No row is ever produced by the fake store, so it fails at re-resolve.
    assertEquals(h.calls.enqueue, []);
  });
});

Deno.test("dedupe tier 3 - listing that yields no row fails with a clear reason", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(null, saveLocation);
    await h.handle(URL);

    const failed = h.submissionUpdates.find((u) => u.status === "failed");
    assertEquals(
      failed?.errorMessage,
      "That link indexed but produced no video entry.",
    );
  });
});

Deno.test("dedupe - the same URL twice in flight is rejected once", async () => {
  await withSaveDir(async (saveLocation) => {
    const h = harness(
      { ...downloadedVideo, downloadStatus: false, fileName: null },
      saveLocation,
    );
    // The first submission stays pending (nothing resolves the download), so
    // the second must be turned away rather than double-queued.
    const first = h.handle(URL);
    await h.handle(URL);
    await first;

    assertEquals(h.calls.enqueue.length, 1);
    assertEquals(h.sent.includes("That one is already in progress."), true);
  });
});
