/**
 * Views, filters and the side effects of filing, against a real Postgres.
 *
 * Needs Docker; see support.ts. Run with `deno task test:db`. Expected counts
 * are computed by plain SQL in each test, written independently of the code
 * under test, so a filter that agrees with itself but not with the data fails.
 */
import { assert, assertEquals } from "std/assert/mod.ts";
import {
  closeTest,
  count,
  dbTest,
  END_PLAYLIST,
  PlaylistVideoMapping,
  quote,
  rows,
  sequelize,
} from "./support.ts";

const { VideoMetadata } = await import("../src/db/models.ts");
const { config } = await import("../src/config.ts");
const { runFilingSweep } = await import("../src/handlers/filing/sweep.ts");
const { buildLibraryFilter } = await import("../src/handlers/filing/views.ts");
const { createQueryHandlers } = await import(
  "../src/handlers/playlists/queries.ts"
);
const { locateVideo } = await import("../src/handlers/pipeline/locate.ts");
const { resolveVideoPlaylist } = await import(
  "../src/handlers/pipeline/download-location.ts"
);
const { createSequelizeRetentionStore, reapExpiredSubmissions } = await import(
  "../src/bot/retention.ts"
);

const handlers = createQueryHandlers({
  // deno-lint-ignore no-explicit-any
  listItemsConcurrently: (() => Promise.resolve([])) as any,
  safeEmit: () => {},
});

interface SubListBody {
  count: number;
  rows: Array<{ video_metadatum: { videoUrl: string } }>;
}

/** Calls the real `/getsub` handler and returns what it would have sent. */
async function getsub(body: Record<string, unknown> = {}) {
  let status = 0;
  let text = "";
  await handlers.getSubListVideos(
    { url: "None", start: 0, stop: 5000, ...body },
    {
      headersSent: false,
      setHeader: () => {},
      writeHead: (s: number) => {
        status = s;
      },
      write: () => {},
      end: (chunk?: string | Uint8Array) => {
        text = typeof chunk === "string"
          ? chunk
          : new TextDecoder().decode(chunk);
      },
    },
  );
  const parsed = JSON.parse(text) as SubListBody;
  return {
    status,
    count: parsed.count,
    urls: (parsed.rows ?? []).map((r) => r.video_metadatum.videoUrl),
  };
}

const NONE = `FROM playlist_video_mappings m
  JOIN video_metadata v USING ("videoUrl")
  WHERE m."playlistUrl" = 'None'`;
const sweep = () => runFilingSweep({ apply: true });
const tz = quote(config.timeZone);

dbTest(
  "views db - clips and archive never share a row, and with the playlists add up to Unlisted",
  async () => {
    await sweep();
    const clips = await getsub({ view: "clips" });
    const archive = await getsub({ view: "archive" });

    assertEquals(clips.status, 200);
    assertEquals(clips.count, 148);
    assertEquals(archive.count, 366);
    // `count` is what the pager shows: it must match the rows, not the join.
    assertEquals(clips.urls.length, clips.count);
    assertEquals(archive.urls.length, archive.count);
    assertEquals(
      clips.urls.filter((u) => archive.urls.includes(u)),
      [],
      "no video is in both",
    );

    const filedElsewhere = await count(
      `SELECT COUNT(*) n FROM video_filing WHERE placement IN ('playlist', 'channel')`,
    );
    const unlisted = await count(`SELECT COUNT(*) n ${NONE}`);
    assertEquals(clips.count + archive.count + filedElsewhere, unlisted);
    assertEquals(
      (await getsub()).count,
      unlisted,
      "All unlisted shows every row",
    );
  },
);

dbTest(
  "views db - a video that has not been swept yet is in Archive",
  async () => {
    const archive = await getsub({ view: "archive" });
    assertEquals(archive.count, await count(`SELECT COUNT(*) n ${NONE}`));
    assertEquals((await getsub({ view: "clips" })).count, 0);
  },
);

