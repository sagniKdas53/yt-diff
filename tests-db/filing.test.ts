/**
 * Filing against a real Postgres, loaded from the test data pack.
 *
 * Needs Docker. Every test reloads `seed/load.sh`, which starts (or reuses) a
 * throwaway database on localhost:55432 held in memory, so a test can't depend
 * on what an earlier one left. Run with `deno task test:db`.
 *
 * The environment is set before anything imports the models, because they
 * read it once, at import. This never connects to anything but that database.
 */
import { assert, assertEquals, assertNotEquals } from "std/assert/mod.ts";

Deno.env.set("DB_HOST", "localhost");
Deno.env.set("DB_PORT", "55432");
Deno.env.set("DB_USERNAME", "ytdiff");
Deno.env.set("DB_PASSWORD", "testpassword");
Deno.env.set("SECRET_KEY", "seed-secret-key-not-used-anywhere-else");

const { QueryTypes, Op } = await import("sequelize");
const { sequelize, PlaylistVideoMapping } = await import(
  "../src/db/models.ts"
);
const { runFilingSweep, undoFiling } = await import(
  "../src/handlers/filing/sweep.ts"
);
const { backfillBatch, emptyTotals } = await import(
  "../scripts/facets_backfill.ts"
);
const { clearMappingsForReindex, resolveStartIndex } = await import(
  "../src/handlers/pipeline/listing.ts"
);
const { processStreamingVideoInformation } = await import(
  "../src/handlers/pipeline/ingest-chunk.ts"
);
const { locateVideo } = await import("../src/handlers/pipeline/locate.ts");

const LOAD_SH = new URL(
  "../docs/plans/watch-first/seed/load.sh",
  import.meta.url,
).pathname;
const END_PLAYLIST = "https://match.example/@match-me/videos";
const MIXED_PLAYLIST = "https://match.example/playlist?list=mixed";

const dbTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await reload();
      await fn();
    },
  });

/** Reloads the pack and edge cases, then fills the facets as a deploy would. */
async function reload() {
  const out = await new Deno.Command("bash", {
    args: [LOAD_SH],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `seed/load.sh failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const totals = emptyTotals();
  let cursor: string | null = null;
  do {
    cursor = await backfillBatch(cursor, totals);
  } while (cursor !== null);
}

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return await sequelize.query(sql, { type: QueryTypes.SELECT }) as T[];
}

async function count(sql: string): Promise<number> {
  const [row] = await rows<{ n: string }>(sql);
  return Number(row.n);
}

/** The counts undo has to restore. */
async function shape() {
  return {
    mappings: await count(`SELECT COUNT(*) n FROM playlist_video_mappings`),
    none: await count(
      `SELECT COUNT(*) n FROM playlist_video_mappings WHERE "playlistUrl" = 'None'`,
    ),
    playlists: await count(`SELECT COUNT(*) n FROM playlist_metadata`),
    videos: await count(`SELECT COUNT(*) n FROM video_metadata`),
    kinds: await rows(
      `SELECT "playlistUrl", kind, "sortOrder" FROM playlist_metadata ORDER BY "playlistUrl"`,
    ),
  };
}

/** Where a video was filed, in the words of the plan's table. */
async function placementOf(url: string): Promise<string> {
  const [row] = await rows<
    { placement: string; playlistUrl: string | null; saved: boolean }
  >(
    `SELECT f.placement, f."playlistUrl", v."downloadStatus" AS saved
     FROM video_filing f JOIN video_metadata v USING ("videoUrl")
     WHERE f."videoUrl" = '${url.replaceAll("'", "''")}'`,
  );
  if (!row) return "unfiled";
  if (row.placement === "playlist") return `playlist ${row.playlistUrl}`;
  if (row.placement === "channel") return "channel";
  if (row.placement === "clip") return "clip";
  return row.saved ? "archive saved" : "archive links";
}

const apply = () => runFilingSweep({ apply: true });

dbTest(
  "filing db - the pack and edge cases land on the expected totals",
  async () => {
    const summary = await apply();
    assertEquals(summary.considered, 581);
    assertEquals(summary.failedGroups, 0);
    assertEquals(summary.withoutFacets, 0);

    const [t] = await rows<Record<string, string>>(`
    SELECT
      COUNT(*) FILTER (WHERE f.placement = 'playlist') AS in_playlist,
      COUNT(*) FILTER (WHERE f.placement = 'clip') AS clips,
      COUNT(*) FILTER (WHERE f.placement = 'channel') AS in_channels,
      COUNT(DISTINCT f."playlistUrl") FILTER (WHERE f.placement = 'channel') AS channels,
      COUNT(*) FILTER (WHERE f.placement = 'archive' AND v."downloadStatus") AS saved,
      COUNT(*) FILTER (WHERE f.placement = 'archive' AND NOT v."downloadStatus") AS links,
      COUNT(*) AS total
    FROM video_filing f JOIN video_metadata v USING ("videoUrl")`);
    assertEquals(
      Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)])),
      {
        in_playlist: 44,
        clips: 148,
        in_channels: 23,
        channels: 6,
        saved: 45,
        links: 321,
        total: 581,
      },
    );
  },
);

