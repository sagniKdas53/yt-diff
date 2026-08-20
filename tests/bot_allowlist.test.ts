import { assertEquals } from "std/assert/mod.ts";
import { createBotCore } from "../src/bot/core.ts";
import type {
  BotAdapter,
  IncomingMessage,
  MessageRef,
} from "../src/bot/types.ts";
import { createEventBus } from "../src/events.ts";

interface SpyAdapter {
  adapter: BotAdapter;
  sent: string[];
  edits: string[];
  files: string[];
}

function spyAdapter(): SpyAdapter {
  const sent: string[] = [];
  const edits: string[] = [];
  const files: string[] = [];

  const ref: MessageRef = {
    platform: "telegram",
    chatId: "1",
    messageId: "1",
  };

  return {
    sent,
    edits,
    files,
    adapter: {
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
      sendFile: (_to, absPath) => {
        files.push(absPath);
        return Promise.resolve(ref);
      },
    },
  };
}

/**
 * Builds a core whose pipeline dependencies all throw.
 *
 * Any call to them from a rejected message would surface as a test failure
 * rather than passing silently.
 */
function coreWith(allowedChatIds: string[], spy: SpyAdapter) {
  const touched: string[] = [];
  const explode = (name: string) => () => {
    touched.push(name);
    throw new Error(`${name} must not be called`);
  };

  const core = createBotCore({
    adapters: [spy.adapter],
    events: createEventBus(),
    delivery: {
      deliver: explode("deliver"),
      buildSignedUrl: explode("buildSignedUrl"),
    } as unknown as Parameters<typeof createBotCore>[0]["delivery"],
    listItemsConcurrently: explode("listItemsConcurrently"),
    resolveAndEnqueue: explode("resolveAndEnqueue"),
    getQueueSnapshot: explode("getQueueSnapshot"),
    getListingQueueDepth: () => 0,
    setPlaylistMonitoring: explode("setPlaylistMonitoring"),
    // Every store method throws too, so a rejected message touching the
    // database at all would surface as a failure rather than passing quietly.
    store: {
      createSubmission: explode("createSubmission"),
      updateSubmission: explode("updateSubmission"),
      findVideoByUrl: explode("findVideoByUrl"),
      findVideosByVideoId: explode("findVideosByVideoId"),
      listSubmissions: explode("listSubmissions"),
      searchVideos: explode("searchVideos"),
      findPlaylistByUrl: explode("findPlaylistByUrl"),
      listPlaylists: explode("listPlaylists"),
      listPlaylistVideos: explode("listPlaylistVideos"),
      findSubmissionByPrefix: explode("findSubmissionByPrefix"),
      purgeVideoFiles: explode("purgeVideoFiles"),
    } as unknown as Parameters<typeof createBotCore>[0]["store"],
    normalizeUrl: (url: string) => url,
    isPlaylistUrl: () => false,
    allowedChatIds,
    maxPendingPerChat: 5,
    retentionMode: "ephemeral",
    retentionHours: 24,
    saveLocation: "/tmp",
    chunkSize: 10,
    largeFileWarnBytes: 104857600,
  });

  return { core, touched };
}

function message(chatId: string, text: string): IncomingMessage {
  return { platform: "telegram", chatId, messageId: "10", text };
}

Deno.test("allowlist - a non-allowlisted chat gets no reply at all", async () => {
  const spy = spyAdapter();
  const { core, touched } = coreWith(["1391594622"], spy);

  await core.handleMessage(
    message("999", "https://www.youtube.com/watch?v=abc"),
  );

  // Silence is deliberate: an "unauthorized" reply confirms the bot exists to
  // anyone probing for it.
  assertEquals(spy.sent, []);
  assertEquals(spy.edits, []);
  assertEquals(spy.files, []);
  assertEquals(touched, []);
});

Deno.test("allowlist - commands from a non-allowlisted chat are dropped too", async () => {
  const spy = spyAdapter();
  const { core, touched } = coreWith(["1391594622"], spy);

  for (const text of ["/help", "/status", "/history", "/rm abc"]) {
    await core.handleMessage(message("999", text));
  }

  assertEquals(spy.sent, []);
  assertEquals(touched, []);
});

Deno.test("allowlist - an empty allowlist rejects everyone", async () => {
  const spy = spyAdapter();
  const { core } = coreWith([], spy);

  await core.handleMessage(message("1391594622", "/help"));

  assertEquals(spy.sent, []);
});

Deno.test("allowlist - an allowlisted chat is served", async () => {
  const spy = spyAdapter();
  const { core } = coreWith(["1391594622"], spy);

  await core.handleMessage(message("1391594622", "/help"));

  assertEquals(spy.sent.length, 1);
});

Deno.test("allowlist - chat ids are matched exactly, not by prefix", async () => {
  const spy = spyAdapter();
  const { core } = coreWith(["139"], spy);

  await core.handleMessage(message("1391594622", "/help"));

  assertEquals(spy.sent, []);
});

Deno.test("allowlist - unparseable chatter from an allowed chat stays silent", async () => {
  const spy = spyAdapter();
  const { core, touched } = coreWith(["1391594622"], spy);

  await core.handleMessage(message("1391594622", "good morning"));

  // Ignored rather than answered, so the bot is quiet in a busy group.
  assertEquals(spy.sent, []);
  assertEquals(touched, []);
});