dbTest(
  "views db - Via bot lists exactly the videos with a bot submission",
  async () => {
    const expected = await rows<{ videoUrl: string }>(
      `SELECT v."videoUrl" ${NONE}
     AND v."videoUrl" IN (SELECT "canonicalUrl" FROM bot_submissions)`,
    );
    assert(expected.length > 0, "the pack has bot submissions");
    const bot = await getsub({ view: "bot" });
    assertEquals(bot.count, expected.length);
    assertEquals(
      [...bot.urls].sort(),
      expected.map((r) => r.videoUrl).sort(),
    );
  },
);

dbTest(
  "views db - the inbox is saved videos added within 30 days of the time it is given",
  async () => {
    const [{ latest }] = await rows<{ latest: Date }>(
      `SELECT MAX(m."createdAt") AS latest ${NONE} AND v."downloadStatus"`,
    );
    const now = new Date(new Date(latest).getTime() + 5 * 24 * 60 * 60 * 1000);
    const expected = await count(
      `SELECT COUNT(*) n ${NONE} AND v."downloadStatus"
     AND m."createdAt" >= ${
        quote(new Date(now.getTime() - 30 * 86400000).toISOString())
      }`,
    );
    assert(expected > 0, "the chosen time has something in its inbox");

    const find = (filter: { saved?: boolean }) => {
      const { mappingWhere, videoWhere } = buildLibraryFilter(
        "inbox",
        filter,
        now,
      );
      return PlaylistVideoMapping.count({
        where: mappingWhere!,
        include: [{ model: VideoMetadata, required: true, where: videoWhere }],
      });
    };
    assertEquals(await find({}), expected);
    // Links only inside the Inbox is empty, not a list of unsaved links.
    assertEquals(await find({ saved: false }), 0);
  },
);

dbTest(
  "filters db - saved and links only match the download state and add up",
  async () => {
    const saved = await getsub({ filter: { saved: true } });
    const links = await getsub({ filter: { saved: false } });
    assertEquals(
      saved.count,
      await count(`SELECT COUNT(*) n ${NONE} AND v."downloadStatus"`),
    );
    assertEquals(
      links.count,
      await count(`SELECT COUNT(*) n ${NONE} AND NOT v."downloadStatus"`),
    );
    assertEquals(saved.count + links.count, (await getsub()).count);
    assertEquals(saved.urls.length, saved.count);
  },
);

dbTest(
  "filters db - site, channel and length read the facet columns",
  async () => {
    await sweep();
    const site = await getsub({ filter: { site: "clips.example" } });
    assertEquals(
      site.count,
      await count(`SELECT COUNT(*) n ${NONE} AND v.site = 'clips.example'`),
    );
    assert(site.count > 0);

    const [{ key }] = await rows<{ key: string }>(
      `SELECT "channelKey" AS key ${NONE} AND v.site = 'edge.example' LIMIT 1`,
    );
    assertEquals((await getsub({ filter: { channel: key } })).count, 3);

    const bands: Record<string, string> = {
      clip: `v."durationSeconds" < 120`,
      short: `v."durationSeconds" >= 120 AND v."durationSeconds" < 600`,
      medium: `v."durationSeconds" >= 600 AND v."durationSeconds" < 3600`,
      long: `v."durationSeconds" >= 3600`,
      unknown: `v."durationSeconds" IS NULL`,
    };
    let total = 0;
    for (const [band, predicate] of Object.entries(bands)) {
      const got = await getsub({ filter: { length: band } });
      assertEquals(
        got.count,
        await count(`SELECT COUNT(*) n ${NONE} AND ${predicate}`),
        band,
      );
      total += got.count;
    }
    assertEquals(
      total,
      (await getsub()).count,
      "every row is in exactly one band",
    );
  },
);