dbTest("filing db - every edge row is placed where the plan says", async () => {
  await apply();
  const expectations: Array<[string, string]> = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n): [string, string] => [
      `https://clips.example/${
        ["a", "b", "c", "n", "n", "n", "e"][n - 1]
      }/status/${n}`,
      "clip",
    ]),
    ["https://clips.example/f/status/8", "archive saved"],
    ["https://clips.example/g/status/9", "archive saved"],
    ["https://www.edge.example/v/1", "channel"],
    ["https://m.edge.example/v/2", "channel"],
    ["https://edge.example/v/3", "channel"],
    ["https://other.example/v/1", "archive links"],
    ["https://other.example/v/2", "archive links"],
    ["https://match.example/v/1", `playlist ${END_PLAYLIST}`],
    ["https://match.example/v/2", "archive links"],
    ["https://nodata.example/v/1", "archive links"],
    ["https://nodata.example/v/2", "archive links"],
    ["https://nodata.example/v/3", "archive saved"],
    ["https://nodata.example/v/4", "archive saved"],
    ["https://nodata.example/tie/1", "archive links"],
    ["https://nodata.example/tie/2", "archive links"],
  ];
  for (const [url, expected] of expectations) {
    assertEquals(await placementOf(url), expected, url);
  }

  const kinds = Object.fromEntries(
    (await rows<{ playlistUrl: string; kind: string }>(
      `SELECT "playlistUrl", kind FROM playlist_metadata
       WHERE "playlistUrl" IN ('${END_PLAYLIST}', '${MIXED_PLAYLIST}')`,
    )).map((r) => [r.playlistUrl, r.kind]),
  );
  assertEquals(kinds[END_PLAYLIST], "channel");
  assertEquals(kinds[MIXED_PLAYLIST], "playlist");
});

dbTest(
  "filing db - every Unlisted row has one filing row, and nothing is deleted",
  async () => {
    const before = await shape();
    await apply();
    const after = await shape();

    assertEquals(after.none, before.none);
    assertEquals(after.videos, before.videos);
    assertEquals(
      await count(`
      SELECT COUNT(*) n FROM playlist_video_mappings m
      WHERE m."playlistUrl" = 'None'
        AND (SELECT COUNT(*) FROM video_filing f WHERE f."videoUrl" = m."videoUrl") <> 1`),
      0,
    );
    assertEquals(await count(`SELECT COUNT(*) n FROM video_filing`), 581);
  },
);

dbTest("filing db - a second sweep reports everything unchanged", async () => {
  await apply();
  const second = await apply();
  assertEquals(second.unchanged, 581);
  assertEquals(
    second.toPlaylist + second.toChannel + second.toClips + second.toArchive,
    0,
  );
  assertEquals(second.newChannels, 0);
  assertEquals(second.channelLikePlaylists, 0);
});

dbTest(
  "filing db - undo restores the counts, the kinds and the sort orders",
  async () => {
    const before = await shape();
    await apply();
    assertNotEquals((await shape()).mappings, before.mappings);

    const undone = await undoFiling({ apply: true });
    assert(undone.mappingsRemoved > 0);
    assertEquals(await shape(), before);
    assertEquals(await count(`SELECT COUNT(*) n FROM video_filing`), 0);
  },
);

dbTest(
  "filing db - bot submissions are untouched, expiry included",
  async () => {
    const snapshot = () =>
      rows(`SELECT * FROM bot_submissions ORDER BY id`).then(JSON.stringify);
    const before = await snapshot();
    await apply();
    assertEquals(await snapshot(), before);
    await undoFiling({ apply: true });
    assertEquals(await snapshot(), before);
  },
);

dbTest(
  "filing db - the hostile key becomes one channel and nothing is dropped",
  async () => {
    await apply();
    const channels = await rows<{ playlistUrl: string; site: string }>(`
    SELECT DISTINCT f."playlistUrl", v.site
    FROM video_filing f JOIN video_metadata v USING ("videoUrl")
    WHERE v.site = 'edge.example' AND f.placement = 'channel'`);
    assertEquals(channels.length, 1);
    assert(channels[0].playlistUrl.startsWith("auto:edge.example:"));
    assertEquals(
      await count(
        `SELECT COUNT(*) n FROM video_metadata WHERE site = 'edge.example'`,
      ),
      3,
    );
    // The same id on another site is another channel, and two videos aren't enough.
    assertEquals(
      await placementOf("https://other.example/v/1"),
      "archive links",
    );
  },
);

