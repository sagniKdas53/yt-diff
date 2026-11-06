/**
 * The Channels list and Monitor channel, against a real Postgres.
 *
 * Needs Docker; see support.ts. Run with `deno task test:db`.
 */
import { assert, assertEquals } from "std/assert/mod.ts";
import {
  closeTest,
  count,
  dbTest,
  END_PLAYLIST,
  quote,
  rows,
  sequelize,
} from "./support.ts";

const { runFilingSweep } = await import("../src/handlers/filing/sweep.ts");
const { createChannelHandlers } = await import(
  "../src/handlers/filing/channels.ts"
);
const { createQueryHandlers } = await import(
  "../src/handlers/playlists/queries.ts"
);
const { createPlaylistRecord } = await import(
  "../src/handlers/pipeline/playlist-records.ts"
);

const EDGE_CHANNEL_URL = "https://edge.example/u/oneil";

const sweep = () => runFilingSweep({ apply: true });

/** Calls a real handler against a response that records what it was sent. */
async function post<T>(
  handler: (body: never, response: never) => Promise<void>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  let status = 0;
  let text = "";
  await (handler as (b: unknown, r: unknown) => Promise<void>)(body, {
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
  });
  return { status, body: text ? JSON.parse(text) as T : (undefined as T) };
}

const listings: Array<Record<string, unknown>> = [];
const deps = {
  // deno-lint-ignore no-explicit-any
  listItemsConcurrently: ((items: Array<Record<string, unknown>>) => {
    listings.push(...items);
    return Promise.resolve([]);
    // deno-lint-ignore no-explicit-any
  }) as any,
  safeEmit: () => {},
};
const channels = createChannelHandlers(deps);
const queries = createQueryHandlers(deps);

const monitor = (playlistUrl: string, monitoringType = "End") =>
  post<{ playlistUrl: string }>(channels.processMonitorChannelRequest, {
    playlistUrl,
    monitoringType,
  });

interface PlaylistRow {
  playlistUrl: string;
  kind: string;
  origin: string;
  sortOrder: number;
  videoCount: number;
  latestAddedAt: string | null;
  channelUrl: string | null;
}
const getplay = async (body: Record<string, unknown> = {}) =>
  (await post<{ count: number; rows: PlaylistRow[] }>(
    queries.getPlaylistsForDisplay,
    { start: 0, stop: 1000, ...body },
  )).body;

/** The auto channel the edge-case videos were filed into. */
async function edgeChannel(): Promise<string> {
  const [row] = await rows<{ playlistUrl: string }>(
    `SELECT DISTINCT "playlistUrl" FROM video_filing
     WHERE "videoUrl" = 'https://edge.example/v/3' AND placement = 'channel'`,
  );
  return row.playlistUrl;
}

/** Everything that must be true of the filed videos after a promotion. */
async function assertStillFiled(channelUrl: string) {
  const again = await sweep();
  assertEquals(again.toArchive, 0, "no filed video is treated as removed");
  assertEquals(again.unchanged, 581);
  assertEquals(
    await count(`SELECT COUNT(*) n FROM video_filing WHERE locked`),
    0,
  );
  assertEquals(
    await count(
      `SELECT COUNT(*) n FROM video_filing
       WHERE placement = 'channel' AND "playlistUrl" = ${quote(channelUrl)}`,
    ),
    3,
  );
}

dbTest(
  "channels db - every foreign key to a playlist cascades a rename",
  async () => {
    const fks = await rows<{ child: string; update: string; del: string }>(`
    SELECT conrelid::regclass::text AS child, confupdtype AS update,
           confdeltype AS del
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'playlist_metadata'::regclass`);
    assert(
      fks.length >= 2,
      "mappings and filing rows both reference playlists",
    );
    for (const fk of fks) {
      // 'c' is CASCADE. Renaming a playlist's key depends on it everywhere.
      assertEquals(fk.update, "c", `${fk.child} must cascade updates`);
    }
  },
);