dbTest("filters db - hostile text is a value, never SQL", async () => {
  const before = await count(`SELECT COUNT(*) n FROM video_metadata`);
  const hostile = "'; DROP TABLE video_metadata;--";
  assertEquals((await getsub({ filter: { site: hostile } })).count, 0);
  assertEquals((await getsub({ filter: { channel: hostile } })).count, 0);
  // The real hostile key from the pack, quote and all, still finds its rows.
  const key = "edge.example:o'neil'; drop table video_metadata;--";
  assertEquals((await getsub({ filter: { channel: key } })).count, 3);
  assertEquals(await count(`SELECT COUNT(*) n FROM video_metadata`), before);
});

dbTest(
  "filters db - year and month bound the added time in the configured zone",
  async () => {
    const months = await rows<{ y: number; mo: number }>(
      `SELECT DISTINCT EXTRACT(YEAR FROM m."createdAt" AT TIME ZONE ${tz})::int AS y,
            EXTRACT(MONTH FROM m."createdAt" AT TIME ZONE ${tz})::int AS mo
     ${NONE} ORDER BY 1, 2`,
    );
    assert(months.length > 3, "the pack spans several months");
    for (const { y, mo } of months) {
      const expected = await count(
        `SELECT COUNT(*) n ${NONE}
       AND EXTRACT(YEAR FROM m."createdAt" AT TIME ZONE ${tz}) = ${y}
       AND EXTRACT(MONTH FROM m."createdAt" AT TIME ZONE ${tz}) = ${mo}`,
      );
      const got = await getsub({ filter: { year: y, month: mo } });
      assertEquals(got.count, expected, `${y}-${mo}`);
      assertEquals(got.urls.length, got.count);
    }
    const years = [...new Set(months.map((m) => m.y))];
    let total = 0;
    for (const y of years) {
      total += (await getsub({ filter: { year: y } })).count;
    }
    assertEquals(total, (await getsub()).count, "the years add up to Unlisted");
  },
);

dbTest(
  "filters db - a filter applies to a real playlist and a view does not",
  async () => {
    const all = await getsub({ url: END_PLAYLIST });
    const links = await getsub({ url: END_PLAYLIST, filter: { saved: false } });
    assertEquals(
      links.count,
      await count(
        `SELECT COUNT(*) n FROM playlist_video_mappings m
       JOIN video_metadata v USING ("videoUrl")
       WHERE m."playlistUrl" = ${
          quote(END_PLAYLIST)
        } AND NOT v."downloadStatus"`,
      ),
    );
    const withView = await getsub({ url: END_PLAYLIST, view: "clips" });
    assertEquals(
      withView.count,
      all.count,
      "a view on a real playlist is ignored",
    );
  },
);

dbTest(
  "locate db - with a view the page is counted in that view, and outside it there is none",
  async () => {
    await sweep();
    const inView = await rows<{ videoUrl: string }>(
      `SELECT v."videoUrl" ${NONE}
     AND v."videoUrl" IN (SELECT "videoUrl" FROM video_filing WHERE placement = 'clip')
     ORDER BY m."positionInPlaylist" DESC, m.id DESC`,
    );
    const target = "https://clips.example/n/status/5";
    const expectedIndex = inView.findIndex((r) => r.videoUrl === target);
    assert(expectedIndex >= 0);

    const located = await locateVideo(target, { pageSize: 1, view: "clips" });
    assertEquals(located.page, expectedIndex);
    assertEquals(located.playlistUrl, null, "a view is opened under Unlisted");

    // Not a clip, so not in this view: no page, rather than the wrong one.
    const outside = await locateVideo("https://www.edge.example/v/1", {
      pageSize: 1,
      view: "clips",
    });
    assertEquals(outside.page, null);

    // Without the view it resolves to the channel the video was filed into.
    const plain = await locateVideo("https://www.edge.example/v/1", {
      pageSize: 1,
    });
    assert(plain.playlistUrl?.startsWith("auto:edge.example:"));

    // A filter that excludes the video gives no page either.
    const filtered = await locateVideo(target, {
      pageSize: 1,
      view: "clips",
      filter: { site: "edge.example" },
    });
    assertEquals(filtered.page, null);
  },
);

