import { assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import {
  buildExpiredSubmissionWhere,
  MONITORED_TYPES,
  type ReapCandidate,
  reapExpiredSubmissions,
  type RetentionStore,
} from "../src/bot/retention.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");

interface Calls {
  purged: string[];
  markedReaped: string[];
  monitoredChecked: string[];
}

interface FakeOptions {
  candidates?: ReapCandidate[];
  monitored?: string[];
  /** videoUrl -> downloadStatus, or absent for "no row". */
  downloadStatus?: Record<string, boolean>;
  /** videoUrls whose purge should fail. */
  purgeFails?: string[];
  /** videoUrls whose monitored-check should throw. */
  throwOn?: string[];
}

function fakeStore(opts: FakeOptions = {}): {
  store: RetentionStore;
  calls: Calls;
} {
  const calls: Calls = { purged: [], markedReaped: [], monitoredChecked: [] };

  const store: RetentionStore = {
    findExpiredSubmissions: () => Promise.resolve(opts.candidates ?? []),
    isInMonitoredPlaylist: (videoUrl) => {
      calls.monitoredChecked.push(videoUrl);
      if (opts.throwOn?.includes(videoUrl)) {
        return Promise.reject(new Error("db exploded"));
      }
      return Promise.resolve(opts.monitored?.includes(videoUrl) ?? false);
    },
    getDownloadStatus: (videoUrl) =>
      Promise.resolve(
        Object.hasOwn(opts.downloadStatus ?? {}, videoUrl)
          ? opts.downloadStatus![videoUrl]
          : null,
      ),
    purgeVideoFiles: (videoUrl) => {
      calls.purged.push(videoUrl);
      return Promise.resolve(!opts.purgeFails?.includes(videoUrl));
    },
    markReaped: (id) => {
      calls.markedReaped.push(id);
      return Promise.resolve();
    },
  };

  return { store, calls };
}

function candidate(id: string, url: string): ReapCandidate {
  return { id, canonicalUrl: url };
}

// ---------------------------------------------------------------------------
// Guards 1 and 2 live in the WHERE clause, not in control flow. A fake store
// would return whatever it is given regardless of what the real query filters,
// so the criteria are asserted directly.
// ---------------------------------------------------------------------------

Deno.test("reaper selection - only ever selects bot-downloaded files", () => {
  const where = buildExpiredSubmissionWhere(NOW);
  // The load-bearing guard: a file that already existed when the bot was asked
  // for it is recorded downloadedByBot=false and must be unreachable.
  assertEquals(where.downloadedByBot, true);
});

Deno.test("reaper selection - only delivered, ephemeral, expired rows", () => {
  const where = buildExpiredSubmissionWhere(NOW);
  assertEquals(where.status, "delivered");
  assertEquals(where.retention, "ephemeral");
  assertEquals(where.expiresAt[Op.lt], NOW);
  // A null expiresAt (persistent, or downloadedByBot=false) must not match.
  assertEquals(where.expiresAt[Op.ne], null);
  assertEquals(where.canonicalUrl[Op.ne], null);
});

Deno.test("reaper selection - a persistent submission cannot match", () => {
  // Belt and braces on the mode: persistent never even builds the cron job,
  // and its rows would not satisfy retention='ephemeral' anyway.
  assertEquals(buildExpiredSubmissionWhere(NOW).retention, "ephemeral");
});

// ---------------------------------------------------------------------------
// Guard 3 and the sweep's orchestration are ordinary control flow.
// ---------------------------------------------------------------------------

Deno.test("reaper - reaps an expired ephemeral bot download", async () => {
  const { store, calls } = fakeStore({
    candidates: [candidate("sub-1", "https://x.test/1")],
    downloadStatus: { "https://x.test/1": true },
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 1, reaped: 1, skipped: 0 });
  assertEquals(calls.purged, ["https://x.test/1"]);
  assertEquals(calls.markedReaped, ["sub-1"]);
});

