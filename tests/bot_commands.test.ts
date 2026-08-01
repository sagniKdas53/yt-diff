import { assertEquals } from "std/assert/mod.ts";
import { parseCommand } from "../src/bot/commands.ts";

Deno.test("parseCommand - a bare URL is a get", () => {
  assertEquals(
    parseCommand("https://www.youtube.com/shorts/abc123"),
    { kind: "get", url: "https://www.youtube.com/shorts/abc123" },
  );
});

Deno.test("parseCommand - non-URL chatter is ignored, not an error", () => {
  // Replying to every stray message would make the bot noisy in a group.
  assertEquals(parseCommand("good morning"), { kind: "ignore" });
  assertEquals(parseCommand("   "), { kind: "ignore" });
  assertEquals(parseCommand(""), { kind: "ignore" });
});

Deno.test("parseCommand - non-http schemes are not URLs", () => {
  assertEquals(parseCommand("file:///etc/passwd"), { kind: "ignore" });
  assertEquals(parseCommand("javascript:alert(1)"), { kind: "ignore" });
});

Deno.test("parseCommand - /get and /link", () => {
  assertEquals(
    parseCommand("/get https://x.com/i/status/1"),
    { kind: "get", url: "https://x.com/i/status/1" },
  );
  assertEquals(
    parseCommand("/link https://x.com/i/status/1"),
    { kind: "link", url: "https://x.com/i/status/1" },
  );
});

Deno.test("parseCommand - strips the @botname suffix used in groups", () => {
  assertEquals(
    parseCommand("/get@yt_diff_bot https://x.com/i/status/1"),
    { kind: "get", url: "https://x.com/i/status/1" },
  );
  assertEquals(parseCommand("/status@yt_diff_bot"), { kind: "status" });
});

Deno.test("parseCommand - a command needing a URL rejects a missing one", () => {
  assertEquals(parseCommand("/get"), { kind: "unknown", text: "/get" });
  assertEquals(
    parseCommand("/get not-a-url"),
    { kind: "unknown", text: "/get not-a-url" },
  );
});

Deno.test("parseCommand - /index with no mode is catalogue-only", () => {
  // No monitoring: index into "None" so it is searchable, but do not download
  // and do not schedule updates.
  assertEquals(
    parseCommand("/index https://www.youtube.com/watch?v=abc"),
    {
      kind: "index",
      url: "https://www.youtube.com/watch?v=abc",
      monitoringType: null,
    },
  );
});

Deno.test("parseCommand - /index accepts a mode case-insensitively", () => {
  assertEquals(
    parseCommand("/index https://youtube.com/playlist?list=PL1 start"),
    {
      kind: "index",
      url: "https://youtube.com/playlist?list=PL1",
      monitoringType: "Start",
    },
  );
});

Deno.test("parseCommand - /index rejects an unknown mode", () => {
  const text = "/index https://youtube.com/playlist?list=PL1 sometimes";
  assertEquals(parseCommand(text), { kind: "unknown", text });
});

Deno.test("parseCommand - /watch is gone", () => {
  const text = "/watch https://youtube.com/playlist?list=PL1";
  assertEquals(parseCommand(text), { kind: "unknown", text });
});

Deno.test("parseCommand - /search takes a free-text query", () => {
  assertEquals(parseCommand("/search cat videos"), {
    kind: "search",
    query: "cat videos",
    limit: 10,
  });
  // A URL is a perfectly good search term too.
  assertEquals(parseCommand("/search https://x.com/a/status/1"), {
    kind: "search",
    query: "https://x.com/a/status/1",
    limit: 10,
  });
});

Deno.test("parseCommand - /search with no query is rejected", () => {
  assertEquals(parseCommand("/search"), { kind: "unknown", text: "/search" });
  assertEquals(parseCommand("/search    "), {
    kind: "unknown",
    text: "/search",
  });
});

Deno.test("parseCommand - /keep and /rm need an id", () => {
  assertEquals(parseCommand("/keep abc123"), { kind: "keep", id: "abc123" });
  assertEquals(parseCommand("/rm abc123"), { kind: "remove", id: "abc123" });
  assertEquals(parseCommand("/keep"), { kind: "unknown", text: "/keep" });
});

Deno.test("parseCommand - /history clamps and defaults its limit", () => {
  assertEquals(parseCommand("/history"), { kind: "history", limit: 10 });
  assertEquals(parseCommand("/history 3"), { kind: "history", limit: 3 });
  // Clamped so one message cannot try to dump the whole table.
  assertEquals(parseCommand("/history 9999"), { kind: "history", limit: 50 });
  assertEquals(parseCommand("/history nonsense"), {
    kind: "history",
    limit: 10,
  });
  assertEquals(parseCommand("/history -5"), { kind: "history", limit: 10 });
});

Deno.test("parseCommand - /help and /start both show help", () => {
  assertEquals(parseCommand("/help"), { kind: "help" });
  assertEquals(parseCommand("/start"), { kind: "help" });
});

Deno.test("parseCommand - an unknown command is reported", () => {
  assertEquals(parseCommand("/frobnicate"), {
    kind: "unknown",
    text: "/frobnicate",
  });
});