dbTest(
  "filing db - a link filed into a playlist downloads into that playlist's folder",
  async () => {
    await sweep();
    const monitored = await resolveVideoPlaylist("https://match.example/v/1");
    assertEquals(monitored?.playlistUrl, END_PLAYLIST);
    assertEquals(monitored?.saveDirectory, "match-me");

    // An auto channel's folder is the same as Unlisted's, so files stay put.
    const channel = await resolveVideoPlaylist("https://www.edge.example/v/1");
    assert(channel?.playlistUrl.startsWith("auto:edge.example:"));
    assertEquals(channel?.saveDirectory, "");
  },
);

dbTest(
  "filing db - the reaper skips an expired video filed into a monitored playlist",
  async () => {
    const url = "https://match.example/v/1";
    await sequelize.query(
      `INSERT INTO bot_submissions (id, platform, "chatId", "requestedUrl", "canonicalUrl",
       kind, status, retention, "downloadedByBot", "expiresAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), 'telegram', '111111111', ${quote(url)}, ${
        quote(url)
      },
       'video', 'delivered', 'ephemeral', true, now() - interval '1 hour', now(), now())`,
    );
    const real = createSequelizeRetentionStore();
    let purged = 0;
    const store = {
      ...real,
      // Only this submission, and no file is ever touched.
      findExpiredSubmissions: async (now: Date, limit: number) =>
        (await real.findExpiredSubmissions(now, limit)).filter((c) =>
          c.canonicalUrl === url
        ),
      purgeVideoFiles: () => {
        purged++;
        return Promise.resolve(true);
      },
    };
    const snapshot = () =>
      rows(`SELECT * FROM bot_submissions WHERE "canonicalUrl" = ${quote(url)}`)
        .then(JSON.stringify);

    // Before filing the video is only in Unlisted, so the reaper handles it
    // (here: closes out the row). That is the control for the check below.
    assertEquals(await real.isInMonitoredPlaylist(url), false);

    await sweep();
    assertEquals(await real.isInMonitoredPlaylist(url), true);

    const before = await snapshot();
    const summary = await reapExpiredSubmissions(new Date(), store);
    assertEquals(summary, { considered: 1, reaped: 0, skipped: 1 });
    assertEquals(purged, 0);
    assertEquals(await snapshot(), before, "the submission is left as it was");
  },
);

dbTest(
  "filing db - filed videos sit above position 1, newest first",
  async () => {
    await sweep();
    const [{ playlistUrl }] = await rows<{ playlistUrl: string }>(
      `SELECT DISTINCT f."playlistUrl" FROM video_filing f
     WHERE f.placement = 'channel' AND f."videoUrl" = 'https://edge.example/v/3'`,
    );
    const ordered = await rows<
      { videoUrl: string; positionInPlaylist: number }
    >(
      `SELECT "videoUrl", "positionInPlaylist" FROM playlist_video_mappings
     WHERE "playlistUrl" = ${quote(playlistUrl)}
     ORDER BY "positionInPlaylist" ASC, id ASC`,
    );
    // Added 3rd, 2nd, 1st of February: newest first, all before position 1.
    assertEquals(ordered.map((r) => r.videoUrl), [
      "https://edge.example/v/3",
      "https://m.edge.example/v/2",
      "https://www.edge.example/v/1",
    ]);
    assert(ordered.every((r) => r.positionInPlaylist < 0));

    // In a real playlist the filed video comes before the real positions 1..3.
    const end = await rows<{ videoUrl: string; positionInPlaylist: number }>(
      `SELECT "videoUrl", "positionInPlaylist" FROM playlist_video_mappings
     WHERE "playlistUrl" = ${quote(END_PLAYLIST)}
     ORDER BY "positionInPlaylist" ASC, id ASC`,
    );
    assertEquals(end.map((r) => r.videoUrl)[0], "https://match.example/v/1");
    assertEquals(end.slice(1).map((r) => r.positionInPlaylist), [1, 2, 3]);
  },
);

closeTest("library db - close the connection");