Deno.test("reaper - skips a video in a monitored playlist", async () => {
  const { store, calls } = fakeStore({
    candidates: [candidate("sub-1", "https://x.test/1")],
    monitored: ["https://x.test/1"],
    downloadStatus: { "https://x.test/1": true },
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  // Otherwise the reaper and the scheduled-update job fight over the same file.
  assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
  assertEquals(calls.purged, []);
  assertEquals(calls.markedReaped, []);
});

Deno.test("reaper - skips a video with no row, closing the submission", async () => {
  const { store, calls } = fakeStore({
    candidates: [candidate("sub-1", "https://x.test/gone")],
    // No downloadStatus entry => no VideoMetadata row.
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
  assertEquals(calls.purged, []);
  // Nothing to delete, but the submission should not be reconsidered forever.
  assertEquals(calls.markedReaped, ["sub-1"]);
});

Deno.test("reaper - skips an already-reset row without purging", async () => {
  const { store, calls } = fakeStore({
    candidates: [candidate("sub-1", "https://x.test/1")],
    downloadStatus: { "https://x.test/1": false },
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
  assertEquals(calls.purged, []);
  assertEquals(calls.markedReaped, ["sub-1"]);
});

Deno.test("reaper - a failed purge leaves the submission for a retry", async () => {
  const { store, calls } = fakeStore({
    candidates: [candidate("sub-1", "https://x.test/1")],
    downloadStatus: { "https://x.test/1": true },
    purgeFails: ["https://x.test/1"],
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
  assertEquals(calls.purged, ["https://x.test/1"]);
  // Deliberately NOT marked reaped: the next sweep should try again.
  assertEquals(calls.markedReaped, []);
});

Deno.test("reaper - one failing submission does not abort the sweep", async () => {
  const { store, calls } = fakeStore({
    candidates: [
      candidate("sub-1", "https://x.test/boom"),
      candidate("sub-2", "https://x.test/2"),
    ],
    throwOn: ["https://x.test/boom"],
    downloadStatus: { "https://x.test/2": true },
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 2, reaped: 1, skipped: 1 });
  assertEquals(calls.markedReaped, ["sub-2"]);
});

Deno.test("reaper - a null canonicalUrl is skipped safely", async () => {
  const { store, calls } = fakeStore({
    candidates: [{ id: "sub-1", canonicalUrl: null }],
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
  assertEquals(calls.monitoredChecked, []);
  assertEquals(calls.purged, []);
});

Deno.test("reaper - an empty sweep is a clean no-op", async () => {
  const { store, calls } = fakeStore({ candidates: [] });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 0, reaped: 0, skipped: 0 });
  assertEquals(calls.purged, []);
  assertEquals(calls.markedReaped, []);
});

Deno.test("reaper - processes a mixed batch correctly", async () => {
  const { store, calls } = fakeStore({
    candidates: [
      candidate("sub-1", "https://x.test/reap-me"),
      candidate("sub-2", "https://x.test/monitored"),
      candidate("sub-3", "https://x.test/missing"),
      candidate("sub-4", "https://x.test/reap-me-too"),
    ],
    monitored: ["https://x.test/monitored"],
    downloadStatus: {
      "https://x.test/reap-me": true,
      "https://x.test/monitored": true,
      "https://x.test/reap-me-too": true,
    },
  });

  const summary = await reapExpiredSubmissions(NOW, store);

  assertEquals(summary, { considered: 4, reaped: 2, skipped: 2 });
  assertEquals(calls.purged, [
    "https://x.test/reap-me",
    "https://x.test/reap-me-too",
  ]);
});

Deno.test("reaper - MONITORED_TYPES matches the scheduled-update job", () => {
  // If these ever diverge, the reaper would delete files the update job is
  // actively maintaining.
  assertEquals(MONITORED_TYPES, ["Start", "End", "Full"]);
});