dbTest(
  "channels db - Monitor renames the channel and everything pointing at it",
  async () => {
    await sweep();
    const auto = await edgeChannel();
    const before = await count(
      `SELECT COUNT(*) n FROM playlist_video_mappings WHERE "playlistUrl" = ${
        quote(auto)
      }`,
    );
    assertEquals(before, 3);
    const playlistsBefore = await count(
      `SELECT COUNT(*) n FROM playlist_metadata`,
    );
    const [{ next }] = await rows<{ next: number }>(
      `SELECT MAX("sortOrder") + 1 AS next FROM playlist_metadata`,
    );

    const answer = await monitor(auto, "End");
    assertEquals(answer.status, 200);
    assertEquals(answer.body, { playlistUrl: EDGE_CHANNEL_URL });

    // The mappings and the filing rows followed the key.
    const [row] = await rows<
      {
        origin: string;
        sortOrder: number;
        kind: string;
        monitoringType: string;
      }
    >(
      `SELECT origin, "sortOrder", kind, "monitoringType" FROM playlist_metadata
     WHERE "playlistUrl" = ${quote(EDGE_CHANNEL_URL)}`,
    );
    assertEquals(row.origin, "user");
    assertEquals(row.kind, "channel");
    assertEquals(row.sortOrder, next);
    // Left alone on purpose: the listing sets it, and a row that already holds
    // the requested type makes that listing return without indexing anything.
    assertEquals(row.monitoringType, "N/A");

    assertEquals(
      await count(
        `SELECT COUNT(*) n FROM playlist_video_mappings WHERE "playlistUrl" = ${
          quote(EDGE_CHANNEL_URL)
        }`,
      ),
      3,
    );
    assertEquals(
      await count(
        `SELECT COUNT(*) n FROM playlist_metadata WHERE "playlistUrl" = ${
          quote(auto)
        }`,
      ),
      0,
    );
    assertEquals(
      await count(`SELECT COUNT(*) n FROM playlist_metadata`),
      playlistsBefore,
    );
    await assertStillFiled(EDGE_CHANNEL_URL);

    // A listing was started for the new key, as a user-started run.
    const started = listings.at(-1);
    assertEquals(started?.url, EDGE_CHANNEL_URL);
    assertEquals(started?.currentMonitoringType, "End");
  },
);

dbTest(
  "channels db - Monitor into a playlist that already has the URL folds the channel in",
  async () => {
    await sweep();
    const auto = await edgeChannel();
    // The user already has this channel as a playlist, holding one of the videos.
    await sequelize.query(
      `INSERT INTO playlist_metadata ("playlistUrl", title, "sortOrder", "monitoringType",
       "saveDirectory", "createdAt", "updatedAt", "lastUpdatedByScheduler")
     VALUES (${
        quote(EDGE_CHANNEL_URL)
      }, 'Mine', 2000, 'End', 'mine', now(), now(), now())`,
    );
    await sequelize.query(
      `INSERT INTO playlist_video_mappings (id, "videoUrl", "playlistUrl", "positionInPlaylist",
       "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), 'https://edge.example/v/3', ${
        quote(EDGE_CHANNEL_URL)
      }, 1, now(), now())`,
    );

    assertEquals((await monitor(auto, "End")).status, 200);

    assertEquals(
      await count(
        `SELECT COUNT(*) n FROM playlist_metadata WHERE "playlistUrl" = ${
          quote(auto)
        }`,
      ),
      0,
      "the empty auto row is gone",
    );
    // v/3 was already there, so the duplicate filed mapping is dropped; the
    // other two moved in. Three videos, one mapping each.
    const mapped = await rows<{ videoUrl: string }>(
      `SELECT "videoUrl" FROM playlist_video_mappings
     WHERE "playlistUrl" = ${quote(EDGE_CHANNEL_URL)} ORDER BY "videoUrl"`,
    );
    assertEquals(mapped.map((r) => r.videoUrl), [
      "https://edge.example/v/3",
      "https://m.edge.example/v/2",
      "https://www.edge.example/v/1",
    ]);
    // The playlist the user had is theirs: not renumbered, not retyped.
    const [kept] = await rows<{ title: string; sortOrder: number }>(
      `SELECT title, "sortOrder" FROM playlist_metadata WHERE "playlistUrl" = ${
        quote(EDGE_CHANNEL_URL)
      }`,
    );
    assertEquals(kept, { title: "Mine", sortOrder: 2000 });
    await assertStillFiled(EDGE_CHANNEL_URL);
  },
);

dbTest("channels db - Monitor needs a stored channel URL", async () => {
  await sweep();
  const auto = await edgeChannel();
  await sequelize.query(
    `UPDATE video_metadata SET "channelUrl" = NULL WHERE site = 'edge.example'`,
  );
  const answer = await monitor(auto);
  assertEquals(answer.status, 400);
  assertEquals(
    await count(
      `SELECT COUNT(*) n FROM playlist_metadata WHERE "playlistUrl" = ${
        quote(auto)
      }`,
    ),
    1,
    "nothing changed",
  );
});

