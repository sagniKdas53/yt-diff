import { assertEquals } from "std/assert/mod.ts";
import {
  cleanupStaleProcesses,
  truncateText,
  urlToTitle,
} from "../src/handlers/pipeline/process-manager.ts";
import type { ProcessLike } from "../src/handlers/pipeline/types.ts";

Deno.test("process-manager - urlToTitle extracts path slug as title", () => {
  assertEquals(
    urlToTitle("https://www.youtube.com/channel/some-channel"),
    "some-channel",
  );
  assertEquals(
    urlToTitle("https://example.com/nested/path/slug"),
    "nested_path_slug",
  );
  assertEquals(
    urlToTitle("invalid-url"),
    "invalid-url",
  );
});

Deno.test("process-manager - truncateText bounds long text safely", () => {
  assertEquals(truncateText("hello world", 5), "hello");
  assertEquals(truncateText("hello", 10), "hello");
  assertEquals(truncateText("", 10), "");
});

/**
 * The cleanup job used to only look at entries whose status was "running".
 * A listing takes its semaphore slot and sits at "pending" until yt-dlp is
 * spawned, so a run that wedged before that point was invisible: on
 * 2026-09-04 two cleanup passes logged the same `status: "pending"` entry and
 * reported "Cleaned up 0 processes" while it held the only listing slot.
 */
function entry(overrides: Partial<ProcessLike> = {}): ProcessLike {
  const now = Date.now();
  return {
    status: "running",
    spawnType: "list",
    lastActivity: now,
    lastStdoutActivity: now,
    spawnTimeStamp: now,
    spawnedProcess: null,
    ...overrides,
  };
}

function ago(ms: number) {
  return Date.now() - ms;
}

Deno.test("cleanupStaleProcesses - a pending entry past the idle limit is reaped", () => {
  const stale = ago(20 * 60 * 1000);
  const map = new Map<string, ProcessLike>([
    [
      "pending_playlist_1",
      entry({
        status: "pending",
        lastActivity: stale,
        lastStdoutActivity: stale,
        spawnTimeStamp: stale,
      }),
    ],
  ]);

  const cleaned = cleanupStaleProcesses(
    map,
    { maxIdleTime: 5 * 60 * 1000, maxLifetime: 15 * 60 * 1000 },
    "list",
  );

  assertEquals(cleaned, 1);
  assertEquals(map.size, 0);
});

Deno.test("cleanupStaleProcesses - an errored entry is reaped on the same clocks", () => {
  const stale = ago(20 * 60 * 1000);
  const map = new Map<string, ProcessLike>([
    [
      "errored_1",
      entry({
        status: "errored",
        lastActivity: stale,
        lastStdoutActivity: stale,
        spawnTimeStamp: stale,
      }),
    ],
  ]);

  const cleaned = cleanupStaleProcesses(
    map,
    { maxIdleTime: 5 * 60 * 1000, maxLifetime: 15 * 60 * 1000 },
    "list",
  );

  assertEquals(cleaned, 1);
  assertEquals(map.size, 0);
});

Deno.test("cleanupStaleProcesses - a young pending entry is left alone", () => {
  // Every listing passes through "pending" on its way to spawning. Reaping
  // one that has only just started would kill work that is about to happen.
  const map = new Map<string, ProcessLike>([
    ["pending_playlist_1", entry({ status: "pending" })],
  ]);

  const cleaned = cleanupStaleProcesses(
    map,
    { maxIdleTime: 5 * 60 * 1000, maxLifetime: 15 * 60 * 1000 },
    "list",
  );

  assertEquals(cleaned, 0);
  assertEquals(map.size, 1);
});

Deno.test("cleanupStaleProcesses - a stale entry's process is killed when asked", () => {
  const stale = ago(20 * 60 * 1000);
  const signals: string[] = [];
  const map = new Map<string, ProcessLike>([
    [
      "pending_playlist_1",
      entry({
        status: "pending",
        lastActivity: stale,
        lastStdoutActivity: stale,
        spawnTimeStamp: stale,
        spawnedProcess: {
          kill: (signal: string) => {
            signals.push(signal);
            return true;
          },
        },
      }),
    ],
  ]);

  cleanupStaleProcesses(
    map,
    {
      maxIdleTime: 5 * 60 * 1000,
      maxLifetime: 15 * 60 * 1000,
      forceKill: true,
    },
    "list",
  );

  assertEquals(signals, ["SIGKILL"]);
  assertEquals(map.size, 0);
});

Deno.test("cleanupStaleProcesses - a list process still producing output is spared", () => {
  // A long playlist listing is old but not idle; killing it would throw away
  // an hour of ingest because it took an hour.
  const map = new Map<string, ProcessLike>([
    [
      "running_1",
      entry({
        status: "running",
        lastActivity: Date.now(),
        lastStdoutActivity: Date.now(),
        spawnTimeStamp: ago(60 * 60 * 1000),
      }),
    ],
  ]);

  const cleaned = cleanupStaleProcesses(
    map,
    { maxIdleTime: 5 * 60 * 1000, maxLifetime: 15 * 60 * 1000 },
    "list",
  );

  assertEquals(cleaned, 0);
  assertEquals(map.size, 1);
});
