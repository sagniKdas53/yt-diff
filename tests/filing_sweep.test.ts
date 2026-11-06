import { assert, assertEquals, assertRejects } from "std/assert/mod.ts";
import { Op } from "sequelize";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";
import {
  type FilingGroup,
  type FilingStore,
  runFilingSweep,
  type UndoCandidates,
  undoFiling,
  type UndoPlan,
} from "../src/handlers/filing/sweep.ts";
import {
  filedPosition,
  nextRealPosition,
} from "../src/handlers/filing/positions.ts";
import type {
  KnownPlaylist,
  UnlistedRow,
} from "../src/handlers/filing/place.ts";
import { clearMappingsForReindex } from "../src/handlers/pipeline/listing.ts";
import {
  findDuplicatePlaylists,
  mergeVideoRecords,
} from "../src/handlers/pipeline/dedup.ts";
import { createMutationHandlers } from "../src/handlers/playlists/mutations.ts";

// ---------------------------------------------------------------------------
// A fake store: the sweep's decisions are tested without a database
// ---------------------------------------------------------------------------

let counter = 0;

function row(overrides: Partial<UnlistedRow> = {}): UnlistedRow {
  counter++;
  return {
    videoUrl: `https://a.example/v/${counter}`,
    site: "a.example",
    channelKey: null,
    channelName: null,
    channelHandle: null,
    durationSeconds: 600,
    addedAt: new Date("2026-01-01T00:00:00Z"),
    realPlaylistUrl: null,
    filing: null,
    hasFiledMapping: false,
    ...overrides,
  };
}

function fakeStore(
  data: {
    rows?: UnlistedRow[];
    playlists?: KnownPlaylist[];
    owners?: Map<string, Map<string, number>>;
    undo?: UndoCandidates;
    withoutFacets?: number;
    failOn?: string;
  } = {},
) {
  const calls = {
    groups: [] as FilingGroup[],
    marked: [] as string[][],
    undone: [] as UndoPlan[],
  };
  const store: FilingStore = {
    countWithoutFacets: () => Promise.resolve(data.withoutFacets ?? 0),
    loadUnlisted: () => Promise.resolve(data.rows ?? []),
    loadPlaylists: () => Promise.resolve(data.playlists ?? []),
    loadOwnerCounts: () => Promise.resolve(data.owners ?? new Map()),
    writeGroup: (group) => {
      if (data.failOn !== undefined && group.playlistUrl === data.failOn) {
        return Promise.reject(new Error("boom"));
      }
      calls.groups.push(group);
      return Promise.resolve();
    },
    markChannelLike: (urls) => {
      calls.marked.push(urls);
      return Promise.resolve();
    },
    loadUndoCandidates: () =>
      Promise.resolve(
        data.undo ?? { negativeMappings: [], filingRows: 0, playlists: [] },
      ),
    applyUndo: (plan) => {
      calls.undone.push(plan);
      return Promise.resolve();
    },
  };
  return { store, calls };
}

const longVideos = (key: string, n: number) =>
  Array.from(
    { length: n },
    () => row({ channelKey: key, channelName: "Chan" }),
  );

Deno.test("filing sweep - a dry run returns the summary and writes nothing", async () => {
  const { store, calls } = fakeStore({
    rows: [
      row({ durationSeconds: 10 }),
      row(),
      ...longVideos("a.example:acct", 3),
    ],
    owners: new Map([["https://p", new Map([["a", 9], ["b", 1]])]]),
  });
  const summary = await runFilingSweep({ apply: false }, store);
  assertEquals(summary.considered, 5);
  assertEquals(summary.toClips, 1);
  assertEquals(summary.toArchive, 1);
  assertEquals(summary.toChannel, 3);
  assertEquals(summary.newChannels, 1);
  assertEquals(summary.channelLikePlaylists, 1);
  assertEquals(calls.groups.length, 0);
  assertEquals(calls.marked.length, 0);
});

Deno.test("filing sweep - a filed mapping's position is minus its added time in seconds, never positive", async () => {
  const added = new Date("2026-03-04T05:06:07.999Z");
  assertEquals(filedPosition(added), -Math.floor(added.getTime() / 1000));
  assert(filedPosition(new Date(0)) < 0, "even the epoch must be negative");
  assert(filedPosition(new Date(500)) < 0);

  const { store, calls } = fakeStore({
    rows: longVideos("a.example:acct", 3).map((r) => ({
      ...r,
      addedAt: added,
    })),
  });
  await runFilingSweep({ apply: true }, store);
  const items = calls.groups.flatMap((g) => g.items);
  assertEquals(items.length, 3);
  for (const item of items) {
    assertEquals(item.position, -Math.floor(added.getTime() / 1000));
  }
});

