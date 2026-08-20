import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import type {
  BotStore,
  PlaylistEntryRecord,
  PlaylistRecord,
  VideoRecord,
} from "../src/bot/store.ts";
import type {
  BotAdapter,
  IncomingMessage,
  MessageRef,
} from "../src/bot/types.ts";
import { type AppEventBus, createEventBus } from "../src/events.ts";

const CHAT = "1391594622";
const PLAYLIST = "https://www.youtube.com/playlist?list=PL1";
const VIDEO = "https://www.youtube.com/watch?v=abc123";

interface ListingCall {
  url: string;
  type: string;
  currentMonitoringType: string;
}

interface Harness {
  handle: (text: string) => Promise<void>;
  events: AppEventBus;
  listings: ListingCall[];
  enqueued: string[];
  delivered: string[];
  monitoringSet: { url: string; monitoringType: string }[];
  submissionUpdates: Record<string, unknown>[];
  sent: string[];
  edits: string[];
}

interface HarnessOptions {
  /** Playlist row the store should report, or null for "not indexed". */
  playlist?: PlaylistRecord | null;
  entries?: PlaylistEntryRecord[];
  /** Video row the store should report for a single-video URL. */
  video?: VideoRecord | null;
  /** Status the fake listing reports back. */
  listingStatus?: string;
  /**
   * Runs while the fake listing is in flight.
   *
   * Progress events are only meaningful between the listing being registered
   * and it finishing, which is exactly this window.
   */
  duringListing?: (events: AppEventBus) => void;
}

/**
 * Builds a core whose pipeline is faked, so the playlist and /download paths
 * can be asserted without a database or yt-dlp.
 */
function harness(options: HarnessOptions = {}): Harness {
  const listings: ListingCall[] = [];
  const enqueued: string[] = [];
  const delivered: string[] = [];
  const monitoringSet: { url: string; monitoringType: string }[] = [];
  const submissionUpdates: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const edits: string[] = [];
  const entries = options.entries ?? [];

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
    editText: (_ref, text) => {
      edits.push(text);
      return Promise.resolve();
    },
    sendFile: () => Promise.resolve(ref),
  };

  const store: BotStore = {
    createSubmission: () => Promise.resolve({ id: "sub-1" }),
    updateSubmission: (_id, fields) => {
      submissionUpdates.push(fields);
      return Promise.resolve();
    },
    findVideoByUrl: (videoUrl) =>
      Promise.resolve(
        options.video && options.video.videoUrl === videoUrl
          ? options.video
          : null,
      ),
    findVideosByVideoId: () => Promise.resolve([]),
    listSubmissions: () => Promise.resolve([]),
    searchVideos: () => Promise.resolve([]),
    findPlaylistByUrl: () => Promise.resolve(options.playlist ?? null),
    listPlaylists: () =>
      Promise.resolve(options.playlist ? [options.playlist] : []),
    listPlaylistVideos: (_url, start, limit) =>
      Promise.resolve({
        total: entries.length,
        items: entries.slice(start, start + limit),
      }),
    findSubmissionByPrefix: () => Promise.resolve(null),
    purgeVideoFiles: () => Promise.resolve(true),
  };

  const events = createEventBus();

  const core = createBotCore({
    adapters: [adapter],
    events,
    delivery: {
      deliver: (request: { fileName: string }) => {
        delivered.push(request.fileName);
        return Promise.resolve({ mode: "upload" as const, sizeBytes: 1 });
      },
      buildSignedUrl: () => "https://example.test/f",
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: (items) => {
      listings.push({
        url: items[0].url,
        type: items[0].type,
        currentMonitoringType: items[0].currentMonitoringType,
      });
      options.duringListing?.(events);
      return Promise.resolve([{
        url: items[0].url,
        status: options.listingStatus ?? "completed",
      }]);
    },
    resolveAndEnqueue: (urls) => {
      enqueued.push(urls[0]);
      return Promise.resolve({
        items: [{ url: urls[0], queuePosition: 1 }],
        notIndexed: [],
      });
    },
    getQueueSnapshot: () => [],
    getListingQueueDepth: () => 0,
    setPlaylistMonitoring: (url, monitoringType) => {
      monitoringSet.push({ url, monitoringType });
      return Promise.resolve();
    },
    store,
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: (url: string) => url.includes("playlist?list="),
    allowedChatIds: [CHAT],
    maxPendingPerChat: 5,
    retentionMode: "ephemeral",
    retentionHours: 24,
    saveLocation: "/nonexistent",
    chunkSize: 10,
    largeFileWarnBytes: 104857600,
  });
  core.subscribe();

  const message = (text: string): IncomingMessage => ({
    platform: "telegram",
    chatId: CHAT,
    messageId: "10",
    text,
  });

  return {
    handle: (text: string) => core.handleMessage(message(text)),
    events,
    listings,
    enqueued,
    delivered,
    monitoringSet,
    submissionUpdates,
    sent,
    edits,
  };
}

