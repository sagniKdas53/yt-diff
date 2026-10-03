import { assertEquals } from "std/assert/mod.ts";
import { createDownloadFlow } from "../src/handlers/pipeline/download.ts";
import { createProcessManager } from "../src/handlers/pipeline/process-manager.ts";
import { cancelListing } from "../src/handlers/pipeline/listing.ts";
import type {
  DownloadProcessEntry,
  ListingProcessEntry,
  ManagedProcess,
} from "../src/handlers/pipeline/types.ts";
import { buildBotExpiryWhere } from "../src/handlers/playlists/queries.ts";

/**
 * The pipeline half of backlog item 1, plus the query the expiry chip is
 * built on. A cancelled download has to actually stop — flagging a queued
 * entry and never reading the flag would leave it running to completion, and
 * the person who cancelled it is the one waiting.
 */

const URL = "https://www.youtube.com/watch?v=abc123";

/** A process whose exit the test decides, so a slot can be held open. */
function pendingProcess() {
  const { promise, resolve } = Promise.withResolvers<Deno.CommandStatus>();
  const state = { killed: false };
  const closed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return {
    pid: 4242,
    get killed() {
      return state.killed;
    },
    stdout: closed,
    stderr: closed,
    status: promise,
    kill() {
      state.killed = true;
      resolve({ success: false, code: 143, signal: "SIGTERM" });
      return true;
    },
  } satisfies ManagedProcess;
}

interface Flow {
  cancelDownload: (url: string) => string;
  processes: Map<string, DownloadProcessEntry>;
  emitted: { event: string; payload: Record<string, unknown> }[];
}

function buildFlow(): Flow {
  const emitted: Flow["emitted"] = [];
  const processes = new Map<string, DownloadProcessEntry>();
  const listProcesses = new Map<string, ListingProcessEntry>();
  const flow = createDownloadFlow(
    {
      safeEmit: (event, payload) =>
        emitted.push({
          event,
          payload: payload as Record<string, unknown>,
        }),
      buildSiteArgs: () => [],
      spawnPythonProcess: () => pendingProcess(),
      streamTextChunks: () => (async function* () {})(),
      streamLines: () => (async function* () {})(),
    },
    processes,
    createProcessManager(processes, listProcesses),
  );

  return { cancelDownload: flow.cancelDownload, processes, emitted };
}

function entry(url: string, overrides: Partial<DownloadProcessEntry> = {}) {
  const now = Date.now();
  return {
    id: "job-1",
    url,
    title: "A video",
    item: { url, title: "A video", saveDirectory: "", videoId: "abc123" },
    queuePosition: 1,
    progress: null,
    itemsIndexed: null,
    paused: false,
    startedAt: now,
    spawnType: "download",
    lastActivity: now,
    lastStdoutActivity: now,
    spawnTimeStamp: now,
    status: "pending",
    ...overrides,
  } satisfies DownloadProcessEntry;
}

Deno.test("cancelDownload - a queued entry is flagged, not killed", () => {
  const flow = buildFlow();
  const queued = entry(URL);
  flow.processes.set("pending_1", queued);

  // No process exists yet, so there is nothing to kill: the cancellation is a
  // note the download reads for itself when the slot comes round.
  assertEquals(flow.cancelDownload(URL), "queued");
  assertEquals(queued.cancelled, true);
});

Deno.test("cancelDownload - a running entry's process is killed", () => {
  const flow = buildFlow();
  const process = pendingProcess();
  flow.processes.set(
    "running_1",
    entry(URL, { status: "running", spawnedProcess: process }),
  );

  assertEquals(flow.cancelDownload(URL), "killed");
  // SIGTERM, so the exit reads as the deliberate termination it is rather
  // than as a crash.
  assertEquals(process.killed, true);
});

Deno.test("cancelDownload - a finished entry is left alone", () => {
  const flow = buildFlow();
  const done = entry(URL, { status: "completed" });
  flow.processes.set("done_1", done);

  assertEquals(flow.cancelDownload(URL), "not-found");
  assertEquals(done.cancelled, undefined);
});

Deno.test("cancelListing - a running listing is killed, a queued one is not found", () => {
  const process = pendingProcess();
  const running: ListingProcessEntry = {
    id: "job-2",
    url: URL,
    title: "",
    type: "playlist",
    monitoringType: "N/A",
    item: {
      url: URL,
      type: "playlist",
      currentMonitoringType: "N/A",
      reason: "test",
    },
    chunkSize: 10,
    isScheduledUpdate: false,
    flightKey: "running_1",
    queuePosition: 0,
    progress: null,
    itemsIndexed: 0,
    paused: false,
    startedAt: 0,
    spawnType: "list",
    lastActivity: 0,
    lastStdoutActivity: 0,
    spawnTimeStamp: 0,
    status: "running",
    spawnedProcess: process,
  };
  const listProcesses = new Map<string, ListingProcessEntry>([
    ["running_1", running],
    ["pending_1", { ...running, spawnedProcess: null, status: "pending" }],
  ]);
  const rt = { listProcesses } as unknown as Parameters<
    typeof cancelListing
  >[0];

  assertEquals(cancelListing(rt, URL), "killed");
  assertEquals(process.killed, true);

  // Now the queued entry is the only one left for this URL, so the next call
  // is decided by it. With the running entry still present the lookup would
  // answer from that one instead and never reach the queued case at all.
  listProcesses.delete("running_1");
  // A listing waiting for a slot has nothing of it to stop, and saying so is
  // better than pretending a cancellation happened.
  assertEquals(cancelListing(rt, URL), "not-found");
  // And a URL nobody is listing is the same answer, for a different reason.
  assertEquals(cancelListing(rt, "https://example.com/other"), "not-found");
});

Deno.test("getsub expiry - the chip is built from the reaper's own conditions", () => {
  const where = buildBotExpiryWhere([URL]) as Record<string, unknown>;

  assertEquals(where.status, "delivered");
  assertEquals(where.downloadedByBot, true);
  // Sequelize operators are symbol-keyed, so the operators themselves are
  // what has to be asserted rather than their spelling.
  const symbols = (value: unknown) => Object.getOwnPropertySymbols(value ?? {});
  assertEquals(symbols(where.expiresAt).length > 0, true);
  assertEquals(symbols(where.canonicalUrl).length > 0, true);
});
