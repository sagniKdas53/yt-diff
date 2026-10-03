import { assertEquals } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import type { BotStore, VideoRecord } from "../src/bot/store.ts";
import type {
  BotAdapter,
  IncomingMessage,
  MessageRef,
} from "../src/bot/types.ts";
import {
  type AppEventBus,
  createEventBus,
  type DownloadDonePayload,
} from "../src/events.ts";
import type { SyncExtrasResult } from "../src/handlers/pipeline/types.ts";

/**
 * Item 11 of the backlog, from the bot's side: a download that produced the
 * video but not every sidecar has to say so where the user is already looking,
 * and there has to be a command that goes and gets the rest.
 */

const CHAT = "1391594622";
const URL = "https://www.youtube.com/watch?v=abc123";
const ID = "sub-abcdef12";

interface Calls {
  /** Everything handed to sendFile, captions included. */
  captions: string[];
  /** Everything handed to editText. */
  edits: string[];
  /** Every URL syncExtras was asked about. */
  synced: string[];
  /**
   * Resolves once the delivery has finished writing. The bus dispatches
   * without awaiting its handlers, so this — not a timer — is what says the
   * message has landed.
   */
  delivered: Promise<void>;
  markDelivered: () => void;
}

interface Harness {
  handle: (text: string) => Promise<void>;
  events: AppEventBus;
  calls: Calls;
  core: ReturnType<typeof createBotCore>;
}

const REF: MessageRef = {
  platform: "telegram",
  chatId: CHAT,
  messageId: "1",
};

function adapter(calls: Calls): BotAdapter {
  return {
    platform: "telegram",
    maxUploadBytes: 50_000_000,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendText: () => Promise.resolve(REF),
    editText: (_ref: MessageRef, text: string) => {
      calls.edits.push(text);
      // The ack edit is the last thing deliverVideo does, so it doubles as
      // "this delivery is finished".
      calls.markDelivered();
      return Promise.resolve();
    },
    sendFile: () => Promise.resolve(REF),
  } as unknown as BotAdapter;
}

const video: VideoRecord = {
  videoUrl: URL,
  videoId: "abc123",
  title: "A video",
  downloadStatus: true,
  fileName: "video.mp4",
  saveDirectory: "",
  approximateSize: 1024,
};

/** @param submission - What `findSubmissionByPrefix` resolves to, or null */
function store(submission: { canonicalUrl: string | null } | null): BotStore {
  return {
    createSubmission: () => Promise.resolve({ id: ID }),
    updateSubmission: () => Promise.resolve(),
    findVideoByUrl: (candidate: string) =>
      Promise.resolve(candidate === URL ? video : null),
    findVideosByVideoId: () => Promise.resolve([video]),
    listSubmissions: () => Promise.resolve([]),
    searchVideos: () => Promise.resolve([]),
    findPlaylistByUrl: () => Promise.resolve(null),
    listPlaylists: () => Promise.resolve([]),
    listPlaylistVideos: () => Promise.resolve({ total: 0, items: [] }),
    findSubmissionByPrefix: (_chatId: string, prefix: string) =>
      Promise.resolve(
        submission && ID.startsWith(prefix)
          ? {
            id: ID,
            status: "delivered",
            requestedUrl: URL,
            ...submission,
          }
          : null,
      ),
    purgeVideoFiles: () => Promise.resolve(true),
    listUnsettledSubmissions: () => Promise.resolve([]),
    listActiveChatsSince: () => Promise.resolve([]),
    getLastSeenAt: () => Promise.resolve(null),
    touchLastSeenAt: () => Promise.resolve(),
  } as unknown as BotStore;
}

/**
 * @param syncResult - What the pipeline's extras-only retry should report
 * @param submission - What the id resolves to; null for "no such id"
 */
