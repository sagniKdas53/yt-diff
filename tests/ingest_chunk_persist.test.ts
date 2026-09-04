import { assert, assertEquals } from "std/assert/mod.ts";
import {
  persistStreamingChunk,
  processStreamingVideoInformation,
} from "../src/handlers/pipeline/ingest-chunk.ts";
import {
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";
import type {
  PlaylistMappingCreate,
  PlaylistMappingUpdate,
  VideoUpsertData,
} from "../src/handlers/pipeline/types.ts";

/**
 * `persistStreamingChunk` reaches the DB through direct module imports, so the
 * seam is the models themselves. Assigning here shadows the inherited statics
 * with own properties; `delete` restores the prototype lookup. Importing the
 * module opens no connection — Sequelize is lazy until a query actually runs.
 */
interface Call {
  model: string;
  rows: Record<string, unknown>[];
  options: Record<string, unknown>;
  inTransaction: boolean;
}

const TRANSACTION = { id: "stub-transaction" };

function install(
  onCall?: (call: Call) => void,
): { calls: Call[]; restore: () => void; transactions: number } {
  const calls: Call[] = [];
  const state = { transactions: 0 };

  const record = (model: string) =>
  // deno-lint-ignore no-explicit-any
  (rows: any[], options: any = {}) => {
    const call: Call = {
      model,
      rows,
      options,
      inTransaction: options.transaction === TRANSACTION,
    };
    calls.push(call);
    onCall?.(call);
    return Promise.resolve(rows);
  };

  // deno-lint-ignore no-explicit-any
  const unscoped = (VideoMetadata as any).unscoped;
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).unscoped = () => ({
    bulkCreate: record("VideoMetadata"),
  });
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).bulkCreate = record("PlaylistVideoMapping");
  // deno-lint-ignore no-explicit-any
  (sequelize as any).transaction = async (
    fn: (t: unknown) => Promise<void>,
  ) => {
    state.transactions++;
    await fn(TRANSACTION);
  };

  return {
    calls,
    get transactions() {
      return state.transactions;
    },
    restore: () => {
      // deno-lint-ignore no-explicit-any
      (VideoMetadata as any).unscoped = unscoped;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistVideoMapping as any).bulkCreate;
      // deno-lint-ignore no-explicit-any
      delete (sequelize as any).transaction;
    },
  };
}

const CREATED_AT = new Date("2020-01-01T00:00:00.000Z");

function mapping(id: string, position: number): PlaylistMappingUpdate {
  return {
    instance: {
      getDataValue: (key: string) =>
        ({
          id,
          videoUrl: `https://example.com/v/${id}`,
          playlistUrl: "https://example.com/p/1",
          positionInPlaylist: position + 100,
          createdAt: CREATED_AT,
        })[key],
      // deno-lint-ignore no-explicit-any
    } as any,
    position,
  };
}

const video: VideoUpsertData = {
  videoUrl: "https://example.com/v/a",
  videoId: "a",
  title: "A",
  approximateSize: 1,
  downloadStatus: false,
  isAvailable: true,
  onlineThumbnail: null,
  // deno-lint-ignore no-explicit-any
  raw_metadata: {} as any,
};

const create: PlaylistMappingCreate = {
  videoUrl: "https://example.com/v/a",
  playlistUrl: "https://example.com/p/1",
  positionInPlaylist: 1,
};

