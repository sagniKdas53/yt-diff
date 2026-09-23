import { assert, assertEquals } from "std/assert/mod.ts";
import { processStreamingVideoInformation } from "../src/handlers/pipeline/ingest-chunk.ts";
import {
  consumePlaylistChunks,
  type ListingRuntime,
} from "../src/handlers/pipeline/listing.ts";
import type { ProcessStatus } from "../src/handlers/pipeline/process-manager.ts";
import {
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const TRANSACTION = { id: "stub-transaction" };
const PLAYLIST = "https://www.iwara.tv/profile/jonathanmmd/videos";

interface MappingSeed {
  id: string;
  videoUrl: string;
  position: number;
}

interface Call {
  model: string;
  rows: Record<string, unknown>[];
  options: Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
type AnyModel = any;

function videoRow(videoUrl: string): AnyModel {
  return {
    getDataValue: (key: string) =>
      key === "videoUrl"
        ? videoUrl
        : key === "title"
        ? `title ${videoUrl}`
        : key === "downloadStatus"
        ? false
        : null,
  };
}

function mappingRow(seed: MappingSeed): AnyModel {
  const data: Record<string, unknown> = {
    id: seed.id,
    videoUrl: seed.videoUrl,
    playlistUrl: PLAYLIST,
    positionInPlaylist: seed.position,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z"),
  };
  return { getDataValue: (key: string) => data[key] };
}

/** One yt-dlp `--dump-json` line at the source's own position. */
function line(id: string, playlistIndex: number): string {
  return JSON.stringify({
    webpage_url: `https://iwara.tv/video/${id}`,
    id,
    title: `video ${id}`,
    filesize_approx: "NA",
    playlist_index: playlistIndex,
  });
}

function videoUrlOf(id: string): string {
  return `https://iwara.tv/video/${id}`;
}

/**
 * Stubs the reads `processStreamingVideoInformation` makes plus the writes
 * `persistStreamingChunk` performs, capturing every write. Reads always
 * reflect the seeds (single-chunk scope); see the driver test below for the
 * stateful multi-chunk variant.
 */
function installSingleChunk(
  videoUrls: string[],
  mappings: MappingSeed[],
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];

  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).findAll = () =>
    Promise.resolve(videoUrls.map(videoRow));
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).findAll = () =>
    Promise.resolve(mappings.map(mappingRow));
  // deno-lint-ignore no-explicit-any
  const unscoped = (VideoMetadata as any).unscoped;
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).unscoped = () => ({
    // deno-lint-ignore no-explicit-any
    bulkCreate: (rows: any[], options: any = {}) => {
      calls.push({ model: "VideoMetadata", rows, options });
      return Promise.resolve(rows);
    },
  });
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).bulkCreate = (
    // deno-lint-ignore no-explicit-any
    rows: any[],
    // deno-lint-ignore no-explicit-any
    options: any = {},
  ) => {
    calls.push({ model: "PlaylistVideoMapping", rows, options });
    return Promise.resolve(rows);
  };
  // deno-lint-ignore no-explicit-any
  (sequelize as any).transaction = async (
    fn: (t: unknown) => Promise<void>,
  ) => {
    await fn(TRANSACTION);
  };

  return {
    calls,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      delete (VideoMetadata as any).findAll;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistVideoMapping as any).findAll;
      // deno-lint-ignore no-explicit-any
      (VideoMetadata as any).unscoped = unscoped;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistVideoMapping as any).bulkCreate;
      // deno-lint-ignore no-explicit-any
      delete (sequelize as any).transaction;
    },
  };
}

function mappingWrites(calls: Call[]) {
  return calls
    .filter((call) => call.model === "PlaylistVideoMapping")
    .flatMap((call) => call.rows);
}

function createdPositions(calls: Call[]): number[] {
  return calls
    .filter((call) =>
      call.model === "PlaylistVideoMapping" &&
      call.options.conflictAttributes === undefined
    )
    .flatMap((call) => call.rows)
    .map((row) => row.positionInPlaylist as number);
}

