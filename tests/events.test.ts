import { assertEquals } from "std/assert/mod.ts";
import {
  type AppEventName,
  createEventBus,
  isAppEventName,
} from "../src/events.ts";

Deno.test("events - emit delivers the payload to every subscriber", () => {
  const bus = createEventBus();
  const seen: string[] = [];

  bus.on("download-done", (payload) => seen.push(`a:${payload.url}`));
  bus.on("download-done", (payload) => seen.push(`b:${payload.url}`));

  bus.emit("download-done", { url: "https://x.test/1", saveDirectory: "d" });

  assertEquals(seen, ["a:https://x.test/1", "b:https://x.test/1"]);
});

Deno.test("events - off removes only the given handler", () => {
  const bus = createEventBus();
  const seen: string[] = [];

  const keep = () => seen.push("keep");
  const drop = () => seen.push("drop");

  bus.on("listing-error", keep);
  bus.on("listing-error", drop);
  bus.off("listing-error", drop);

  bus.emit("listing-error", { url: "https://x.test/1", error: "boom" });

  assertEquals(seen, ["keep"]);
  assertEquals(bus.listenerCount("listing-error"), 1);
});

Deno.test("events - a throwing handler does not stop the others", () => {
  const bus = createEventBus();
  const seen: string[] = [];

  bus.on("download-failed", () => {
    throw new Error("handler exploded");
  });
  bus.on("download-failed", () => seen.push("second"));

  // Must not propagate: an emit site inside the pipeline cannot be allowed to
  // fail because a consumer misbehaved.
  bus.emit("download-failed", { url: "https://x.test/1", error: "nope" });

  assertEquals(seen, ["second"]);
});

Deno.test("events - a rejecting async handler is swallowed", async () => {
  const bus = createEventBus();

  bus.on("download-started", () => Promise.reject(new Error("async boom")));
  bus.emit("download-started", { url: "https://x.test/1", percentage: 101 });

  // Yield so the rejection would surface as unhandled if it were not caught.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("events - a handler unsubscribing mid-dispatch is safe", () => {
  const bus = createEventBus();
  const seen: string[] = [];

  const once = () => {
    seen.push("once");
    bus.off("download-done", once);
  };

  bus.on("download-done", once);
  bus.on("download-done", () => seen.push("other"));

  bus.emit("download-done", { url: "https://x.test/1", saveDirectory: "d" });
  bus.emit("download-done", { url: "https://x.test/2", saveDirectory: "d" });

  assertEquals(seen, ["once", "other", "other"]);
});

Deno.test("events - emit with no subscribers is a no-op", () => {
  const bus = createEventBus();
  bus.emit("download-done", { url: "https://x.test/1", saveDirectory: "d" });
  assertEquals(bus.listenerCount("download-done"), 0);
});

Deno.test("events - isAppEventName gates the safeEmit fan-out", () => {
  const known: AppEventName[] = [
    "download-started",
    "downloading-percent-update",
    "download-done",
    "download-failed",
    "listing-error",
  ];

  for (const event of known) {
    assertEquals(isAppEventName(event), true);
  }

  // Socket-only UI chatter must not reach the bus.
  assertEquals(isAppEventName("playlist-sorted"), false);
  assertEquals(isAppEventName(""), false);
});
