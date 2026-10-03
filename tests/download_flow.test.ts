import { assertEquals } from "std/assert/mod.ts";
import { config } from "../src/config.ts";
import { PlaylistVideoMapping, VideoMetadata } from "../src/db/models.ts";
import { createDownloadFlow } from "../src/handlers/pipeline/download.ts";
import { createProcessManager } from "../src/handlers/pipeline/process-manager.ts";
import { streamLines, streamTextChunks } from "../src/utils/streams.ts";
import type { DownloadFlow } from "../src/handlers/pipeline/download.ts";
import type {
  DownloadProcessEntry,
  ListingProcessEntry,
  ManagedProcess,
} from "../src/handlers/pipeline/types.ts";

/**
 * The verdict a download records is taken from the filesystem, so these tests
 * are about what a run leaves on disk rather than what it exits with. Each
 * script is what a real yt-dlp would have done in that situation.
 */

const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
const VIDEO_ID = "abc123";

/** What a fake run writes on stdout, and where. */
interface Script {
  stdout: string[];
  stderr?: string[];
  exitCode: number;
  /** Run after stdout is delivered, before the status resolves. */
  onExit?: () => void;
}

interface Row {
  title: string;
  saveDirectory: string | null;
  fileName: string | null;
  downloadStatus: boolean;
  missingExtras: string[] | null;
  updates: Record<string, unknown>[];
}

function fakeProcess(script: Script): ManagedProcess {
  const encoder = new TextEncoder();
  const { promise: status, resolve: resolveStatus } = Promise.withResolvers<
    Deno.CommandStatus
  >();

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of script.stdout) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      script.onExit?.();
      controller.close();
      resolveStatus({
        success: script.exitCode === 0,
        code: script.exitCode,
        signal: null,
      });
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of script.stderr ?? []) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return {
    pid: 4242,
    killed: false,
    stdout,
    stderr,
    status,
    kill: () => true,
  };
}

interface Harness {
  flow: DownloadFlow;
  row: Row;
  emitted: { event: string; payload: Record<string, unknown> }[];
  savePath: string;
  cleanup: () => void;
  /** Called after every emit; lets a test await the terminal event. */
  onEmit?: () => void;
}

/**
 * Stands in for the video table, as in `ingest_chunk_persist.test.ts`.
 *
 * The flow reads one row before it starts and writes its verdict back to it;
 * nothing else about the download touches the database.
 */
function installVideoTable(row: Row): () => void {
  const original = VideoMetadata.findOne;
  const originalMapping = PlaylistVideoMapping.findOne;
  // resolveAndEnqueue looks for a playlist to fall back to when the row has
  // no directory of its own. Without this the test would reach for a real
  // database over the network and fail for the wrong reason.
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).findOne = () => Promise.resolve(null);
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).findOne = () =>
    Promise.resolve({
      // resolveAndEnqueue reads these as plain properties; getDataValue covers
      // the completion path.
      videoId: VIDEO_ID,
      title: row.title,
      saveDirectory: row.saveDirectory,
      // deno-lint-ignore no-explicit-any
      getDataValue: (key: string) => (row as any)[key],
      update: (fields: Record<string, unknown>) => {
        row.updates.push(fields);
        Object.assign(row, fields);
        return Promise.resolve(row);
      },
    });
  return () => {
    VideoMetadata.findOne = original;
    PlaylistVideoMapping.findOne = originalMapping;
  };
}

async function harness(script: Script, row?: Partial<Row>): Promise<Harness> {
  const savePath = await Deno.makeTempDir();
  const state: Row = {
    title: "Some video",
    saveDirectory: "",
    fileName: null,
    downloadStatus: false,
    missingExtras: null,
    updates: [],
    ...row,
  };

  const restoreTable = installVideoTable(state);
  const originalSaveLocation = config.saveLocation;
  config.saveLocation = savePath;

  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const downloadProcesses = new Map<string, DownloadProcessEntry>();
  const listProcesses = new Map<string, ListingProcessEntry>();

  // The emit hook calls back into the harness being built, which is why the
  // reference is filled in before the first emit can happen.
  const harnessRef: Harness = {
    flow: null as unknown as DownloadFlow,
    row: state,
    emitted,
    savePath,
    cleanup: () => {
      restoreTable();
      config.saveLocation = originalSaveLocation;
      Deno.removeSync(savePath, { recursive: true });
    },
  };

  const flow = createDownloadFlow(
    {
      safeEmit: (event, payload) => {
        emitted.push({
          event,
          payload: payload as Record<string, unknown>,
        });
        harnessRef.onEmit?.();
      },
      buildSiteArgs: () => [],
      spawnPythonProcess: () => fakeProcess(script),
      streamTextChunks,
      streamLines,
    },
    downloadProcesses,
    createProcessManager(downloadProcesses, listProcesses),
  );

  harnessRef.flow = flow;
  return harnessRef;
}

/**
 * The line a run prints for the file it produced.
 *
 * The quotes belong around the whole `fileName:...` field, not around the name
 * — that is what the `--print` template in `pipeline/types.ts` asks for, and
 * what the flow's `fileName:(.+)"` pattern is written against.
 */
function postProcessLine(fileName: string) {
  return `post_process:"fileName:${fileName}"`;
}