function playlistRow(overrides: Partial<PlaylistRecord> = {}): PlaylistRecord {
  return {
    playlistUrl: PLAYLIST,
    title: "Test Playlist",
    monitoringType: "N/A",
    videoCount: 3,
    ...overrides,
  };
}

Deno.test("bare playlist link - says it is a playlist before listing", async () => {
  // The complaint this fixes: a pasted playlist link looked identical to a
  // video submission, went quiet for minutes, and then failed with "produced
  // no video entry" because a playlist has no single video row to download.
  const h = harness({ playlist: playlistRow() });

  await h.handle(PLAYLIST);

  assertStringIncludes(h.sent[0], "playlist");
  assertStringIncludes(h.sent[0], "Nothing gets downloaded");
  // Said up front, not after the listing finished.
  assertEquals(h.listings.length, 1);
  assertEquals(h.enqueued, []);
  assertEquals(h.delivered, []);
});

Deno.test("bare playlist link - indexes with the watch mode set to N/A", async () => {
  // "None" is the pseudo-playlist's URL, not a monitoring type; storing it as
  // one leaves a playlist whose watch mode the web UI does not recognise.
  const h = harness({ playlist: playlistRow() });

  await h.handle(PLAYLIST);

  assertEquals(h.listings[0].type, "playlist");
  assertEquals(h.listings[0].currentMonitoringType, "N/A");
  assertEquals(h.monitoringSet, []);
});

Deno.test("bare playlist link - reports the count and how to browse it", async () => {
  const h = harness({ playlist: playlistRow({ videoCount: 42 }) });

  await h.handle(PLAYLIST);

  const final = h.edits.at(-1) ?? "";
  assertStringIncludes(final, "Test Playlist");
  assertStringIncludes(final, "42 entries");
  assertStringIncludes(final, "watch mode: N/A");
  assertStringIncludes(final, `/list ${PLAYLIST}`);
});

Deno.test("bare playlist link - an already-indexed playlist is not an error", async () => {
  // Re-listing a playlist at the same watch mode returns "No items found".
  // The playlist is right there in the database, so that is not a failure.
  const h = harness({
    playlist: playlistRow({ videoCount: 7 }),
    listingStatus: "failed",
  });

  await h.handle(PLAYLIST);

  const final = h.edits.at(-1) ?? "";
  assertStringIncludes(final, "7 entries");
  assert(!final.includes("Couldn't index"), `unexpected failure: ${final}`);
});

Deno.test("bare playlist link - an unindexable playlist still reports the failure", async () => {
  const h = harness({ playlist: null, listingStatus: "failed" });

  await h.handle(PLAYLIST);

  assertStringIncludes(h.edits.at(-1) ?? "", "Couldn't index that playlist");
});

function chunkEvent(processedChunks: number) {
  return {
    url: PLAYLIST,
    type: "playlist-chunk",
    status: "chunk-completed",
    processedChunks,
    playlistTitle: "Test Playlist",
    seekPlaylistListTo: 0,
  };
}

Deno.test("playlist listing - chunk events become progress messages", async () => {
  const h = harness({
    playlist: playlistRow(),
    duringListing: (events) =>
      events.emit("listing-playlist-chunk-complete", chunkEvent(3)),
  });

  await h.handle(PLAYLIST);

  // chunkSize is 10 in this harness, so three chunks is about 30 entries.
  assert(
    h.edits.some((edit) => edit.includes("about 30 entries so far")),
    `no progress edit in ${JSON.stringify(h.edits)}`,
  );
});

Deno.test("playlist listing - a heartbeat does not fire twice in a row", async () => {
  const h = harness({
    playlist: playlistRow(),
    duringListing: (events) => {
      for (const processedChunks of [1, 2, 3]) {
        events.emit(
          "listing-playlist-chunk-complete",
          chunkEvent(processedChunks),
        );
      }
    },
  });

  await h.handle(PLAYLIST);

  // Telegram rate-limits edits hard, so a burst of chunks is one message.
  const progress = h.edits.filter((edit) => edit.includes("entries so far"));
  assertEquals(progress.length, 1);
});