function harness(
  syncResult: Partial<SyncExtrasResult> = {},
  submission: { canonicalUrl: string | null } | null = { canonicalUrl: URL },
): Harness {
  const { promise: delivered, resolve: markDelivered } = Promise
    .withResolvers<void>();
  const calls: Calls = {
    captions: [],
    edits: [],
    synced: [],
    delivered,
    markDelivered,
  };
  const events = createEventBus();

  const core = createBotCore({
    adapters: [adapter(calls)],
    events,
    delivery: {
      // The caption is what the user reads under the file, so it is what the
      // partial note has to reach: captured at the delivery seam.
      deliver: (req: { caption: string }) => {
        calls.captions.push(req.caption);
        return Promise.resolve({ mode: "upload" });
      },
      buildSignedUrl: () => "https://example.test/f",
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: () => Promise.resolve([]),
    resolveAndEnqueue: () => Promise.resolve({ items: [], notIndexed: [] }),
    getQueueSnapshot: () => [],
    getListingQueueDepth: () => 0,
    setPlaylistMonitoring: () => Promise.resolve(),
    syncExtras: (videoUrl) => {
      calls.synced.push(videoUrl);
      return Promise.resolve({
        url: videoUrl,
        status: "unchanged",
        recovered: [],
        stillMissing: [],
        reason: null,
        ...syncResult,
      });
    },
    store: store(submission),
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: () => false,
    allowedChatIds: [CHAT],
    maxPendingPerChat: 5,
    retentionMode: "persistent",
    retentionHours: 24,
    saveLocation: "/tmp",
    chunkSize: 10,
    largeFileWarnBytes: 100 * 1024 * 1024,
  });

  const message = (text: string): IncomingMessage => ({
    platform: "telegram",
    chatId: CHAT,
    messageId: "10",
    text,
  });

  return {
    handle: (text) => core.handleMessage(message(text)),
    events,
    calls,
    core,
  };
}
/** The fields a `download-done` payload adds on top of title and fileName. */
type DoneExtras = Pick<
  DownloadDonePayload,
  "partial" | "missingExtras" | "reason"
>;

/** Puts a submission in flight the way an enqueue would, then lets events land. */
async function deliver(h: Harness, payload: DoneExtras): Promise<void> {
  h.core.subscribe();
  h.core.runtime.pending.set(URL, {
    submissionId: ID,
    adapter: adapter(h.calls),
    target: { platform: "telegram", chatId: CHAT },
    ack: REF,
    mode: "file",
    startedAt: Date.now(),
    estimatedSize: 1024,
    lastProgressAt: 0,
    lastProgressText: "",
    watchdog: null,
    settled: false,
  });

  h.events.emit("download-done", {
    url: URL,
    saveDirectory: "",
    title: video.title,
    fileName: video.fileName,
    ...payload,
  });
  await h.calls.delivered;
  h.core.unsubscribe();
}

Deno.test("partial download-done - the delivery says what is missing", async () => {
  const h = harness();
  await deliver(h, {
    partial: true,
    missingExtras: ["subtitles", "thumbnail"],
    reason: "rate-limited",
  });

  // In the message the file arrives in, not as a follow-up the user has to
  // notice after it is already in their hands.
  assertEquals(h.calls.captions, [
    "A video\n\nGot the video, but YouTube rate-limited the extras (subtitles, thumbnail).\n`/sync sub-abcdef12` fetches them later.",
  ]);
  assertEquals(h.calls.edits.length, 1);
  assertEquals(h.calls.edits[0], h.calls.captions[0]);
});

Deno.test("partial download-done - a non-rate-limit reason says so in other words", async () => {
  const h = harness();
  await deliver(h, {
    partial: true,
    missingExtras: ["comments"],
    reason: "error",
  });

  assertEquals(h.calls.captions, [
    "A video\n\nGot the video, but the extras didn't come through (comments).\n`/sync sub-abcdef12` fetches them later.",
  ]);
});

Deno.test("download-done - a complete download's wording is untouched", async () => {
  const h = harness();
  await deliver(h, { partial: false, missingExtras: null, reason: null });

  // Byte-for-byte what it always was: no trailing blank line, no extra line.
  assertEquals(h.calls.captions, ["A video"]);
  assertEquals(h.calls.edits, ["A video"]);
});

Deno.test("/sync <id> - resolves the submission and reports what it recovered", async () => {
  const h = harness({
    status: "recovered",
    recovered: ["subtitles", "thumbnail"],
    stillMissing: [],
  });
  await h.handle(`/sync ${ID}`);

  // The id resolves to the row's own videoUrl, which is what syncExtras looks
  // up: passing the id or a normalised guess would report "unchanged" forever.
  assertEquals(h.calls.synced, [URL]);
  assertEquals(h.calls.edits, [
    "Fetched subtitles, thumbnail. That's everything that was missing.",
  ]);
});

Deno.test("/sync <id> - a partial recovery names what is still missing", async () => {
  const h = harness({
    status: "recovered",
    recovered: ["subtitles"],
    stillMissing: ["comments"],
  });
  await h.handle(`/sync ${ID}`);

  assertEquals(h.calls.edits, ["Fetched subtitles.\nStill missing: comments."]);
});

Deno.test("/sync <id> - nothing new arrived says exactly that", async () => {
  const h = harness({
    status: "unchanged",
    recovered: [],
    stillMissing: ["subtitles"],
    reason: "rate-limited",
  });
  await h.handle(`/sync ${ID}`);

  assertEquals(h.calls.edits, [
    "Nothing new arrived — YouTube is still rate-limiting this video. Try again later.\nStill missing: subtitles.",
  ]);
});

Deno.test("/sync <id> - a failure reports why", async () => {
  const h = harness({
    status: "failed",
    recovered: [],
    stillMissing: ["subtitles"],
    reason: "rate-limited",
  });
  await h.handle(`/sync ${ID}`);

  assertEquals(h.calls.edits, [
    "Couldn't fetch the extras — YouTube is rate-limiting this video right now. Try again later.\nStill missing: subtitles.",
  ]);
});

Deno.test("/sync <url> - an indexed link is normalized and synced", async () => {
  const h = harness({ status: "recovered", recovered: ["subtitles"] });
  await h.handle(`/sync ${URL}`);

  assertEquals(h.calls.synced, [URL]);
});

Deno.test("/sync <url> - a link with no index says so rather than guessing", async () => {
  const h = harness();
  await h.handle("/sync https://youtu.be/never-seen");

  assertEquals(h.calls.synced, []);
  assertEquals(h.calls.edits, []);
});

Deno.test("/sync - an id that matches nothing is rejected", async () => {
  const h = harness();
  await h.handle("/sync zzzz");

  assertEquals(h.calls.synced, []);
  assertEquals(h.calls.edits, []);
});