Deno.test("filing sweep - a video already in the playlist gets no second mapping", async () => {
  const known: KnownPlaylist = {
    playlistUrl: "https://a.example/p/1",
    site: "a.example",
    urlSegments: ["p", "1"],
    monitored: false,
    createdAt: new Date("2025-01-01"),
  };
  const inPlaylist = row({ realPlaylistUrl: "https://a.example/p/1" });
  const byHandle = row({ channelHandle: "p" });
  const { store, calls } = fakeStore({
    rows: [inPlaylist, byHandle],
    playlists: [known],
  });
  await runFilingSweep({ apply: true }, store);
  const items = calls.groups.flatMap((g) => g.items);
  const byUrl = new Map(items.map((i) => [i.videoUrl, i]));
  assertEquals(byUrl.get(inPlaylist.videoUrl)?.createMapping, false);
  assertEquals(byUrl.get(byHandle.videoUrl)?.createMapping, true);
});

Deno.test("filing sweep - a new channel has the auto-channel values", async () => {
  const { store, calls } = fakeStore({ rows: longVideos("a.example:acct", 3) });
  await runFilingSweep({ apply: true }, store);
  const group = calls.groups.find((g) => g.playlistUrl !== null)!;
  assertEquals(group.playlistUrl, "auto:a.example:acct");
  assertEquals(group.createPlaylist, {
    playlistUrl: "auto:a.example:acct",
    title: "Chan",
    kind: "channel",
    origin: "auto",
    sortOrder: -1,
    monitoringType: "N/A",
    saveDirectory: "",
  });
});

Deno.test("filing sweep - an existing auto playlist is reused, not created again", async () => {
  const existing: KnownPlaylist = {
    playlistUrl: "auto:a.example:acct",
    site: "",
    urlSegments: [],
    monitored: false,
    createdAt: new Date("2025-01-01"),
  };
  const { store, calls } = fakeStore({
    rows: longVideos("a.example:acct", 3),
    playlists: [existing],
  });
  const summary = await runFilingSweep({ apply: true }, store);
  assertEquals(summary.newChannels, 0);
  assertEquals(calls.groups[0].createPlaylist, undefined);
});

Deno.test("filing sweep - one failing group is logged and the rest still run", async () => {
  const { store, calls } = fakeStore({
    rows: [
      ...longVideos("a.example:bad", 3),
      ...longVideos("a.example:good", 3),
      row({ durationSeconds: 5 }),
    ],
    failOn: "auto:a.example:bad",
  });
  const summary = await runFilingSweep({ apply: true }, store);
  assertEquals(summary.failedGroups, 1);
  // The failed group's rows are not counted as filed, so the next run retries.
  assertEquals(summary.toChannel, 3);
  assertEquals(summary.toClips, 1);
  assertEquals(
    calls.groups.map((g) => g.playlistUrl).sort(),
    [null, "auto:a.example:good"].sort(),
  );
});

Deno.test("filing sweep - a second run over filed rows changes nothing", async () => {
  const filed = longVideos("a.example:acct", 3).map((r) => ({
    ...r,
    hasFiledMapping: true,
    filing: {
      placement: "channel" as const,
      playlistUrl: "auto:a.example:acct",
      locked: false,
    },
  }));
  const clip = row({
    durationSeconds: 3,
    filing: { placement: "clip", playlistUrl: null, locked: false },
  });
  const { store, calls } = fakeStore({ rows: [...filed, clip] });
  const summary = await runFilingSweep({ apply: true }, store);
  assertEquals(summary.unchanged, 4);
  assertEquals(summary.toChannel + summary.toClips + summary.toArchive, 0);
  assertEquals(calls.groups.length, 0);
});

Deno.test("filing sweep - a sweep marks channel-like playlists and reports rows it could not judge", async () => {
  const { store, calls } = fakeStore({
    rows: [],
    owners: new Map([
      ["https://dominant", new Map([["a", 9], ["b", 1]])],
      ["https://mixed", new Map([["a", 5], ["b", 5]])],
    ]),
    withoutFacets: 7,
  });
  const summary = await runFilingSweep({ apply: true }, store);
  assertEquals(calls.marked, [["https://dominant"]]);
  assertEquals(summary.channelLikePlaylists, 1);
  assertEquals(summary.withoutFacets, 7);
});

