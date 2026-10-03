import { assert, assertEquals } from "std/assert/mod.ts";
import { config } from "../src/config.ts";
import { PlaylistVideoMapping, VideoMetadata } from "../src/db/models.ts";
import { createDownloadFlow } from "../src/handlers/pipeline/download.ts";
import {
  createJobControl,
  type JobControl,
} from "../src/handlers/pipeline/job-control.ts";
import {
  createListingRuntime,
  type ListingRuntime,
  resumeListing,
} from "../src/handlers/pipeline/listing.ts";
import { createProcessManager } from "../src/handlers/pipeline/process-manager.ts";
import type {
  DownloadItem,
  DownloadProcessEntry,
  ListingProcessEntry,
  ListingResult,
  ManagedProcess,
  PausedJob,
  StreamTextChunks,
} from "../src/handlers/pipeline/types.ts";
import {
  parseProgressLine,
  ProcessExitCodes,
} from "../src/handlers/pipeline/types.ts";

/**
 * The job-control state table, exercised against the real pipeline objects.
 *
 * The verbs are easy to state and easy to get subtly wrong — a pause that
 * deletes the bytes it promised to keep, a cancel that takes out a neighbour's
 * partial file in the same folder — so each test says what the process and the
 * disk were left holding, not only what the response claimed.
 */

const URL = "https://www.youtube.com/watch?v=abc123";
const VIDEO_ID = "abc123";
const PLAYLIST_URL = "https://mock-tube/playlist/some-playlist.rss";
const FILE_NAME = "Some video[abc123].mp4";

/**
 * A process that never reports an exit.
 *
 * Held open on purpose: a fake that exits drives the flow's completion path,
 * which reads the video table, and a test about pausing is not a test about
 * that. `kill` records and nothing more, so a killed run stays killed without
 * anything else having to happen.
 */
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
    // Reports the exit a real kill produces. Without it a cancel waits out
    // the whole grace period before escalating to a kill it has already sent,
    // which is both wrong to model and six seconds slower to test.
    kill(signal: Deno.Signal = "SIGTERM") {
      state.killed = true;
      resolve({ success: false, code: 143, signal });
      return true;
    },
  } satisfies ManagedProcess;
}

interface Harness {
  /** The real download flow, so a test can enqueue the way the route does. */
  flow: ReturnType<typeof createDownloadFlow>;
  control: JobControl;
  downloads: Map<string, DownloadProcessEntry>;
  listings: Map<string, ListingProcessEntry>;
  pausedJobs: Map<string, PausedJob>;
  /** The real listing runtime, so a test can hold a run in flight. */
  listingRuntime: ListingRuntime;
  emitted: { event: string; payload: Record<string, unknown> }[];
  savePath: string;
  /** What the flow wrote to the video row. Empty without installVideoTable. */
  videoUpdates: Record<string, unknown>[];
  restore: () => void;
}

