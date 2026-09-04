import { assert, assertEquals } from "std/assert/mod.ts";
import { createMessageDispatcher } from "../src/bot/dispatcher.ts";
import type { IncomingMessage } from "../src/bot/types.ts";

/**
 * What broke on 2026-09-04: grammy awaits the update handler before fetching
 * the next batch, the handler awaited a playlist index, the index wedged, and
 * every message sent afterwards was never even fetched. The dispatcher is the
 * seam that makes "accepted" and "handled" two different moments.
 */

function message(text: string, chatId = "1"): IncomingMessage {
  return { platform: "telegram", chatId, messageId: text, text };
}

/** A handler whose completions the test controls, one message at a time. */
function gatedHandler() {
  const started: string[] = [];
  const release = new Map<string, () => void>();

  const handle = (msg: IncomingMessage) => {
    started.push(msg.text);
    return new Promise<void>((resolve) => release.set(msg.text, resolve));
  };

  return {
    handle,
    started,
    finish(text: string) {
      const resolve = release.get(text);
      assert(resolve, `${text} was never started`);
      resolve();
      release.delete(text);
      // One turn, so the dispatcher's `finally` runs before the test looks.
      return new Promise<void>((r) => setTimeout(r, 0));
    },
  };
}

Deno.test("dispatcher - accepting a message does not wait for it to be handled", async () => {
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 2,
    handle: gate.handle,
  });

  // Resolves even though the handler is still parked, which is the whole
  // contract: the platform's polling loop gets its turn back immediately.
  await dispatcher.dispatch(message("first"));

  assertEquals(gate.started, ["first"]);
  assertEquals(dispatcher.inFlight, 1);

  await gate.finish("first");
  await dispatcher.drain();
});

Deno.test("dispatcher - a stuck message does not stop the next one", async () => {
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 5,
    handle: gate.handle,
  });

  await dispatcher.dispatch(message("wedged-playlist"));
  await dispatcher.dispatch(message("iwara-link"));
  await dispatcher.dispatch(message("x-link"));

  // The first is still parked; the other two ran anyway.
  assertEquals(gate.started, ["wedged-playlist", "iwara-link", "x-link"]);

  await gate.finish("iwara-link");
  await gate.finish("x-link");
  await gate.finish("wedged-playlist");
  await dispatcher.drain();
});

Deno.test("dispatcher - concurrency is bounded and the rest queue in order", async () => {
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 2,
    handle: gate.handle,
  });

  for (const text of ["a", "b", "c", "d"]) {
    await dispatcher.dispatch(message(text));
  }

  assertEquals(gate.started, ["a", "b"]);
  assertEquals(dispatcher.queueDepth, 2);

  await gate.finish("a");
  assertEquals(gate.started, ["a", "b", "c"]);

  await gate.finish("b");
  assertEquals(gate.started, ["a", "b", "c", "d"]);
  assertEquals(dispatcher.queueDepth, 0);

  await gate.finish("c");
  await gate.finish("d");
  await dispatcher.drain();
});

Deno.test("dispatcher - nothing is dropped when more arrive than can run", async () => {
  // "Send as many as you like": a burst is a backlog, not a refusal.
  const handled: string[] = [];
  const dispatcher = createMessageDispatcher({
    concurrency: 3,
    handle: (msg) => {
      handled.push(msg.text);
      return Promise.resolve();
    },
  });

  const sent = Array.from({ length: 50 }, (_v, i) => `msg-${i}`);
  for (const text of sent) {
    await dispatcher.dispatch(message(text));
  }
  await dispatcher.drain();

  assertEquals(handled, sent);
});

Deno.test("dispatcher - a throwing handler frees its slot", async () => {
  // An unhandled rejection ends the Deno process, and a leaked slot would
  // shrink the pool one failure at a time until the bot went quiet again.
  const handled: string[] = [];
  const dispatcher = createMessageDispatcher({
    concurrency: 1,
    handle: (msg) => {
      handled.push(msg.text);
      return msg.text === "boom"
        ? Promise.reject(new Error("handler blew up"))
        : Promise.resolve();
    },
  });

  await dispatcher.dispatch(message("boom"));
  await dispatcher.dispatch(message("after"));
  await dispatcher.drain();

  assertEquals(handled, ["boom", "after"]);
  assertEquals(dispatcher.inFlight, 0);
});

Deno.test("dispatcher - drain waits for the backlog, not just the in-flight", async () => {
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 1,
    handle: gate.handle,
  });

  await dispatcher.dispatch(message("running"));
  await dispatcher.dispatch(message("queued"));

  let drained = false;
  const draining = dispatcher.drain().then(() => (drained = true));

  await gate.finish("running");
  assert(!drained, "drain must not resolve while a queued message remains");

  await gate.finish("queued");
  await draining;
  assert(drained);
});

Deno.test("dispatcher - concurrency below one still runs messages", () => {
  const handled: string[] = [];
  const dispatcher = createMessageDispatcher({
    concurrency: 0,
    handle: (msg) => {
      handled.push(msg.text);
      return Promise.resolve();
    },
  });

  dispatcher.dispatch(message("only"));

  assertEquals(handled, ["only"]);
  return dispatcher.drain();
});

Deno.test("dispatcher - a question is answered while the slow lane is full", () => {
  // Twenty links can occupy every slot for minutes. /status is a database read
  // and a reply; making it wait behind them is how the bot looks hung even
  // when it is working perfectly.
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 1,
    handle: gate.handle,
    isSlow: (msg) => !msg.text.startsWith("/"),
  });

  dispatcher.dispatch(message("https://example.com/video-1"));
  dispatcher.dispatch(message("https://example.com/video-2"));
  dispatcher.dispatch(message("/status"));

  // The second link is queued behind the first; the question is not.
  assertEquals(gate.started, ["https://example.com/video-1", "/status"]);
  assertEquals(dispatcher.queueDepth, 1);

  return (async () => {
    await gate.finish("/status");
    await gate.finish("https://example.com/video-1");
    await gate.finish("https://example.com/video-2");
    await dispatcher.drain();
  })();
});

Deno.test("dispatcher - drain waits for the quick lane too", async () => {
  const gate = gatedHandler();
  const dispatcher = createMessageDispatcher({
    concurrency: 1,
    handle: gate.handle,
    isSlow: () => false,
  });

  dispatcher.dispatch(message("/status"));
  assertEquals(dispatcher.inFlight, 1);

  let drained = false;
  const draining = dispatcher.drain().then(() => (drained = true));
  assert(!drained, "drain must not resolve while a quick message is running");

  await gate.finish("/status");
  await draining;
  assertEquals(dispatcher.inFlight, 0);
});