Deno.test("filing undo - removes only negative mappings and only empty auto playlists", async () => {
  const undo: UndoCandidates = {
    negativeMappings: [
      { id: "m1", playlistUrl: "auto:emptied" },
      { id: "m2", playlistUrl: "auto:emptied" },
      { id: "m3", playlistUrl: "auto:kept" },
      { id: "m4", playlistUrl: "https://user" },
    ],
    filingRows: 9,
    playlists: [
      {
        playlistUrl: "auto:emptied",
        origin: "auto",
        kindSetByFiling: false,
        mappingCount: 2,
      },
      // Someone added a real mapping, so it is not left empty.
      {
        playlistUrl: "auto:kept",
        origin: "auto",
        kindSetByFiling: false,
        mappingCount: 2,
      },
      {
        playlistUrl: "https://user",
        origin: "user",
        kindSetByFiling: true,
        mappingCount: 1,
      },
    ],
  };
  const { store, calls } = fakeStore({ undo });

  const dry = await undoFiling({ apply: false }, store);
  assertEquals(calls.undone.length, 0);
  assertEquals(dry, {
    mappingsRemoved: 4,
    filingRowsRemoved: 9,
    channelsRemoved: 1,
    kindsReset: 1,
  });

  await undoFiling({ apply: true }, store);
  assertEquals(calls.undone.length, 1);
  assertEquals(calls.undone[0].mappingIds.sort(), ["m1", "m2", "m3", "m4"]);
  assertEquals(calls.undone[0].removeAutoPlaylists, ["auto:emptied"]);
  assertEquals(calls.undone[0].resetKinds, ["https://user"]);
});

Deno.test("filing undo - keeps a promoted channel and a user playlist that was always a channel", async () => {
  const undo: UndoCandidates = {
    negativeMappings: [{ id: "m1", playlistUrl: "https://promoted" }],
    filingRows: 1,
    playlists: [
      // Promoted by Monitor channel: origin is user now, and the job did not
      // set its kind.
      {
        playlistUrl: "https://promoted",
        origin: "user",
        kindSetByFiling: false,
        mappingCount: 1,
      },
    ],
  };
  const { store, calls } = fakeStore({ undo });
  await undoFiling({ apply: true }, store);
  assertEquals(calls.undone[0].removeAutoPlaylists, []);
  assertEquals(calls.undone[0].resetKinds, []);
});

// ---------------------------------------------------------------------------
// Existing code that has to learn about filed rows
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type AnyRecord = Record<string, any>;

/** Shadows an inherited static or instance property; the returned fn restores. */
function stub(target: object, name: string, impl: unknown): () => void {
  const own = Object.prototype.hasOwnProperty.call(target, name);
  const original = (target as AnyRecord)[name];
  (target as AnyRecord)[name] = impl;
  return () => {
    if (own) (target as AnyRecord)[name] = original;
    else delete (target as AnyRecord)[name];
  };
}

Deno.test("reindex - a Full re-index clears only real positions, not filed videos", async () => {
  let where: AnyRecord | null = null;
  const restore = stub(PlaylistVideoMapping, "destroy", (opts: AnyRecord) => {
    where = opts.where;
    return Promise.resolve(0);
  });
  try {
    await clearMappingsForReindex("https://x/playlist", "Full", false);
    assert(where !== null, "the mappings must be cleared");
    const cleared = where as AnyRecord;
    assertEquals(cleared.playlistUrl, "https://x/playlist");
    assertEquals(cleared.positionInPlaylist, { [Op.gte]: 0 });
  } finally {
    restore();
  }
});

function responseStub() {
  const out: { status?: number; body?: string } = {};
  return {
    out,
    response: {
      headersSent: false,
      setHeader: () => {},
      writeHead: (status: number) => {
        out.status = status;
      },
      write: () => {},
      end: (chunk?: string) => {
        out.body = chunk;
      },
    },
  };
}

async function deletePlaylistWith(sortOrder: number) {
  const decrements: AnyRecord[] = [];
  const restores = [
    stub(PlaylistMetadata, "findByPk", () =>
      Promise.resolve({
        title: "T",
        sortOrder,
        saveDirectory: "",
        destroy: () => Promise.resolve(),
      })),
    stub(sequelize, "transaction", () =>
      Promise.resolve({
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      })),
    stub(PlaylistMetadata, "decrement", (_f: string, opts: AnyRecord) => {
      decrements.push(opts);
      return Promise.resolve();
    }),
    stub(PlaylistVideoMapping, "destroy", () => Promise.resolve(0)),
  ];
  try {
    const handlers = createMutationHandlers({
      // deno-lint-ignore no-explicit-any
      listItemsConcurrently: (() => Promise.resolve()) as any,
      safeEmit: () => {},
    });
    const { response, out } = responseStub();
    await handlers.processDeletePlaylistRequest(
      {
        playListUrl: "auto:a.example:acct",
        deletePlaylist: true,
        deleteAllVideosInPlaylist: false,
        cleanUp: false,
      },
      response,
    );
    return { decrements, status: out.status };
  } finally {
    restores.reverse().forEach((r) => r());
  }
}