Deno.test("persistStreamingChunk - all three writes share one transaction", async () => {
  // Q8: these ran back to back, unwrapped. A failure between them left videos
  // upserted with mappings missing, or positions half-shifted.
  const stub = install();
  try {
    await persistStreamingChunk({
      videosToUpsert: [video],
      mappingsToCreate: [create],
      mappingsToUpdate: [mapping("11111111-1111-1111-1111-111111111111", 3)],
    });

    assertEquals(stub.calls.map((c) => c.model), [
      "VideoMetadata",
      "PlaylistVideoMapping",
      "PlaylistVideoMapping",
    ]);
    assertEquals(stub.transactions, 1);
    assert(
      stub.calls.every((c) => c.inTransaction),
      "every write must carry the transaction",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("persistStreamingChunk - a failing write rolls the whole chunk back", async () => {
  const stub = install((call) => {
    if (call.model === "PlaylistVideoMapping") {
      throw new Error("mapping insert failed");
    }
  });
  try {
    let thrown: Error | null = null;
    await persistStreamingChunk({
      videosToUpsert: [video],
      mappingsToCreate: [create],
      mappingsToUpdate: [mapping("11111111-1111-1111-1111-111111111111", 3)],
    }).catch((e) => {
      thrown = e as Error;
    });

    assert(
      thrown !== null,
      "the failure must propagate out of the transaction",
    );
    // The renumber never ran: the transaction aborted at the mapping insert,
    // so the video upsert that preceded it is rolled back rather than left
    // standing on its own.
    assertEquals(stub.calls.map((c) => c.model), [
      "VideoMetadata",
      "PlaylistVideoMapping",
    ]);
  } finally {
    stub.restore();
  }
});

Deno.test("persistStreamingChunk - the renumber upserts on the primary key", async () => {
  // Q8: this was a hand-built `SET "positionInPlaylist" = CASE WHEN "id" = …`
  // string, the one place the pipeline abandoned the ORM.
  const stub = install();
  try {
    await persistStreamingChunk({
      videosToUpsert: [],
      mappingsToCreate: [],
      mappingsToUpdate: [
        mapping("11111111-1111-1111-1111-111111111111", 3),
        mapping("22222222-2222-2222-2222-222222222222", 4),
      ],
    });

    assertEquals(stub.calls.length, 1);
    const [renumber] = stub.calls;
    assertEquals(renumber.options.conflictAttributes, ["id"]);
    assertEquals(renumber.options.updateOnDuplicate, [
      "positionInPlaylist",
      "updatedAt",
    ]);
    assertEquals(renumber.rows.map((r) => r.positionInPlaylist), [3, 4]);
    assertEquals(renumber.rows.map((r) => r.id), [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
    // The insert half of the upsert has to be well-formed even though it never
    // fires: every NOT NULL column is carried through from the existing row.
    for (const row of renumber.rows) {
      assertEquals(row.playlistUrl, "https://example.com/p/1");
      assertEquals(row.createdAt, CREATED_AT);
      assert(typeof row.videoUrl === "string" && row.videoUrl.length > 0);
      assert(row.updatedAt instanceof Date);
    }
  } finally {
    stub.restore();
  }
});

Deno.test("persistStreamingChunk - an empty chunk opens no transaction", async () => {
  const stub = install();
  try {
    await persistStreamingChunk({
      videosToUpsert: [],
      mappingsToCreate: [],
      mappingsToUpdate: [],
    });
    assertEquals(stub.transactions, 0);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

/**
 * Positions come from the source, not from counting what arrived.
 *
 * yt-dlp skips items it cannot extract — private, deleted, age-gated — and
 * says so on stderr while stdout carries on. On
 * `iwara.tv/profile/muta81/videos` on 2026-09-04 the first five uploads were
 * private, so the sixth video was written at position 1, and by the eighth
 * chunk the offset had grown to 38. These drive the real shape of that data.
 */

/** Stubs the two reads `processStreamingVideoInformation` makes. */
function installReads(): { restore: () => void } {
  // deno-lint-ignore no-explicit-any
  (VideoMetadata as any).findAll = () => Promise.resolve([]);
  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).findAll = () => Promise.resolve([]);
  return {
    restore: () => {
      // deno-lint-ignore no-explicit-any
      delete (VideoMetadata as any).findAll;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistVideoMapping as any).findAll;
    },
  };
}

/** One yt-dlp `--dump-json` line, with or without the reported position. */
function line(id: string, playlistIndex?: number): string {
  return JSON.stringify({
    webpage_url: `https://iwara.tv/video/${id}`,
    id,
    title: `video ${id}`,
    filesize_approx: "NA",
    ...(playlistIndex === undefined ? {} : { playlist_index: playlistIndex }),
  });
}

function positionsWritten(calls: Call[]): number[] {
  return calls
    .filter((call) => call.model === "PlaylistVideoMapping")
    .flatMap((call) => call.rows)
    .map((row) => row.positionInPlaylist as number);
}

Deno.test("processStreamingVideoInformation - skipped items do not shift the ones after them", async () => {
  // The muta81 first chunk exactly: five private uploads skipped, so the ten
  // lines that arrive are playlist positions 6-15 while the chunk still
  // believes it starts at 1.
  const reads = installReads();
  const { calls, restore } = install();
  try {
    await processStreamingVideoInformation(
      Array.from({ length: 10 }, (_v, i) => line(`v${i}`, i + 6)),
      "https://www.iwara.tv/profile/muta81/videos",
      1,
      false,
    );

    assertEquals(positionsWritten(calls), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  } finally {
    restore();
    reads.restore();
  }
});

Deno.test("processStreamingVideoInformation - the drift does not accumulate down the playlist", async () => {
  // Eighth chunk, offset grown to 38: counting would store 71-80.
  const reads = installReads();
  const { calls, restore } = install();
  try {
    await processStreamingVideoInformation(
      Array.from({ length: 10 }, (_v, i) => line(`v${i}`, i + 109)),
      "https://www.iwara.tv/profile/muta81/videos",
      71,
      false,
    );

    assertEquals(positionsWritten(calls)[0], 109);
    assertEquals(positionsWritten(calls).at(-1), 118);
  } finally {
    restore();
    reads.restore();
  }
});

Deno.test("processStreamingVideoInformation - a source with no reported position still counts", async () => {
  // The single-video path emits no playlist_index, and neither did the
  // YouTube API path before it was taught to.
  const reads = installReads();
  const { calls, restore } = install();
  try {
    await processStreamingVideoInformation(
      Array.from({ length: 3 }, (_v, i) => line(`v${i}`)),
      "https://www.iwara.tv/profile/muta81/videos",
      21,
      false,
    );

    assertEquals(positionsWritten(calls), [21, 22, 23]);
  } finally {
    restore();
    reads.restore();
  }
});

Deno.test("processStreamingVideoInformation - a nonsense position falls back to counting", async () => {
  const reads = installReads();
  const { calls, restore } = install();
  try {
    await processStreamingVideoInformation(
      [line("a", 0), line("b", -3), line("c")],
      "https://www.iwara.tv/profile/muta81/videos",
      5,
      false,
    );

    assertEquals(positionsWritten(calls), [5, 6, 7]);
  } finally {
    restore();
    reads.restore();
  }
});

Deno.test("processStreamingVideoInformation - the None pseudo-playlist ignores positions entirely", async () => {
  // Everything there sits at the index the caller chose; it is not an ordered
  // playlist and a reported position would be meaningless in it.
  const reads = installReads();
  const { calls, restore } = install();
  try {
    await processStreamingVideoInformation(
      [line("a", 6), line("b", 7)],
      "None",
      99,
      false,
    );

    assertEquals(positionsWritten(calls), [99, 99]);
  } finally {
    restore();
    reads.restore();
  }
});
