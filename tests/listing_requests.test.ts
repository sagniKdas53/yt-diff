import { assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import type { Model } from "sequelize";
import {
  buildDownloadLocation,
  getExistingPlaylistMentions,
  getVideoDisplayLabel,
} from "../src/handlers/pipeline/listing-requests.ts";
import { PlaylistMetadata, PlaylistVideoMapping } from "../src/db/models.ts";
import { config } from "../src/config.ts";
import { join } from "../src/utils/path.ts";

/**
 * These three came out of `createListingFlow` with the Q10 split. They were
 * nested closures before, reachable only by running a listing; as plain
 * exports they can be called directly, which is the whole point of the split
 * and is what these tests exercise.
 *
 * The DB seam is the same one `ingest_chunk_persist.test.ts` uses: assigning
 * over a model's static shadows the inherited method with an own property,
 * and `delete` puts the prototype lookup back.
 */

/** A stand-in for the plain model rows both functions read. */
function row(values: Record<string, unknown>): Model {
  return {
    getDataValue: (key: string) => values[key],
  } as unknown as Model;
}

Deno.test("buildDownloadLocation - no directory and no file means no location", () => {
  assertEquals(
    buildDownloadLocation(row({ saveDirectory: null, fileName: null })),
    null,
  );
});

Deno.test("buildDownloadLocation - a file lands under its directory", () => {
  assertEquals(
    buildDownloadLocation(
      row({ saveDirectory: "Some Playlist", fileName: "video.mp4" }),
    ),
    join(config.saveLocation, "Some Playlist", "video.mp4"),
  );
});

Deno.test("buildDownloadLocation - a directory with no file is the directory", () => {
  assertEquals(
    buildDownloadLocation(
      row({ saveDirectory: "Some Playlist", fileName: null }),
    ),
    join(config.saveLocation, "Some Playlist"),
  );
});

Deno.test("buildDownloadLocation - a file with no directory sits at the root", () => {
  // The row an unlisted video upserts to: downloaded, but never filed under a
  // playlist directory.
  assertEquals(
    buildDownloadLocation(row({ saveDirectory: null, fileName: "video.mp4" })),
    join(config.saveLocation, "video.mp4"),
  );
});

Deno.test("getVideoDisplayLabel - prefers the title", () => {
  assertEquals(
    getVideoDisplayLabel(
      row({ title: "A video", videoUrl: "https://e.com/v", videoId: "v1" }),
    ),
    "A video",
  );
});

Deno.test("getVideoDisplayLabel - falls back through url, then id, then a word", () => {
  assertEquals(
    getVideoDisplayLabel(
      row({ title: null, videoUrl: "https://e.com/v", videoId: "v1" }),
    ),
    "https://e.com/v",
  );
  assertEquals(
    getVideoDisplayLabel(row({ title: "", videoUrl: "", videoId: "v1" })),
    "v1",
  );
  assertEquals(
    getVideoDisplayLabel(row({ title: null, videoUrl: null, videoId: null })),
    "video",
  );
});

/** Installs both `findAll` stubs and hands back the undo. */
function stubMentions(
  mappings: Record<string, unknown>[],
  playlists: Record<string, unknown>[],
): { restore: () => void; mappingQueries: Record<string, unknown>[] } {
  const mappingQueries: Record<string, unknown>[] = [];

  // deno-lint-ignore no-explicit-any
  (PlaylistVideoMapping as any).findAll = (options: any) => {
    mappingQueries.push(options);
    return Promise.resolve(mappings.map(row));
  };
  // deno-lint-ignore no-explicit-any
  (PlaylistMetadata as any).findAll = () => Promise.resolve(playlists.map(row));

  return {
    mappingQueries,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      delete (PlaylistVideoMapping as any).findAll;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistMetadata as any).findAll;
    },
  };
}

Deno.test("getExistingPlaylistMentions - ordered by sort order, then position", async () => {
  const { restore } = stubMentions(
    [
      { playlistUrl: "https://e.com/b", positionInPlaylist: 7 },
      { playlistUrl: "https://e.com/a", positionInPlaylist: 3 },
      { playlistUrl: "https://e.com/a", positionInPlaylist: 1 },
    ],
    [
      { playlistUrl: "https://e.com/a", title: "Alpha", sortOrder: 0 },
      { playlistUrl: "https://e.com/b", title: "Bravo", sortOrder: 1 },
    ],
  );

  try {
    const mentions = await getExistingPlaylistMentions("https://e.com/watch");
    assertEquals(
      mentions.map((mention) => [mention.title, mention.positionInPlaylist]),
      [["Alpha", 1], ["Alpha", 3], ["Bravo", 7]],
    );
  } finally {
    restore();
  }
});

Deno.test("getExistingPlaylistMentions - the unlisted pseudo-playlist is excluded", async () => {
  const { restore, mappingQueries } = stubMentions([], []);

  try {
    assertEquals(await getExistingPlaylistMentions("https://e.com/watch"), []);
    // "None" is the unlisted bucket, not a playlist a user can open, so it
    // must never be reported as a mention. Asserted on the query rather than
    // the result, because a stub cannot show a row being filtered out.
    // deno-lint-ignore no-explicit-any
    const where = (mappingQueries[0] as any).where;
    assertEquals(where.playlistUrl[Op.ne], "None");
  } finally {
    restore();
  }
});

Deno.test("getExistingPlaylistMentions - a mapping whose playlist row is gone is dropped", async () => {
  // A deleted playlist can leave a mapping behind; reporting it would name a
  // playlist the UI cannot open.
  const { restore } = stubMentions(
    [
      { playlistUrl: "https://e.com/gone", positionInPlaylist: 2 },
      { playlistUrl: "https://e.com/a", positionInPlaylist: 5 },
    ],
    [{ playlistUrl: "https://e.com/a", title: "Alpha", sortOrder: 0 }],
  );

  try {
    const mentions = await getExistingPlaylistMentions("https://e.com/watch");
    assertEquals(mentions.map((mention) => mention.playlistUrl), [
      "https://e.com/a",
    ]);
  } finally {
    restore();
  }
});