Deno.test("delplay - deleting an auto channel leaves every other sortOrder alone", async () => {
  const { decrements, status } = await deletePlaylistWith(-1);
  assertEquals(status, 200);
  assertEquals(decrements.length, 0);
});

Deno.test("delplay - deleting a listed playlist still closes the gap behind it", async () => {
  const { decrements } = await deletePlaylistWith(3);
  assertEquals(decrements.length, 1);
  assertEquals(decrements[0].where, { sortOrder: { [Op.gt]: 3 } });
});

async function mergeDuplicateAt(removedPosition: number) {
  const decrements: AnyRecord[] = [];
  const meta = (url: string) => ({
    getDataValue: (key: string) => (key === "videoUrl" ? url : null),
    update: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  });
  const duplicateMapping = {
    getDataValue: (key: string) =>
      ({
        playlistUrl: "https://p/1",
        positionInPlaylist: removedPosition,
      })[key],
    destroy: () => Promise.resolve(),
    update: () => Promise.resolve(),
  };
  const restores = [
    stub(sequelize, "transaction", () =>
      Promise.resolve({
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      })),
    stub(
      VideoMetadata,
      "findOne",
      (opts: AnyRecord) => Promise.resolve(meta(opts.where.videoUrl)),
    ),
    stub(
      PlaylistVideoMapping,
      "findAll",
      () => Promise.resolve([duplicateMapping]),
    ),
    stub(
      PlaylistVideoMapping,
      "findOne",
      () => Promise.resolve({ getDataValue: () => 4 }),
    ),
    stub(PlaylistVideoMapping, "decrement", (_f: string, opts: AnyRecord) => {
      decrements.push(opts);
      return Promise.resolve();
    }),
  ];
  try {
    await mergeVideoRecords({
      videoId: "id",
      urls: ["canon", "dup"],
      canonicalUrl: "canon",
      canonicalReason: "test",
      canonicalPlaylists: [],
      duplicateUrls: ["dup"],
    });
    return decrements;
  } finally {
    restores.reverse().forEach((r) => r());
  }
}

Deno.test("dedup - merging a duplicate with a filed position decrements nothing", async () => {
  assertEquals((await mergeDuplicateAt(-1700000000)).length, 0);
});

Deno.test("dedup - merging a duplicate at a real position closes the gap", async () => {
  const decrements = await mergeDuplicateAt(2);
  assertEquals(decrements.length, 1);
  assertEquals(decrements[0].where.positionInPlaylist, { [Op.gt]: 2 });
});

Deno.test("dedup - auto channels are never offered as duplicate playlists", async () => {
  const playlistRow = (url: string) => ({
    getDataValue: (key: string) =>
      ({
        playlistUrl: url,
        saveDirectory: "",
        updatedAt: new Date("2026-01-01"),
      })[key],
  });
  // A key built from a channel URL can carry a tracking parameter, and the
  // canonicalizer strips those: these two distinct channels would look like
  // one playlist, and the merge would fold one into the other.
  const restore = stub(PlaylistMetadata, "findAll", () =>
    Promise.resolve([
      playlistRow("auto:a.example:https://a.example/u/x"),
      playlistRow("auto:a.example:https://a.example/u/x?utm_source=feed"),
    ]));
  try {
    assertEquals(await findDuplicatePlaylists(), []);
  } finally {
    restore();
  }
});

Deno.test("listing - the next position after a filed-only playlist is 1", () => {
  assertEquals(nextRealPosition(null), 1);
  assertEquals(nextRealPosition(undefined), 1);
  assertEquals(nextRealPosition(-1700000000), 1);
  assertEquals(nextRealPosition(0), 1);
  assertEquals(nextRealPosition(41), 42);
});

Deno.test("filing sweep - a failing read surfaces to the caller", async () => {
  const { store } = fakeStore();
  store.loadUnlisted = () => Promise.reject(new Error("db down"));
  await assertRejects(
    () => runFilingSweep({ apply: false }, store),
    Error,
    "db down",
  );
});