function buildHarness(
  deps: {
    spawnPythonProcess?: () => ManagedProcess;
    streamTextChunks?: StreamTextChunks;
    installVideoTable?: boolean;
    /** Spied on instead of the real thing, to see a resume being scheduled. */
    resumeListing?: (job: PausedJob) => void;
  } = {},
): Harness {
  const savePath = Deno.makeTempDirSync();
  const originalSaveLocation = config.saveLocation;
  config.saveLocation = savePath;

  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const downloads = new Map<string, DownloadProcessEntry>();
  const listings = new Map<string, ListingProcessEntry>();
  const pausedJobs = new Map<string, PausedJob>();
  const processManager = createProcessManager(downloads, listings);
  const pipelineDeps = {
    safeEmit: (event: string, payload: unknown) =>
      emitted.push({ event, payload: payload as Record<string, unknown> }),
    buildSiteArgs: () => [] as string[],
    spawnPythonProcess: deps.spawnPythonProcess ?? pendingProcess,
    streamTextChunks: deps.streamTextChunks ??
      (() => (async function* () {})()),
    streamLines: () => (async function* () {})(),
  };

  const flow = createDownloadFlow(pipelineDeps, downloads, processManager);
  const listingRuntime = createListingRuntime(
    pipelineDeps,
    listings,
    processManager,
  );
  const control = createJobControl({
    downloadProcesses: downloads,
    listProcesses: listings,
    listingRuntime,
    pausedJobs,
    resumeDownload: flow.resumeDownload,
    resumeListing: deps.resumeListing ??
      ((job: PausedJob) => resumeListing(listingRuntime, job)),
  });

  let videoUpdates: Record<string, unknown>[] = [];
  let restoreTable: () => void = () => {};
  if (deps.installVideoTable) {
    const table = installVideoTable();
    // By reference, not copied: the completion path writes into this after
    // the harness is handed back.
    videoUpdates = table.updates;
    restoreTable = table.restore;
  }

  return {
    flow,
    control,
    downloads,
    listings,
    pausedJobs,
    listingRuntime,
    emitted,
    savePath,
    videoUpdates,
    restore: () => {
      restoreTable();
      config.saveLocation = originalSaveLocation;
      Deno.removeSync(savePath, { recursive: true });
    },
  };
}

/**
 * Stands in for the video table, as in `download_flow.test.ts`.
 *
 * `resolveAndEnqueue` reads one row per URL and nothing else touches the
 * database while the fake process stays open.
 */
function installVideoTable(): {
  updates: Record<string, unknown>[];
  restore: () => void;
} {
  const original = VideoMetadata.findOne;
  const originalMapping = PlaylistVideoMapping.findOne;
  // What the flow wrote to the video row, so a test can say the row was left
  // alone. The completion path is the only thing that writes here, and "did
  // not write an error" is a claim about it.
  const updates: Record<string, unknown>[] = [];
  // Sequelize's statics are typed to a real connection; the flow only ever
  // reads one row, so the stub replaces the lookup at the boundary.
  const mappingTable = PlaylistVideoMapping as unknown as {
    findOne: (options: unknown) => Promise<unknown>;
  };
  const videoTable = VideoMetadata as unknown as {
    findOne: (options: unknown) => Promise<unknown>;
  };
  mappingTable.findOne = () => Promise.resolve(null);
  videoTable.findOne = () =>
    Promise.resolve({
      videoId: VIDEO_ID,
      title: "Some video",
      saveDirectory: "",
      getDataValue: (key: string) => (key === "videoId" ? VIDEO_ID : null),
      update: (fields: Record<string, unknown>) => {
        updates.push(fields);
        return Promise.resolve();
      },
    });
  return {
    updates,
    restore: () => {
      VideoMetadata.findOne = original;
      PlaylistVideoMapping.findOne = originalMapping;
    },
  };
}

function downloadItem(): DownloadItem {
  return {
    url: URL,
    title: "Some video",
    saveDirectory: "",
    videoId: VIDEO_ID,
  };
}

function downloadEntry(
  overrides: Partial<DownloadProcessEntry> = {},
): DownloadProcessEntry {
  const now = Date.now();
  return {
    id: "job-1",
    url: URL,
    title: "Some video",
    item: downloadItem(),
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
  };
}

function listingEntry(
  overrides: Partial<ListingProcessEntry> = {},
): ListingProcessEntry {
  const now = Date.now();
  return {
    id: "list-1",
    url: PLAYLIST_URL,
    title: "Some playlist",
    type: "playlist",
    monitoringType: "None",
    item: {
      url: PLAYLIST_URL,
      type: "playlist",
      currentMonitoringType: "None",
      reason: "added",
    },
    chunkSize: 10,
    isScheduledUpdate: true,
    flightKey: "flight-1",
    queuePosition: now,
    progress: null,
    itemsIndexed: 0,
    paused: false,
    startedAt: now,
    spawnType: "list",
    lastActivity: now,
    lastStdoutActivity: now,
    spawnTimeStamp: now,
    status: "running",
    spawnedProcess: pendingProcess(),
    ...overrides,
  };
}

