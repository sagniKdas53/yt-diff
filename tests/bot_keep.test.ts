import { assertEquals } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import { processKeepFileRequest } from "../src/bot/keepfile.ts";
import type { BotStore, VideoRecord } from "../src/bot/store.ts";
import type {
  BotAdapter,
  IncomingMessage,
  MessageRef,
} from "../src/bot/types.ts";
import { createEventBus } from "../src/events.ts";
import type { AppEventBus } from "../src/events.ts";
import type { HttpResponseLike } from "../src/transport/http.ts";
import type { BotRuntime } from "../src/bot/runtime.ts";

/**
 * Backlog items 1 and 2 from the bot's side: a file's clock has to be visible
 * and reversible in chat, and work that is already under way has to be
 * stoppable. Silence is the failure both of these exist to remove.
 */

const CHAT = "1391594622";
const URL = "https://www.youtube.com/watch?v=abc123";
const OTHER_URL = "https://youtu.be/zzz";
const ID = "sub-abcdef12";
const REF: MessageRef = { platform: "telegram", chatId: CHAT, messageId: "1" };

interface Harness {
  handle: (text: string) => Promise<void>;
  edits: string[];
  /** (canonicalUrl, chatId) per keepSubmissionsByUrl call. */
  kept: { url: string; chatId: string | undefined }[];
  reaped: string[];
  purged: string[];
  cancelledDownloads: string[];
  cancelledListings: string[];
  submissionUpdates: Record<string, unknown>[];
  events: AppEventBus;
  runtime: BotRuntime;
  adapter: BotAdapter;
  /** Resolves once a delivery has finished writing its ack. */
  delivered: Promise<void>;
  subscribe: () => void;
  stop: () => void;
}

interface Options {
  /** What `keepSubmissionsByUrl` should report having kept. */
  kept?: number;
  /** Submission the /history code resolves to; null for "no such id". */
  submission?: { canonicalUrl: string | null } | null;
  retentionMode?: "ephemeral" | "persistent";
  retentionHours?: number;
}

