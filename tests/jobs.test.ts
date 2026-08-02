import { assertEquals } from "std/assert/mod.ts";
import { createJobs } from "../src/jobs/index.ts";
import { PlaylistMetadata } from "../src/db/models.ts";
import type {
  ListingItem,
  ListingResult,
} from "../src/handlers/pipeline/types.ts";

/**
 * The scheduled updater reaches the DB through a direct module import rather
 * than an injected dependency, so the only seam is the model itself. findAll is
 * inherited from Sequelize's Model, so assigning here shadows it with an own
 * property and `delete` restores the prototype lookup. Importing the module
 * opens no connection — Sequelize is lazy until a query actually runs.
 */
function stubPlaylists(rows: Array<{ url: string; monitoringType: string }>) {
  const models = rows.map(({ url, monitoringType }) => ({
    getDataValue: (key: string) => key === "playlistUrl" ? url : monitoringType,
  }));
  // deno-lint-ignore no-explicit-any
  (PlaylistMetadata as any).findAll = () => Promise.resolve(models);
}

function restorePlaylists() {
  // deno-lint-ignore no-explicit-any
  delete (PlaylistMetadata as any).findAll;
}

interface ListingCall {
  items: ListingItem[];
  chunkSize: number;
  isScheduledUpdate: boolean;
}

/**
 * Fires one tick of the update cron against stubbed playlists and returns the
 * listing calls it made. The job body is a floating `void (async () => ...)()`,
 * so the tick returns before the work finishes and we poll for the result.
 * Every cron in the bag is stopped afterwards; createJobs arms them on
 * construction and leaked timers trip Deno's resource sanitizer.
 */
async function runUpdateTick(
  rows: Array<{ url: string; monitoringType: string }>,
): Promise<ListingCall[]> {
  stubPlaylists(rows);
  const calls: ListingCall[] = [];

  const jobs = createJobs({
    cleanupStaleProcesses: () => 0,
    downloadProcesses: new Map(),
    listProcesses: new Map(),
    listItemsConcurrently: (
      items: ListingItem[],
      chunkSize: number,
      isScheduledUpdate: boolean,
    ): Promise<ListingResult[]> => {
      calls.push({ items, chunkSize, isScheduledUpdate });
      return Promise.resolve([]);
    },
  });

  try {
    await jobs.update.fireOnTick();
    // Give the detached async body a bounded window to reach the spy.
    for (let i = 0; i < 100 && calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    for (const job of Object.values(jobs)) job?.stop();
    restorePlaylists();
  }

  return calls;
}

Deno.test("jobs - scheduled updates never opt into progress emits", async () => {
  const calls = await runUpdateTick([
    { url: "url_start", monitoringType: "Start" },
    { url: "url_end", monitoringType: "End" },
    { url: "url_full", monitoringType: "Full" },
  ]);

  assertEquals(calls.length, 1);
  const items = calls[0].items;
  assertEquals(items.length, 3);

  // This is the whole cron-silence guarantee. Progress emits in the listing
  // pipeline are gated on `!isScheduledUpdate || emitProgress === true`, so an
  // item carrying both flags would make the nightly cron broadcast to every
  // connected client. Batch re-index is the one caller that sets emitProgress;
  // see the "emits per-playlist progress" case in validation/api_test_e2e.ts.
  for (const item of items) {
    assertEquals(item.isScheduledUpdate, true);
    assertEquals(item.emitProgress, undefined);
  }
});

Deno.test("jobs - scheduled updates keep the isScheduledUpdate bypass flag", async () => {
  const calls = await runUpdateTick([
    { url: "url_full", monitoringType: "Full" },
  ]);

  // The third argument bypasses the "same monitoringType => skip" guard, so a
  // cron-driven refresh actually re-lists instead of short-circuiting.
  assertEquals(calls[0].isScheduledUpdate, true);
});

Deno.test("jobs - cheap incremental passes are queued ahead of full scans", async () => {
  const calls = await runUpdateTick([
    { url: "url_full", monitoringType: "Full" },
    { url: "url_end", monitoringType: "End" },
    { url: "url_start", monitoringType: "Start" },
  ]);

  // Deliberate ordering: Start/End are incremental, Full is a complete re-scan.
  // Submitted Full-first above to prove the job reorders rather than preserving
  // whatever order the DB returned.
  assertEquals(calls[0].items.map((item) => item.currentMonitoringType), [
    "Start",
    "End",
    "Full",
  ]);
});

Deno.test("jobs - each monitoring mode is labelled with its own reason", async () => {
  const calls = await runUpdateTick([
    { url: "url_start", monitoringType: "Start" },
    { url: "url_end", monitoringType: "End" },
    { url: "url_full", monitoringType: "Full" },
  ]);

  assertEquals(calls[0].items.map((item) => item.reason), [
    "Scheduled Start update",
    "Scheduled End update",
    "Scheduled Full update",
  ]);
  assertEquals(
    calls[0].items.every((item) => item.type === "playlist"),
    true,
  );
});

Deno.test("jobs - no monitored playlists means no listing work is queued", async () => {
  const calls = await runUpdateTick([]);

  assertEquals(calls.length, 0);
});

Deno.test("jobs - unmonitored playlists are never scheduled", async () => {
  // findAll is stubbed, so the Op.in filter cannot do the excluding here; this
  // pins the mapping side instead — only Start/End/Full produce listing items,
  // and an "N/A" row falls through every filter rather than being queued blind.
  const calls = await runUpdateTick([
    { url: "url_none", monitoringType: "N/A" },
    { url: "url_start", monitoringType: "Start" },
  ]);

  assertEquals(calls[0].items.map((item) => item.url), ["url_start"]);
});