const ALL_OFFERED =
  "extras:subs=1 autosubs=1 chapters=0 comments=0 description=1 thumbnail=1";

Deno.test({
  name: "download - a 429 on a sidecar is a partial success, not a failure",
  async fn() {
    const h = await harness({
      stdout: [
        `title:Some video [${VIDEO_ID}]`,
        ALL_OFFERED,
        postProcessLine(`${VIDEO_ID}.mp4`),
      ],
      stderr: [
        "WARNING: [youtube] HTTP Error 429: Too Many Requests. Retrying.",
      ],
      exitCode: 1,
      onExit: () => {
        // The media landed and the description arrived; the thumbnail and the
        // subtitles were rate limited.
        Deno.writeTextFileSync(`${h.savePath}/${VIDEO_ID}.mp4`, "video");
        Deno.writeTextFileSync(`${h.savePath}/${VIDEO_ID}.description`, "d");
      },
    });

    try {
      const results = await h.flow.resolveAndEnqueue([VIDEO_URL], "None");
      assertEquals(results.notIndexed, []);
      await terminalEvent(h);

      const done = h.emitted.find((e) => e.event === "download-done")!;
      // The video file is the download. yt-dlp exits 1 for reporting anything
      // at all, and that used to fail a video that was sitting on disk.
      assertEquals(
        h.emitted.some((e) => e.event === "download-failed"),
        false,
      );
      assertEquals(done.payload.partial, true);
      // Chapters and comments are not named: the source offered neither, and
      // an extra that never existed is not a gap.
      assertEquals([...(done.payload.missingExtras as string[])].sort(), [
        "subtitles",
        "thumbnail",
      ]);
      assertEquals(done.payload.reason, "rate-limited");
      assertEquals(h.row.updates.at(-1)?.isMetaDataSynced, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "download - no media file on disk is a failure",
  async fn() {
    const h = await harness({
      stdout: [`title:Some video [${VIDEO_ID}]`, ALL_OFFERED],
      stderr: ["ERROR: unable to download video data"],
      exitCode: 1,
    });

    try {
      await h.flow.resolveAndEnqueue([VIDEO_URL], "None");
      await terminalEvent(h);

      const failed = h.emitted.find((e) => e.event === "download-failed")!;
      assertEquals(
        h.emitted.some((e) => e.event === "download-done"),
        false,
      );
      assertEquals(failed.payload.error, "Process exited with code 1");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "download - a source with no sidecars at all is complete",
  async fn() {
    const h = await harness({
      stdout: [
        `title:Some video [${VIDEO_ID}]`,
        "extras:subs=0 autosubs=0 chapters=0 comments=0 description=0 thumbnail=0",
        postProcessLine(`${VIDEO_ID}.mp4`),
      ],
      exitCode: 0,
      onExit: () => {
        Deno.writeTextFileSync(`${h.savePath}/${VIDEO_ID}.mp4`, "video");
      },
    });

    try {
      await h.flow.resolveAndEnqueue([VIDEO_URL], "None");
      await terminalEvent(h);

      const done = h.emitted.find((e) => e.event === "download-done")!;
      assertEquals(done.payload.partial, false);
      assertEquals(done.payload.missingExtras, null);
      assertEquals(done.payload.isMetaDataSynced, true);
      assertEquals(h.row.updates.at(-1)?.isMetaDataSynced, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "syncExtras - a file that turns up clears the entry",
  async fn() {
    const h = await harness(
      {
        stdout: [],
        exitCode: 0,
        onExit: () => {
          Deno.writeTextFileSync(`${h.savePath}/${VIDEO_ID}.en.vtt`, "WEBVTT");
        },
      },
      {
        fileName: `${VIDEO_ID}.mp4`,
        downloadStatus: true,
        missingExtras: ["subtitles", "thumbnail"],
      },
    );

    try {
      await h.flow.syncExtras(VIDEO_URL);

      // The subtitle arrived; the thumbnail was not asked for by this run and
      // is still missing, so exactly one entry clears.
      const update = h.row.updates.at(-1)!;
      assertEquals(update.subTitleFile, `${VIDEO_ID}.en.vtt`);
      assertEquals(
        [...(update.missingExtras as string[])].sort(),
        ["thumbnail"],
      );
      assertEquals(update.isMetaDataSynced, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "syncExtras - nothing missing means no run at all",
  async fn() {
    const h = await harness({ stdout: [], exitCode: 0 });

    try {
      const result = await h.flow.syncExtras(VIDEO_URL);
      assertEquals(result.status, "unchanged");
      assertEquals(h.row.updates, []);
    } finally {
      h.cleanup();
    }
  },
});

/**
 * Waits for the flow to emit one of the two terminal download events.
 *
 * Awaiting the event rather than a duration: the pipeline resolves its result
 * from a promise chain inside the flow, and a sleep long enough to cover it
 * would be a guess that is either slow or flaky.
 */
function terminalEvent(h: Harness): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error("the download never settled")),
    5000,
  );
  const original = h.emitted;
  const check = () => {
    const settled = original.some((e) =>
      e.event === "download-done" || e.event === "download-failed"
    );
    if (settled) {
      clearTimeout(timer);
      resolve();
    }
  };
  h.onEmit = check;
  // The event may already have fired while the caller was setting up.
  check();
  return promise;
}