function harness(options: Options = {}): Harness {
  const edits: string[] = [];
  const { promise: delivered, resolve: markDelivered } = Promise
    .withResolvers<void>();
  const kept: Harness["kept"] = [];
  const reaped: string[] = [];
  const purged: string[] = [];
  const cancelledDownloads: string[] = [];
  const cancelledListings: string[] = [];
  const submissionUpdates: Record<string, unknown>[] = [];
  const events = createEventBus();

  const adapter: BotAdapter = {
    platform: "telegram",
    maxUploadBytes: 50_000_000,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendText: (_to, text) => {
      // Command replies arrive as new messages; ack edits rewrite one. Both
      // are what the user read, so both land in the same log.
      edits.push(text);
      return Promise.resolve(REF);
    },
    editText: (_ref, text) => {
      edits.push(text);
      // The ack edit is the last thing deliverVideo does, so it doubles as
      // "this delivery is finished" — no guess at how long it takes.
      markDelivered();
      return Promise.resolve();
    },
    sendFile: () => Promise.resolve(REF),
  };

  const video: VideoRecord = {
    videoUrl: URL,
    videoId: "abc123",
    title: "A video",
    downloadStatus: true,
    fileName: "video.mp4",
    saveDirectory: "",
    approximateSize: 1024,
  };

  const store = {
    createSubmission: () => Promise.resolve({ id: ID }),
    updateSubmission: (_id: string, fields: Record<string, unknown>) => {
      submissionUpdates.push(fields);
      return Promise.resolve();
    },
    findVideoByUrl: () => Promise.resolve(video),
    findVideosByVideoId: () => Promise.resolve([video]),
    listSubmissions: () => Promise.resolve([]),
    searchVideos: () => Promise.resolve([]),
    findPlaylistByUrl: () => Promise.resolve(null),
    listPlaylists: () => Promise.resolve([]),
    listPlaylistVideos: () => Promise.resolve({ total: 0, items: [] }),
    findSubmissionByPrefix: (_chatId: string, prefix: string) =>
      Promise.resolve(
        options.submission !== undefined && ID.startsWith(prefix)
          ? {
            id: ID,
            status: "delivered",
            requestedUrl: URL,
            ...options.submission,
          }
          : null,
      ),
    keepSubmissionsByUrl: (url: string, chatId?: string) => {
      kept.push({ url, chatId });
      return Promise.resolve(options.kept ?? 1);
    },
    markSubmissionsReapedByUrl: (url: string) => {
      reaped.push(url);
      return Promise.resolve(1);
    },
    purgeVideoFiles: (url: string) => {
      purged.push(url);
      return Promise.resolve(true);
    },
    listUnsettledSubmissions: () => Promise.resolve([]),
    listActiveChatsSince: () => Promise.resolve([]),
    getLastSeenAt: () => Promise.resolve(null),
    touchLastSeenAt: () => Promise.resolve(),
  } as unknown as BotStore;

  const core = createBotCore({
    adapters: [adapter],
    events,
    delivery: {
      deliver: () => Promise.resolve({ mode: "upload" as const }),
      buildSignedUrl: () => "https://example.test/f",
      buildPlayerUrl: (videoUrl: string) =>
        `https://example.test/#/unlisted?v=${videoUrl}`,
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: () => Promise.resolve([]),
    resolveAndEnqueue: () => Promise.resolve({ items: [], notIndexed: [] }),
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
    cancelDownload: (url: string) => {
      cancelledDownloads.push(url);
      return "queued" as const;
    },
    cancelListing: (url: string) => {
      cancelledListings.push(url);
      return "killed" as const;
    },
    locateVideo: () => Promise.resolve({ playlistUrl: null, page: null }),
    store,
    normalizeUrl: (url: string) =>
      url.startsWith("https://youtu.be/")
        ? `https://www.youtube.com/watch?v=${
          url.slice("https://youtu.be/".length)
        }`
        : url,
    isPlaylistUrl: () => false,
    allowedChatIds: [CHAT],
    maxPendingPerChat: 5,
    retentionMode: options.retentionMode ?? "persistent",
    retentionHours: options.retentionHours ?? 24,
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
    edits,
    kept,
    reaped,
    purged,
    cancelledDownloads,
    cancelledListings,
    submissionUpdates,
    events,
    runtime: core.runtime,
    adapter,
    delivered,
    subscribe: core.subscribe,
    stop: core.unsubscribe,
  };
}

/** Puts a submission in flight the way an enqueue would. */
function putInFlight(h: Harness, url: string) {
  h.runtime.pending.set(url, {
    submissionId: ID,
    adapter: h.adapter,
    target: { platform: "telegram", chatId: CHAT },
    ack: REF,
    mode: "file",
    startedAt: Date.now(),
    estimatedSize: 0,
    lastProgressAt: 0,
    lastProgressText: "",
    watchdog: null,
    settled: false,
  });
}

/** Captures what a handler wrote, without a socket. */
function captureResponse(): {
  res: HttpResponseLike;
  body: () => Record<string, unknown>;
} {
  let status = 0;
  let raw = "";
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code;
      return undefined;
    },
    write: (chunk: string | Uint8Array) => {
      raw += typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk);
      return undefined;
    },
    end: (chunk?: string | Uint8Array) => {
      if (chunk) {
        raw += typeof chunk === "string"
          ? chunk
          : new TextDecoder().decode(chunk);
      }
      return undefined;
    },
  } as unknown as HttpResponseLike;

  return {
    res,
    body: () => {
      if (status !== 200) {
        throw new Error(`expected 200, got ${status}: ${raw}`);
      }
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

Deno.test("/keep <url> - keeps every submission of it in this chat", async () => {
  const h = harness({ kept: 1 });
  await h.handle(`/keep ${OTHER_URL}`);

  // The link the user pasted is canonicalised the way a submission's is,
  // because `canonicalUrl` is what the column was written with.
  assertEquals(h.kept, [{
    url: "https://www.youtube.com/watch?v=zzz",
    chatId: CHAT,
  }]);
  assertEquals(h.edits, ["Kept — the reaper will leave that one alone."]);
});

Deno.test("/keep <url> - says so when the bot never fetched it", async () => {
  const h = harness({ kept: 0 });
  await h.handle(`/keep ${OTHER_URL}`);

  // A URL is far easier to mistype than an eight-character id, so "nothing
  // matched" is the answer that has to be unmistakable.
  assertEquals(h.edits, ["I never downloaded that link."]);
});

Deno.test("/keep <id> - still keeps the one submission it names", async () => {
  const h = harness({ submission: { canonicalUrl: URL } });
  await h.handle(`/keep ${ID}`);

  assertEquals(h.kept, []);
  assertEquals(h.submissionUpdates, [{
    retention: "persistent",
    expiresAt: null,
  }]);
});

Deno.test("/rm <url> - deletes the files and reaps this chat's rows", async () => {
  const h = harness();
  await h.handle(`/rm ${OTHER_URL}`);

  assertEquals(h.purged, ["https://www.youtube.com/watch?v=zzz"]);
  assertEquals(h.reaped, ["https://www.youtube.com/watch?v=zzz"]);
  assertEquals(h.edits, ["Removed."]);
});

Deno.test("/cancel <id> - stops the download that submission is waiting on", async () => {
  const h = harness({ submission: { canonicalUrl: URL } });
  putInFlight(h, URL);
  await h.handle(`/cancel ${ID}`);

  assertEquals(h.cancelledDownloads, [URL]);
  assertEquals(h.edits, ["It had not started yet — dropped from the queue."]);
});

Deno.test("/cancel <id> - a cancelled queued download settles as failed", async () => {
  const h = harness({ submission: { canonicalUrl: URL } });
  h.subscribe();
  putInFlight(h, URL);
  await h.handle(`/cancel ${ID}`);

  // What the pipeline does for a download it dropped before starting: the
  // caller who cancelled is the one waiting on this event, and without it the
  // submission would sit "downloading" until the watchdog fired.
  h.events.emit("download-failed", {
    url: URL,
    error: "Cancelled before it started",
  });
  await h.delivered;

  const failed = h.submissionUpdates.find((u) => u.status === "failed");
  assertEquals(
    failed?.errorMessage,
    "Download failed: Cancelled before it started",
  );
  assertEquals(h.runtime.pending.has(URL), false);
  h.stop();
});

Deno.test("/cancel <url> - a playlist listing is stopped and says what it left", async () => {
  const h = harness();
  h.runtime.listings.set(URL, {
    adapter: h.adapter,
    target: { platform: "telegram", chatId: CHAT },
    ack: null,
    lastProgressAt: 0,
    lastProgressText: "",
  });
  await h.handle(`/cancel ${URL}`);

  assertEquals(h.cancelledListings, [URL]);
  assertEquals(h.cancelledDownloads, []);
  // The partial index is kept, and the user is told that rather than left to
  // wonder whether a half-listed playlist was rolled back.
  assertEquals(h.edits, [
    "Listing stopped. Whatever it had indexed so far is kept.",
  ]);
});

Deno.test("/cancel <url> - nothing running is reported, not claimed", async () => {
  const h = harness();
  await h.handle(`/cancel ${URL}`);

  assertEquals(h.cancelledDownloads, []);
  assertEquals(h.cancelledListings, []);
  assertEquals(h.edits, [
    "Nothing of yours is running for that — it may already be finished.",
  ]);
});

Deno.test("delivery - a reaped file says when it goes and how to keep it", async () => {
  const h = harness({ retentionMode: "ephemeral", retentionHours: 3 });
  h.subscribe();
  putInFlight(h, URL);
  h.events.emit("download-done", {
    url: URL,
    saveDirectory: "",
    title: "A video",
    fileName: "video.mp4",
  });
  await h.delivered;
  h.stop();

  // The one sentence that makes the retention rule actionable: an unmonitored
  // playlist's file is reaped on schedule like any other, so the delivery is
  // where the user learns that and what to type about it.
  assertEquals(
    h.edits.some((edit) =>
      edit.includes("Expires in 3 h — `/keep " + URL + "` to keep it.")
    ),
    true,
  );
  h.stop();
});

Deno.test("delivery - a persistent submission carries no expiry line", async () => {
  const h = harness({ retentionMode: "persistent" });
  h.subscribe();
  putInFlight(h, URL);
  h.events.emit("download-done", {
    url: URL,
    saveDirectory: "",
    title: "A video",
    fileName: "video.mp4",
  });
  await h.delivered;
  h.stop();

  assertEquals(h.edits.some((edit) => edit.includes("Expires in")), false);
  h.stop();
});

Deno.test("/keepfile - marks the submission persistent and reports the count", async () => {
  const kept: { url: string; chatId: string | undefined }[] = [];
  const { res, body } = captureResponse();

  await processKeepFileRequest({ videoUrl: URL }, res, {
    keepSubmissionsByUrl: (url, chatId) => {
      kept.push({ url, chatId });
      return Promise.resolve(2);
    },
  });

  // No chat filter: the UI is looking at a row, not at one chat's history.
  assertEquals(kept, [{ url: URL, chatId: undefined }]);
  assertEquals(body(), { status: "success", kept: 2 });
});