Deno.test("/index playlist Start - sets the monitoring type", async () => {
  const h = harness({ playlist: playlistRow({ monitoringType: "Start" }) });

  await h.handle(`/index ${PLAYLIST} start`);

  assertEquals(h.listings[0].currentMonitoringType, "Start");
  assertEquals(h.monitoringSet, [{ url: PLAYLIST, monitoringType: "Start" }]);
  assertStringIncludes(h.edits.at(-1) ?? "", "watch mode: Start");
});

Deno.test("/index playlist with no mode - leaves the watch mode at N/A", async () => {
  const h = harness({ playlist: playlistRow() });

  await h.handle(`/index ${PLAYLIST}`);

  assertEquals(h.listings[0].currentMonitoringType, "N/A");
  assertEquals(h.monitoringSet, []);
  assertStringIncludes(h.edits.at(-1) ?? "", "watch mode: N/A");
});

Deno.test("/list - pages through a playlist's entries", async () => {
  const h = harness({
    playlist: playlistRow({ videoCount: 3 }),
    entries: [
      {
        position: 1,
        title: "One",
        videoUrl: `${VIDEO}1`,
        downloadStatus: true,
      },
      {
        position: 2,
        title: "Two",
        videoUrl: `${VIDEO}2`,
        downloadStatus: false,
      },
      {
        position: 3,
        title: "Three",
        videoUrl: `${VIDEO}3`,
        downloadStatus: false,
      },
    ],
  });

  await h.handle(`/list ${PLAYLIST} 0 2`);

  const page = h.sent.at(-1) ?? "";
  assertStringIncludes(page, "showing 1-2 of 3");
  assertStringIncludes(page, "[saved] One");
  assertStringIncludes(page, "[not downloaded] Two");
  assert(!page.includes("Three"), "page should stop at the limit");
  // The next page is spelled out so it can be tapped rather than composed.
  assertStringIncludes(page, `Next: /list ${PLAYLIST} 2 2`);
});

Deno.test("/list - the last page offers no next page", async () => {
  const h = harness({
    playlist: playlistRow({ videoCount: 1 }),
    entries: [
      { position: 1, title: "One", videoUrl: VIDEO, downloadStatus: false },
    ],
  });

  await h.handle(`/list ${PLAYLIST}`);

  const page = h.sent.at(-1) ?? "";
  assertStringIncludes(page, "showing 1-1 of 1");
  assert(!page.includes("Next:"), "there is nothing after the last entry");
});

Deno.test("/list - an unindexed playlist says so instead of showing nothing", async () => {
  const h = harness({ playlist: null });

  await h.handle(`/list ${PLAYLIST}`);

  assertStringIncludes(h.sent.at(-1) ?? "", "haven't indexed that playlist");
});

Deno.test("/list with no URL - lists the known playlists", async () => {
  const h = harness({ playlist: playlistRow({ monitoringType: "End" }) });

  await h.handle("/list");

  const index = h.sent.at(-1) ?? "";
  assertStringIncludes(index, "Test Playlist");
  assertStringIncludes(index, "3 entries");
  assertStringIncludes(index, "watch: End");
  assertStringIncludes(index, PLAYLIST);
});

Deno.test("/download - queues the video but sends no file", async () => {
  const h = harness({
    video: {
      videoUrl: VIDEO,
      videoId: "abc123",
      title: "A video",
      downloadStatus: false,
      fileName: null,
      saveDirectory: null,
      approximateSize: 0,
    },
  });

  await h.handle(`/download ${VIDEO}`);
  h.events.emit("download-done", {
    url: VIDEO,
    saveDirectory: "dir",
    title: "A video",
    fileName: "a-video.mp4",
  });
  // The delivery decision is made in a floating promise off the event handler.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(h.enqueued, [VIDEO]);
  assertEquals(h.delivered, []);
  assertStringIncludes(h.edits.at(-1) ?? "", "Downloaded: A video");

  // Recorded as downloaded rather than delivered, which is also what keeps the
  // reaper away from it — it only ever looks at delivered submissions.
  const outcome = h.submissionUpdates.at(-1) ?? {};
  assertEquals(outcome.status, "downloaded");
  assertEquals(outcome.deliveryMode, "none");
  assertEquals(outcome.retention, "persistent");
  assertEquals(outcome.expiresAt, null);
});

Deno.test("/download - a playlist link is still indexed, not downloaded", async () => {
  const h = harness({ playlist: playlistRow() });

  await h.handle(`/download ${PLAYLIST}`);

  assertEquals(h.enqueued, []);
  assertEquals(h.listings[0].currentMonitoringType, "N/A");
});