dbTest("channels db - only the job's channels can be promoted", async () => {
  await sweep();
  assertEquals((await monitor(END_PLAYLIST)).status, 400);
  assertEquals((await monitor("auto:does:not:exist")).status, 404);
});

dbTest(
  "channels db - a playlist created while one is promoted gets its own sortOrder",
  async () => {
    await sweep();
    const auto = await edgeChannel();
    const [promoted] = await Promise.all([
      monitor(auto),
      createPlaylistRecord("https://new.example/list", "New", "N/A"),
    ]);
    assertEquals(promoted.status, 200);
    const orders = await rows<{ sortOrder: number }>(
      `SELECT "sortOrder" FROM playlist_metadata
     WHERE "playlistUrl" IN (${
        quote(EDGE_CHANNEL_URL)
      }, 'https://new.example/list')`,
    );
    assertEquals(orders.length, 2);
    assert(
      orders[0].sortOrder !== orders[1].sortOrder,
      "no two share a number",
    );
  },
);

dbTest(
  "channels db - /getplay lists each kind, and no kind keeps today's rows",
  async () => {
    await sweep();
    const todays = await count(
      `SELECT COUNT(*) n FROM playlist_metadata WHERE "sortOrder" >= 0`,
    );

    const all = await getplay();
    assertEquals(all.count, todays);
    assert(all.rows.every((r) => r.sortOrder >= 0));
    assert(!all.rows.some((r) => r.playlistUrl === "None"));
    assert(all.rows.every((r) => typeof r.videoCount === "number"));

    const playlists = await getplay({ kind: "playlist" });
    assert(
      playlists.rows.every((r) => r.kind === "playlist" && r.sortOrder >= 0),
    );
    assert(playlists.rows.every((r) => r.channelUrl === null));
    // The End playlist became a channel, so it left this list.
    assert(!playlists.rows.some((r) => r.playlistUrl === END_PLAYLIST));

    const found = await getplay({ kind: "channel" });
    assert(found.rows.every((r) => r.kind === "channel"));
    assert(!found.rows.some((r) => r.playlistUrl === "None"));
    const autos = found.rows.filter((r) => r.origin === "auto");
    assertEquals(autos.length, 6);
    assert(
      autos.every((r) => r.sortOrder === -1),
      "listed despite sortOrder -1",
    );
    assert(found.rows.some((r) => r.playlistUrl === END_PLAYLIST));
    // Every channel is in exactly one of the two lists.
    assertEquals(
      found.count + playlists.count,
      todays + autos.length,
    );
  },
);

dbTest(
  "channels db - channel rows carry counts, a channel URL and newest-first order",
  async () => {
    await sweep();
    const found = await getplay({ kind: "channel" });

    for (const channel of found.rows) {
      assertEquals(
        channel.videoCount,
        await count(
          `SELECT COUNT(*) n FROM playlist_video_mappings WHERE "playlistUrl" = ${
            quote(channel.playlistUrl)
          }`,
        ),
        channel.playlistUrl,
      );
      const [{ latest }] = await rows<{ latest: Date | null }>(
        `SELECT MAX(v."createdAt") AS latest FROM playlist_video_mappings m
       JOIN video_metadata v USING ("videoUrl")
       WHERE m."playlistUrl" = ${quote(channel.playlistUrl)}`,
      );
      assertEquals(
        channel.latestAddedAt === null
          ? null
          : new Date(channel.latestAddedAt).getTime(),
        latest === null ? null : new Date(latest).getTime(),
      );
    }

    // Newest activity first.
    const times = found.rows.map((r) =>
      r.latestAddedAt === null ? -Infinity : new Date(r.latestAddedAt).getTime()
    );
    assertEquals(times, [...times].sort((a, b) => b - a));

    // Activity is when the archive got the videos, not when the sweep filed
    // them: every filed mapping carries the sweep's timestamp, so counting that
    // would put every auto channel at "just now".
    const edge = found.rows.find((r) =>
      r.playlistUrl.startsWith("auto:edge.example:")
    );
    assert(edge !== undefined);
    assert(new Date(edge.latestAddedAt!).getFullYear() === 2026);
    assert(
      new Date(edge.latestAddedAt!).getTime() < Date.now() - 24 * 3600 * 1000,
    );

    // The URL Monitor channel would use: from the videos for an auto channel,
    // the key itself for one the user already has.
    assertEquals(edge.channelUrl, EDGE_CHANNEL_URL);
    const end = found.rows.find((r) => r.playlistUrl === END_PLAYLIST);
    assertEquals(end?.channelUrl, END_PLAYLIST);
  },
);

closeTest("channels db - close the connection");