function updatedPositions(calls: Call[]): number[] {
  return calls
    .filter((call) =>
      call.model === "PlaylistVideoMapping" &&
      (call.options.conflictAttributes as string[] | undefined)?.includes(
        "id",
      )
    )
    .flatMap((call) => call.rows)
    .map((row) => row.positionInPlaylist as number);
}

// ---------------------------------------------------------------------------
// U1 — Start small prepend: shifted rows update, new rows create, no dupes
// ---------------------------------------------------------------------------

Deno.test("U1 - Start prepend shifts existing rows instead of duplicating", async () => {
  // DB: A@1 B@2. Source: N1@1 N2@2 N3@3 A@4 B@5 (three prepended).
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("A"), videoUrlOf("B")],
    [
      { id: "id-a", videoUrl: videoUrlOf("A"), position: 1 },
      { id: "id-b", videoUrl: videoUrlOf("B"), position: 2 },
    ],
  );
  try {
    const result = await processStreamingVideoInformation(
      [
        line("N1", 1),
        line("N2", 2),
        line("N3", 3),
        line("A", 4),
        line("B", 5),
      ],
      PLAYLIST,
      1,
      false,
      "Start",
    );

    assertEquals(createdPositions(calls), [1, 2, 3]);
    assertEquals(updatedPositions(calls), [4, 5]);
    assertEquals(result.alreadyExistedCount, 2);
    assertEquals(
      result.moves.map((m) => [m.oldPosition, m.newPosition]),
      [[1, 4], [2, 5]],
    );
    // Every known row moved, but the driver still inspects later chunks.
    assertEquals(result.alreadyExistedCount, result.moves.length);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U2 — End deletion shift: moved tail rows update, nothing created
// ---------------------------------------------------------------------------

Deno.test("U2 - End head deletion shifts tail rows via updates", async () => {
  // DB: A@1 C@3 D@4 (B deleted upstream). Source: A@1 C@2 D@3.
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("A"), videoUrlOf("C"), videoUrlOf("D")],
    [
      { id: "id-a", videoUrl: videoUrlOf("A"), position: 1 },
      { id: "id-c", videoUrl: videoUrlOf("C"), position: 3 },
      { id: "id-d", videoUrl: videoUrlOf("D"), position: 4 },
    ],
  );
  try {
    const result = await processStreamingVideoInformation(
      [line("A", 1), line("C", 2), line("D", 3)],
      PLAYLIST,
      1,
      false,
      "End",
    );

    assertEquals(mappingWrites(calls).length, 2);
    assertEquals(createdPositions(calls), []);
    assertEquals(updatedPositions(calls), [2, 3]);
    assertEquals(result.alreadyExistedCount, 3);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U3 — Legitimate YouTube duplicate still creates a second mapping
// ---------------------------------------------------------------------------

Deno.test("U3 - same video twice with no rows creates two mappings", async () => {
  const { calls, restore } = installSingleChunk([], []);
  try {
    const result = await processStreamingVideoInformation(
      [line("V", 1), line("V", 2)],
      PLAYLIST,
      1,
      false,
      "N/A",
    );

    assertEquals(createdPositions(calls), [1, 2]);
    assertEquals(result.moves, []);
    assertEquals(result.count, 2);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U4 — Pre-existing duplicate moved: exact occurrence skips, other updates
// ---------------------------------------------------------------------------

Deno.test("U4 - pre-existing duplicate consumes exact row first", async () => {
  // DB: V@1 V@2 (legit dupe). Source: V@2 V@3.
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("V")],
    [
      { id: "id-v1", videoUrl: videoUrlOf("V"), position: 1 },
      { id: "id-v2", videoUrl: videoUrlOf("V"), position: 2 },
    ],
  );
  try {
    const result = await processStreamingVideoInformation(
      [line("V", 2), line("V", 3)],
      PLAYLIST,
      1,
      false,
      "Start",
    );

    assertEquals(createdPositions(calls), []);
    assertEquals(updatedPositions(calls), [3]);
    assertEquals(result.alreadyExistedCount, 2);
    assertEquals(result.moves.length, 1);
    // An exact skip sits beside the move: the driver must NOT shortcut
    // (bulk-shifting would move the exact row a second time).
    assert(result.alreadyExistedCount !== result.moves.length);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U5 — Refresh re-evaluates without fast-skip accounting
// ---------------------------------------------------------------------------

Deno.test("U5 - Refresh consumes exact rows but counts nothing as existed", async () => {
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("A")],
    [{ id: "id-a", videoUrl: videoUrlOf("A"), position: 1 }],
  );
  try {
    const result = await processStreamingVideoInformation(
      [line("A", 1)],
      PLAYLIST,
      1,
      false,
      "Refresh",
    );

    assertEquals(mappingWrites(calls), []);
    assertEquals(result.alreadyExistedCount, 0);
    assertEquals(result.moves, []);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U6 — None pseudo-playlist still reuses its single row
// ---------------------------------------------------------------------------

Deno.test("U6 - None drift updates the existing row", async () => {
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("A")],
    [{ id: "id-a", videoUrl: videoUrlOf("A"), position: 5 }],
  );
  try {
    const result = await processStreamingVideoInformation(
      [JSON.stringify({
        webpage_url: videoUrlOf("A"),
        id: "A",
        title: "video A",
        filesize_approx: "NA",
        playlist_index: 99,
      })],
      "None",
      9,
      false,
    );

    assertEquals(createdPositions(calls), []);
    assertEquals(updatedPositions(calls), [9]);
    assertEquals(result.moves.length, 1);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Stateful multi-chunk driver coverage
// ---------------------------------------------------------------------------

interface FakeDb {
  videos: Set<string>;
  mappings: {
    id: string;
    videoUrl: string;
    position: number;
    updatedAt: Date;
  }[];
}

function installStatefulDb(
  db: FakeDb,
  counters: { updates: number; chunksPulled: number },
): () => void {
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).findAll = () =>
    Promise.resolve([...db.videos].map(videoRow));
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).findAll = () =>
    Promise.resolve(
      db.mappings.map((m) => ({
        getDataValue: (key: string) =>
          ({
            id: m.id,
            videoUrl: m.videoUrl,
            playlistUrl: PLAYLIST,
            positionInPlaylist: m.position,
            createdAt: new Date("2020-01-01T00:00:00.000Z"),
            updatedAt: m.updatedAt,
          })[key],
      })),
    );
  // deno-lint-ignore no-explicit-any
  const unscoped = (VideoMetadata as any).unscoped;
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).unscoped = () => ({
    // deno-lint-ignore no-explicit-any
    bulkCreate: (rows: any[], _options: any = {}) => {
      for (const row of rows) db.videos.add(row.videoUrl as string);
      return Promise.resolve(rows);
    },
  });
  let created = 0;
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).bulkCreate = (
    // deno-lint-ignore no-explicit-any
    rows: any[],
    // deno-lint-ignore no-explicit-any
    options: any = {},
  ) => {
    if (options.conflictAttributes?.includes("id")) {
      for (const row of rows) {
        const target = db.mappings.find((m) => m.id === row.id);
        if (target) {
          target.position = row.positionInPlaylist as number;
          target.updatedAt = new Date();
        }
      }
    } else {
      for (const row of rows) {
        db.mappings.push({
          id: `created-${created++}`,
          videoUrl: row.videoUrl as string,
          position: row.positionInPlaylist as number,
          updatedAt: new Date(),
        });
      }
    }
    return Promise.resolve(rows);
  };
  // deno-lint-ignore no-explicit-any
  (sequelize as any).transaction = async (
    fn: (t: unknown) => Promise<void>,
  ) => {
    await fn(TRANSACTION);
  };
  return () => {
    // deno-lint-ignore no-explicit-any
    delete (VideoMetadata as any).findAll;
    // deno-lint-ignore no-explicit-any
    delete (PlaylistVideoMapping as any).findAll;
    // deno-lint-ignore no-explicit-any
    (VideoMetadata as any).unscoped = unscoped;
    // deno-lint-ignore no-explicit-any
    delete (PlaylistVideoMapping as any).bulkCreate;
    // deno-lint-ignore no-explicit-any
    delete (sequelize as any).transaction;
  };
}

function fakeRuntime(): ListingRuntime {
  return {
    safeEmit: (_event: string, _payload: unknown) => {},
    // deno-lint-ignore no-explicit-any
    launchYtDlp: (_args: any) => {
      throw new Error("not used");
    },
    // deno-lint-ignore no-explicit-any
    streamLines: (_stream: any) => (async function* () {})(),
    // deno-lint-ignore no-explicit-any
    streamTextChunks: (_stream: any) => (async function* () {})(),
    // deno-lint-ignore no-explicit-any
    listProcesses: new Map() as any,
    // deno-lint-ignore no-explicit-any
    semaphore: null as any,
    // deno-lint-ignore no-explicit-any
    inFlight: null as any,
    updateProcessActivity: (_key: string, _stdout?: boolean) => {},
    setProcessStatus: (_key: string, _status: ProcessStatus) => true,
  };
}

Deno.test("U7 - Start prepend walks every chunk and keeps the tail correct", async () => {
  // DB: A..J @1..10. Source: N1..N12 @1..12, A..J @13..22. Chunk size 10.
  const ids = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const db: FakeDb = {
    videos: new Set(ids.map(videoUrlOf)),
    mappings: ids.map((id, i) => ({
      id: `id-${id}`,
      videoUrl: videoUrlOf(id),
      position: i + 1,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    })),
  };
  const counters = { updates: 0, chunksPulled: 0 };
  const restore = installStatefulDb(db, counters);
  try {
    const newIds = Array.from({ length: 12 }, (_v, i) => `N${i + 1}`);
    const sourceItems = [
      ...newIds.map((id, i) => line(id, i + 1)),
      ...ids.map((id, i) => line(id, i + 13)),
    ];
    const chunkSize = 10;
    const chunks = [];
    for (let i = 0; i < sourceItems.length; i += chunkSize) {
      chunks.push({
        items: sourceItems.slice(i, i + chunkSize),
        startIndex: i + 1,
      });
    }

    let stopped = false;
    const rt = fakeRuntime();
    const result = await consumePlaylistChunks(rt, {
      chunks: (async function* () {
        for (const chunk of chunks) {
          if (stopped) break;
          counters.chunksPulled++;
          yield chunk;
        }
      })(),
      stop: () => {
        stopped = true;
      },
      onEmpty: () => ({ url: PLAYLIST, title: "x", status: "failed" }),
      onError: (error) => ({
        url: PLAYLIST,
        title: "x",
        status: "failed",
        error: error.message,
      }),
    }, {
      videoUrl: PLAYLIST,
      isScheduledUpdate: true,
      shouldEmitProgress: false,
      playlistTitle: "P",
      seekPlaylistListTo: 0,
      processKey: "k",
      monitoringType: "Start",
    });

    // A uniformly shifted chunk is not proof that the unseen tail is also a
    // pure prepend, so the final chunk must still be inspected.
    assertEquals(counters.chunksPulled, 3);
    assertEquals(counters.updates, 0);
    assertEquals(result.status, "completed");

    const byPosition = new Map(
      db.mappings.map((m) => [m.position, m.videoUrl] as const),
    );
    // No two rows share a position, and the order matches the source.
    assertEquals(db.mappings.length, 22);
    assertEquals(byPosition.size, 22);
    newIds.forEach((id, i) => {
      assertEquals(byPosition.get(i + 1), videoUrlOf(id));
    });
    ids.forEach((id, i) => {
      assertEquals(byPosition.get(i + 13), videoUrlOf(id));
    });
  } finally {
    restore();
  }
});

Deno.test("U8 - duplicate occurrences in separate chunks keep separate mappings", async () => {
  const db: FakeDb = { videos: new Set(), mappings: [] };
  const counters = { updates: 0, chunksPulled: 0 };
  const restore = installStatefulDb(db, counters);
  try {
    const result = await consumePlaylistChunks(fakeRuntime(), {
      chunks: (async function* () {
        counters.chunksPulled++;
        yield { items: [line("V", 1)], startIndex: 1 };
        counters.chunksPulled++;
        yield { items: [line("V", 2)], startIndex: 2 };
      })(),
      onEmpty: () => ({ url: PLAYLIST, title: "x", status: "failed" }),
      onError: (error) => ({
        url: PLAYLIST,
        title: "x",
        status: "failed",
        error: error.message,
      }),
    }, {
      videoUrl: PLAYLIST,
      isScheduledUpdate: true,
      shouldEmitProgress: false,
      playlistTitle: "P",
      seekPlaylistListTo: 0,
      processKey: "k",
      monitoringType: "Refresh",
    });

    assertEquals(result.status, "completed");
    assertEquals(counters.chunksPulled, 2);
    assertEquals(db.mappings.map((mapping) => mapping.position), [1, 2]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U9 — Start with no overlap: full walk, no shift, all creates
// ---------------------------------------------------------------------------

Deno.test("U9 - Start with the old head missing walks everything", async () => {
  const db: FakeDb = {
    videos: new Set([videoUrlOf("OLD")]),
    mappings: [{
      id: "id-old",
      videoUrl: videoUrlOf("OLD"),
      position: 1,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    }],
  };
  const counters = { updates: 0, chunksPulled: 0 };
  const restore = installStatefulDb(db, counters);
  try {
    const chunks = [
      { items: [line("N1", 1), line("N2", 2)], startIndex: 1 },
      { items: [line("N3", 3)], startIndex: 3 },
    ];
    let stopped = false;
    const result = await consumePlaylistChunks(fakeRuntime(), {
      chunks: (async function* () {
        for (const chunk of chunks) {
          if (stopped) break;
          counters.chunksPulled++;
          yield chunk;
        }
      })(),
      stop: () => {
        stopped = true;
      },
      onEmpty: () => ({ url: PLAYLIST, title: "x", status: "failed" }),
      onError: (error) => ({
        url: PLAYLIST,
        title: "x",
        status: "failed",
        error: error.message,
      }),
    }, {
      videoUrl: PLAYLIST,
      isScheduledUpdate: true,
      shouldEmitProgress: false,
      playlistTitle: "P",
      seekPlaylistListTo: 0,
      processKey: "k",
      monitoringType: "Start",
    });

    assertEquals(counters.chunksPulled, 2);
    assertEquals(counters.updates, 0);
    assertEquals(stopped, false);
    assertEquals(result.status, "completed");
    // The orphaned OLD row is left for manual Full repair, per plan.
    assertEquals(db.mappings.length, 4);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// U10 — End tail window with moves raises the restart flag
// ---------------------------------------------------------------------------

Deno.test("U10 - End tail moves trigger the restart signal", async () => {
  const { calls, restore } = installSingleChunk(
    [videoUrlOf("C"), videoUrlOf("D")],
    [
      { id: "id-c", videoUrl: videoUrlOf("C"), position: 9 },
      { id: "id-d", videoUrl: videoUrlOf("D"), position: 10 },
    ],
  );
  try {
    const reportTailMove = { triggered: false };
    const result = await consumePlaylistChunks(fakeRuntime(), {
      chunks: (async function* () {
        yield { items: [line("C", 7), line("D", 8)], startIndex: 7 };
      })(),
      onEmpty: () => ({ url: PLAYLIST, title: "x", status: "failed" }),
      onError: (error) => ({
        url: PLAYLIST,
        title: "x",
        status: "failed",
        error: error.message,
      }),
    }, {
      videoUrl: PLAYLIST,
      isScheduledUpdate: true,
      shouldEmitProgress: false,
      playlistTitle: "P",
      seekPlaylistListTo: 0,
      processKey: "k",
      monitoringType: "End",
      reportTailMove,
    });

    assertEquals(reportTailMove.triggered, true);
    assertEquals(result.status, "completed");
    // Window rows fixed by update, not duplicated.
    assertEquals(updatedPositions(calls), [7, 8]);
  } finally {
    restore();
  }
});