function pausedListing(
  overrides: Partial<PausedJob> = {},
): PausedJob {
  return {
    ...listingEntry(),
    kind: "listing",
    chunkSize: 10,
    isScheduledUpdate: true,
    flightKey: "flight-1",
    ...overrides,
  } as PausedJob;
}

function pausedDownload(
  overrides: Partial<PausedJob> = {},
): PausedJob {
  return {
    ...downloadEntry(),
    kind: "download",
    item: downloadItem(),
    savePath: "",
    ...overrides,
  } as PausedJob;
}

/** Lets queued microtasks and zero-delay timers run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function write(savePath: string, names: string[]) {
  for (const name of names) {
    Deno.writeTextFileSync(`${savePath}/${name}`, "x");
  }
}

function remaining(savePath: string): string[] {
  return [...Deno.readDirSync(savePath)].map((entry) => entry.name).sort();
}

Deno.test("pause - a running download is stopped, kept, and keeps its bytes", () => {
  const process = pendingProcess();
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({ status: "running", spawnedProcess: process }),
    );
    write(h.savePath, [`${FILE_NAME}.part`]);

    const result = h.control.pauseJob("job-1");

    assertEquals(result.outcome, "paused");
    // The whole point of pausing: the half-downloaded file is still there.
    assertEquals(result.partialDeleted, false);
    assertEquals(process.killed, true);
    // Out of the process map the cleanup job sweeps, and visible all the same:
    // the drawer still has a row, with a resume button on it.
    assertEquals(h.downloads.size, 0);
    const [view] = h.control.getQueueSnapshot();
    assertEquals(view.state, "paused");
    assertEquals(view.queuePosition, 0);
    assertEquals(remaining(h.savePath), [`${FILE_NAME}.part`]);
  } finally {
    h.restore();
  }
});

Deno.test("pause - a paused download is not recorded as a failed one", async () => {
  // A kill the flow can see through. `pendingProcess` never reports an exit,
  // which keeps a pause test away from the completion path — but this test is
  // about the completion path, because that is where a pause is most easily
  // mistaken for a cancellation.
  const { promise, resolve } = Promise.withResolvers<Deno.CommandStatus>();
  const closed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const killed = { value: false };
  const fake = {
    pid: 5151,
    get killed() {
      return killed.value;
    },
    kill: () => {
      killed.value = true;
      resolve({
        success: false,
        code: ProcessExitCodes.SIGTERM,
        signal: "SIGTERM",
      });
      return true;
    },
    stdout: closed,
    stderr: closed,
    status: promise,
  } satisfies ManagedProcess;

  const h = buildHarness({
    installVideoTable: true,
    spawnPythonProcess: () => fake,
  });

  try {
    await h.flow.resolveAndEnqueue([URL], "None");
    const entry = [...h.downloads.values()][0];
    // Registered before the process is spawned, so pause sees it running.
    while (!entry.spawnedProcess) await new Promise((r) => setTimeout(r, 1));

    const paused = h.control.pauseJob(entry.id);
    assertEquals(paused.outcome, "paused");

    // The run's own completion path now runs, on the same SIGTERM a cancel
    // sends. Neither of these may happen: a video row that claims to have
    // errored is a video the UI will show as broken, and `download-failed`
    // retires a job the user is one click away from resuming.
    await promise;
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(
      h.emitted.filter((e) => e.event === "download-failed"),
      [],
    );
    assertEquals(
      h.videoUpdates.filter((u) => "lastDownloadError" in u),
      [],
    );
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a running download deletes exactly its own partials", async () => {
  const process = pendingProcess();
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: process,
        savePath: h.savePath,
        fileName: FILE_NAME,
        destination: `${h.savePath}/${FILE_NAME}`,
      }),
    );
    write(h.savePath, [
      `${FILE_NAME}.part`,
      `${FILE_NAME}.part-Frag1`,
      `${FILE_NAME}.part-Frag2`,
      `${FILE_NAME}.ytdl`,
      `${FILE_NAME}.mp4`,
      // A neighbour's download, in the same folder.
      "Another video[zzz999].part",
      "Another video[zzz999].ytdl",
    ]);

    const result = await h.control.cancelJob("job-1");

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, true);
    assertEquals(process.killed, true);
    assertEquals(h.downloads.size, 0);
    // A finished file is not a partial, and neither is a neighbour's bytes:
    // two downloads can share a folder.
    assertEquals(remaining(h.savePath), [
      "Another video[zzz999].part",
      "Another video[zzz999].ytdl",
      `${FILE_NAME}.mp4`,
    ]);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - the partial outlives the process it belongs to", async () => {
  // A process that has been signalled but has not gone yet: the exact window
  // a delete has to miss. Removing the file while yt-dlp still holds it open
  // lets its last buffered write put it straight back, which is the one
  // outcome a cancel is not allowed to produce.
  const { promise, resolve } = Promise.withResolvers<Deno.CommandStatus>();
  const closed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const process = {
    pid: 6161,
    killed: false,
    kill: () => true,
    stdout: closed,
    stderr: closed,
    status: promise,
  } as unknown as ManagedProcess;

  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: process,
        savePath: h.savePath,
        fileName: FILE_NAME,
        destination: `${h.savePath}/${FILE_NAME}`,
      }),
    );
    write(h.savePath, [`${FILE_NAME}.part`]);

    const cancelling = h.control.cancelJob("job-1");
    // Long enough that a delete which was never going to wait would already
    // have run: without the wait on the exit, the removal is a couple of file
    // operations away and 50 ms is generous for a temp directory.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(remaining(h.savePath), [`${FILE_NAME}.part`]);

    resolve({ success: false, code: 143, signal: "SIGTERM" });
    const result = await cancelling;

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, true);
    assertEquals(remaining(h.savePath), []);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a queued download costs nothing", async () => {
  const h = buildHarness();
  try {
    const entry = downloadEntry({ savePath: h.savePath, fileName: FILE_NAME });
    h.downloads.set("queued_1", entry);
    write(h.savePath, [`${FILE_NAME}.part`]);

    const result = await h.control.cancelJob("job-1");

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, false);
    assertEquals(h.downloads.size, 0);
    // Nothing ran, so nothing is thrown away — and the flag is what stops the
    // download starting when its slot finally comes round.
    assertEquals(entry.cancelled, true);
    assertEquals(remaining(h.savePath), [`${FILE_NAME}.part`]);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a running download is deleted by its destination alone", async () => {
  // The post_process `fileName:` print arrives once the download is *over*, so
  // a cancel that waits for it has nothing to delete by the time it looks.
  // yt-dlp names the file before it starts, and that is what a cancel uses.
  const process = pendingProcess();
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: process,
        destination: `${h.savePath}/${FILE_NAME}`,
        // Deliberately no fileName, which is the state a running download is
        // actually in.
        fileName: null,
      }),
    );
    write(h.savePath, [`${FILE_NAME}.part`, `${FILE_NAME}.ytdl`]);

    const result = await h.control.cancelJob("job-1");

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, true);
    assertEquals(remaining(h.savePath), []);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - no file name means nothing is deleted", async () => {
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: pendingProcess(),
        savePath: h.savePath,
      }),
    );
    write(h.savePath, ["whatever.part", "whatever.ytdl"]);

    const result = await h.control.cancelJob("job-1");

    // Guessing at partials by scanning the folder would take out a
    // neighbour's bytes, so the answer says the partial could not be located.
    assertEquals(result.partialDeleted, false);
    assert((result.detail ?? "").length > 0);
    assertEquals(remaining(h.savePath), ["whatever.part", "whatever.ytdl"]);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a paused job's bytes go with it", async () => {
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: pendingProcess(),
        savePath: h.savePath,
        fileName: FILE_NAME,
      }),
    );
    write(h.savePath, [`${FILE_NAME}.part`, `${FILE_NAME}.ytdl`]);
    h.control.pauseJob("job-1");

    const result = await h.control.cancelJob("job-1");

    assertEquals(result.partialDeleted, true);
    // Exactly the bytes pausing kept.
    assertEquals(remaining(h.savePath), []);
    assertEquals(h.pausedJobs.size, 0);
    assertEquals(h.control.getQueueSnapshot().length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("resume - a paused job is re-queued under the same id", () => {
  const h = buildHarness();
  try {
    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: pendingProcess(),
        savePath: h.savePath,
        fileName: FILE_NAME,
      }),
    );
    h.control.pauseJob("job-1");

    const result = h.control.resumeJob("job-1");

    assertEquals(result.outcome, "resumed");
    // Nothing was deleted, because nothing was asked to be.
    assertEquals(result.partialDeleted, null);
    assertEquals(h.pausedJobs.size, 0);

    const [view] = h.control.getQueueSnapshot();
    assertEquals(view.id, "job-1");
    assertEquals(view.state, "queued");
    assertEquals(view.queuePosition, 1);
  } finally {
    h.restore();
  }
});

Deno.test("actions - a queued job refuses a pause and a running one a resume", () => {
  const h = buildHarness();
  try {
    h.downloads.set("queued_1", downloadEntry());

    const pause = h.control.pauseJob("job-1");
    assertEquals(pause.outcome, "not-allowed");
    assertEquals(pause.partialDeleted, null);
    assertEquals(h.downloads.size, 1);

    h.downloads.set(
      "running_1",
      downloadEntry({
        status: "running",
        spawnedProcess: pendingProcess(),
      }),
    );

    const resume = h.control.resumeJob("job-1");
    assertEquals(resume.outcome, "not-allowed");
    assertEquals(resume.partialDeleted, null);
  } finally {
    h.restore();
  }
});

Deno.test("actions - an id nobody knows answers not-found", async () => {
  const h = buildHarness();
  try {
    assertEquals(h.control.pauseJob("nope").outcome, "not-found");
    assertEquals(h.control.resumeJob("nope").outcome, "not-found");
    assertEquals((await h.control.cancelJob("nope")).outcome, "not-found");
  } finally {
    h.restore();
  }
});

Deno.test("snapshot - positions number only the jobs still waiting", () => {
  const h = buildHarness();
  try {
    const now = Date.now();
    const shared = {
      item: downloadItem(),
      progress: null,
      itemsIndexed: null,
      paused: false,
      startedAt: now,
      spawnType: "download" as const,
      lastActivity: now,
      lastStdoutActivity: now,
      spawnTimeStamp: now,
    };
    // Accepted first to last: the first two have since started, so the third is
    // first in line and the running ones are not in it at all.
    h.downloads.set(
      "a",
      downloadEntry({ ...shared, id: "a", queuePosition: 1 }),
    );
    h.downloads.set(
      "b",
      downloadEntry({
        ...shared,
        id: "b",
        queuePosition: 2,
        status: "running",
        spawnedProcess: pendingProcess(),
      }),
    );
    h.downloads.set(
      "c",
      downloadEntry({
        ...shared,
        id: "c",
        queuePosition: 3,
        status: "running",
      }),
    );
    h.downloads.set(
      "d",
      downloadEntry({ ...shared, id: "d", queuePosition: 4 }),
    );

    const byId = Object.fromEntries(
      h.control.getQueueSnapshot().map((view) => [view.id, view]),
    );

    assertEquals(byId.a.state, "queued");
    assertEquals(byId.a.queuePosition, 1);
    assertEquals(byId.d.state, "queued");
    assertEquals(byId.d.queuePosition, 2);
    assertEquals(byId.b.state, "running");
    assertEquals(byId.b.queuePosition, 0);
    assertEquals(byId.c.state, "running");
    assertEquals(byId.c.queuePosition, 0);
  } finally {
    h.restore();
  }
});

Deno.test("progress - the line parses to bytes, eta and speed", () => {
  assertEquals(
    parseProgressLine(
      " 42.0%|42|1048576|10485760|0|524288",
    ),
    {
      downloadedBytes: 1048576,
      totalBytes: 10485760,
      bytesPerSecond: 524288,
      etaSeconds: 42,
    },
  );
});

Deno.test("progress - NA and an unknown total fall back to the estimate", () => {
  // A live stream: no total, no speed, no eta, and an estimate to stand in.
  assertEquals(
    parseProgressLine("  5.0%|NA|500|NA|1000|NA"),
    {
      downloadedBytes: 500,
      totalBytes: 1000,
      bytesPerSecond: null,
      etaSeconds: null,
    },
  );

  // Neither: a transfer with no size at all, which is a null and not a zero.
  assertEquals(
    parseProgressLine("  0.0%||0|NA|NA|NA"),
    {
      downloadedBytes: 0,
      totalBytes: null,
      bytesPerSecond: null,
      etaSeconds: null,
    },
  );
});

Deno.test("progress - a chunk carrying several updates reports the last one", () => {
  // One read from the pipe is not one line. The earlier readings are stale by
  // the time anyone looks, so the last is the one that belongs on the entry.
  const chunk = [
    "[download] Destination: /app/downloads/Slow Transfer/video-slow.mp4",
    "  6.0%|5|64512|1071444|NA|201325",
    " 12.1%|6|130048|1071444|NA|134937",
    "",
  ].join("\n");

  assertEquals(parseProgressLine(chunk), {
    downloadedBytes: 130048,
    totalBytes: 1071444,
    bytesPerSecond: 134937,
    etaSeconds: 6,
  });
});

Deno.test("progress - a line that is not a progress line is ignored", () => {
  assertEquals(parseProgressLine("title:Some video [abc123]"), null);
  // Nothing is invented from a truncated line either, which is what would put
  // a NaN into the snapshot.
  assertEquals(parseProgressLine(" 42.0%|NA|"), null);
});

Deno.test("a run's counters and file name land on the entry it was queued as", async () => {
  // Resolved when the flow has read the last stdout line: the signal that the
  // run has done everything the pipe gave it, rather than a guess at how long
  // that takes. Scoped to stdout because the flow reads stderr with the same
  // helper, and stderr is empty here.
  const stdoutRead = Promise.withResolvers<void>();

  // Built before the harness and filled in after it: the lines name the
  // harness's own temp directory, and the harness wants the process that
  // reads them. A holder rather than a `let` because the two closures below
  // read it before it is assigned, and `prefer-const` is right that a `let`
  // written once and never again is not one.
  const ref: { fake?: ManagedProcess } = {};
  const h = buildHarness({
    installVideoTable: true,
    spawnPythonProcess: () => ref.fake!,
    streamTextChunks: (stream) =>
      (async function* () {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (ref.fake !== undefined && stream === ref.fake.stdout) {
              stdoutRead.resolve();
            }
            return;
          }
          yield decoder.decode(value);
        }
      })(),
  });

  const lines = [
    // What yt-dlp resolves before it starts, and what a cancel deletes by.
    `filePath:${h.savePath}/${FILE_NAME}`,
    " 50.0%|12|2048|4096|0|1024",
    `post_process:"fileName:${FILE_NAME}"`,
  ];

  ref.fake = {
    ...pendingProcess(),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(`${line}\n`));
        }
        controller.close();
      },
    }),
  } satisfies ManagedProcess;

  try {
    const { items } = await h.flow.resolveAndEnqueue([URL], "None");

    await stdoutRead.promise;
    const entry = [...h.downloads.values()][0];

    const [view] = h.control.getQueueSnapshot();
    // The id minted on acceptance is the one the entry answers to: it survives
    // the queued → running transition.
    assertEquals(view.id, items[0].id);
    assertEquals(view.state, "running");
    assertEquals(view.progress, {
      downloadedBytes: 2048,
      totalBytes: 4096,
      bytesPerSecond: 1024,
      etaSeconds: 12,
    });

    assertEquals(entry.fileName, FILE_NAME);
    assertEquals(entry.destination, `${h.savePath}/${FILE_NAME}`);
    assertEquals(entry.savePath, h.savePath);
  } finally {
    h.restore();
  }
});

Deno.test("resume - a paused download is kept when its url is already being downloaded", () => {
  // The duplicate filter drops an item whose url is already queued or running.
  // A resume that reaches it is discarded without a word, so without the check
  // below the paused job is deleted, nothing is enqueued, and the user watches
  // a job leave the drawer with no download to replace it.
  const h = buildHarness();
  try {
    h.downloads.set(
      "dup",
      downloadEntry({ id: "dup-1", url: URL, status: "running" }),
    );
    h.pausedJobs.set("job-1", pausedDownload({ savePath: h.savePath }));

    const result = h.control.resumeJob("job-1");

    assertEquals(result.outcome, "not-allowed");
    assert(
      h.pausedJobs.has("job-1"),
      "a refused resume must leave the paused job where it was",
    );
  } finally {
    h.restore();
  }
});

Deno.test("resume - a listing waits for the run its pause released before starting", async () => {
  // SIGTERM stops yt-dlp, not the run around it. The pause releases the
  // single-flight key so the resume cannot join the dying run — but the run
  // keeps writing rows, and a second run starting beside it can insert a
  // mapping for a video the first is already inserting one for.
  const resumed: PausedJob[] = [];
  const h = buildHarness({ resumeListing: (job) => void resumed.push(job) });
  try {
    const gate = Promise.withResolvers<ListingResult>();
    const entry = listingEntry();
    h.listings.set("list-1", entry);
    h.listingRuntime.inFlight.run(entry.flightKey, () => gate.promise);

    assertEquals(h.control.pauseJob(entry.id).outcome, "paused");
    assertEquals(h.control.resumeJob(entry.id).outcome, "resumed");

    await tick();
    assertEquals(
      resumed.length,
      0,
      "the replacement must not start while the run it replaced is in flight",
    );

    gate.resolve({ url: PLAYLIST_URL, status: "success" });
    await tick();
    await tick();
    assertEquals(resumed.length, 1);
    assertEquals(resumed[0].id, entry.id);
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a running download that will not confirm it exited keeps its partial", async () => {
  // SIGTERM is ignored here, so the grace period runs out and SIGKILL goes out
  // too. A kill makes a process unlikely to still be writing, not certain, and
  // deleting under an open handle is how a cancelled download grows its .part
  // back — so the bytes stay and the answer says so.
  const h = buildHarness();
  try {
    const stubborn = {
      ...pendingProcess(),
      status: new Promise<Deno.CommandStatus>(() => {}),
    };
    h.downloads.set(
      "pending_" + URL,
      downloadEntry({
        id: "job-1",
        savePath: h.savePath,
        fileName: FILE_NAME,
        destination: `${h.savePath}/${FILE_NAME}`,
        spawnedProcess: stubborn,
      }),
    );
    write(h.savePath, [`${FILE_NAME}.part`, `${FILE_NAME}.ytdl`]);

    const result = await h.control.cancelJob("job-1");

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, false);
    assertEquals(
      remaining(h.savePath),
      [`${FILE_NAME}.part`, `${FILE_NAME}.ytdl`],
      "an unconfirmed exit must leave the partial files alone",
    );
  } finally {
    h.restore();
  }
});

Deno.test("cancel - a paused listing says it has nothing to delete, not that a partial is missing", async () => {
  // A listing writes rows, not files. Falling through to the download path made
  // it report a partial file it could not locate — on a disk it never wrote to.
  const h = buildHarness();
  try {
    h.pausedJobs.set("list-1", pausedListing({ savePath: undefined }));

    const result = await h.control.cancelJob("list-1");

    assertEquals(result.outcome, "cancelled");
    assertEquals(result.partialDeleted, false);
    assertEquals(result.detail, undefined);
    assert(!h.pausedJobs.has("list-1"));
  } finally {
    h.restore();
  }
});