dbTest(
  "filing db - the End playlist starts its tail scan from the same place",
  async () => {
    const before = await resolveStartIndex(END_PLAYLIST, 2, "End");
    await apply();
    assertEquals(await resolveStartIndex(END_PLAYLIST, 2, "End"), before);
  },
);

dbTest(
  "filing db - a listing moves a filed video to its real position",
  async () => {
    await apply();
    const url = "https://match.example/v/1";
    const [filed] = await rows<{ positionInPlaylist: number }>(
      `SELECT "positionInPlaylist" FROM playlist_video_mappings
     WHERE "videoUrl" = '${url}' AND "playlistUrl" = '${END_PLAYLIST}'`,
    );
    assert(filed.positionInPlaylist < 0, "the mapping starts out filed");

    await processStreamingVideoInformation(
      [JSON.stringify({
        webpage_url: url,
        id: "1",
        title: "Matches monitored",
        filesize_approx: "NA",
        playlist_index: 4,
        uploader_id: "@Match-Me",
        duration: 500,
      })],
      END_PLAYLIST,
      4,
      true,
      "End",
    );

    const after = await rows<{ positionInPlaylist: number }>(
      `SELECT "positionInPlaylist" FROM playlist_video_mappings
     WHERE "videoUrl" = '${url}' AND "playlistUrl" = '${END_PLAYLIST}'`,
    );
    assertEquals(after.length, 1, "no second row");
    assertEquals(after[0].positionInPlaylist, 4);
  },
);

for (const sortDownloaded of [false, true]) {
  dbTest(
    `filing db - /locate agrees with the list order (sortDownloaded ${sortDownloaded})`,
    async () => {
      await apply();

      // Spelled out in SQL rather than through listOrder, so this checks the
      // direction as well as the agreement: Unlisted runs newest first, a real
      // playlist or channel oldest position first.
      const indexIn = async (playlistUrl: string, videoUrl: string) => {
        const direction = playlistUrl === "None" ? "DESC" : "ASC";
        const lead = sortDownloaded ? `v."downloadStatus" DESC, ` : "";
        const ordered = await rows<{ videoUrl: string }>(`
          SELECT m."videoUrl" FROM playlist_video_mappings m
          JOIN video_metadata v USING ("videoUrl")
          WHERE m."playlistUrl" = '${playlistUrl.replaceAll("'", "''")}'
          ORDER BY ${lead}m."positionInPlaylist" ${direction}, m.id ${direction}`);
        return ordered.findIndex((m) => m.videoUrl === videoUrl);
      };

      // A video in an auto channel: the link opens the channel, not Unlisted.
      const inChannel = "https://m.edge.example/v/2";
      const channel = await locateVideo(inChannel, {
        pageSize: 1,
        sortDownloaded,
      });
      assert(channel.playlistUrl?.startsWith("auto:edge.example:"));
      assertEquals(
        channel.page,
        await indexIn(channel.playlistUrl!, inChannel),
      );

      // Two videos tied on one position: each page is where /getsub puts it.
      const pages = new Set<number | null>();
      for (const tied of [1, 2]) {
        const url = `https://nodata.example/tie/${tied}`;
        const located = await locateVideo(url, { pageSize: 1, sortDownloaded });
        assertEquals(located.page, await indexIn("None", url));
        pages.add(located.page);
      }
      assertEquals(pages.size, 2, "tied rows must not share a page");
    },
  );
}

dbTest("filing db - a Full re-index keeps the filed video", async () => {
  await apply();
  const url = "https://match.example/v/1";
  await clearMappingsForReindex(END_PLAYLIST, "Full", false);
  const left = await rows<{ videoUrl: string }>(
    `SELECT "videoUrl" FROM playlist_video_mappings WHERE "playlistUrl" = '${END_PLAYLIST}'`,
  );
  assertEquals(left.map((r) => r.videoUrl), [url]);
});

dbTest("filing db - a filed video you removed stays in Archive", async () => {
  await apply();
  const url = "https://match.example/v/1";
  await PlaylistVideoMapping.destroy({
    where: {
      videoUrl: url,
      playlistUrl: END_PLAYLIST,
      positionInPlaylist: { [Op.lt]: 0 },
    },
  });
  await apply();
  const [row] = await rows<{ placement: string; locked: boolean }>(
    `SELECT placement, locked FROM video_filing WHERE "videoUrl" = '${url}'`,
  );
  assertEquals(row, { placement: "archive", locked: true });
  // And the next sweep leaves it there.
  const again = await apply();
  assertEquals(again.toPlaylist, 0);
  assertEquals(await placementOf(url), "archive links");
});

Deno.test({
  name: "filing db - close the connection",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await sequelize.close();
  },
});
