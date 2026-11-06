import { assert, assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import { PlaylistMetadata } from "../src/db/models.ts";
import {
  type ChannelRow,
  type ChannelStore,
  createChannelHandlers,
  playlistKindWhere,
} from "../src/handlers/filing/channels.ts";
import { createQueryHandlers } from "../src/handlers/playlists/queries.ts";
import {
  DeletePlaylistRequestBodySchema,
  MonitorChannelRequestSchema,
  PlaylistDisplayRequestSchema,
  UpdatePlaylistMonitoringRequestSchema,
} from "../src/middleware/validator.ts";
import { API_ENDPOINTS } from "../src/routes/endpoints.ts";
import { completePlaylistListing } from "../src/handlers/pipeline/listing.ts";

// deno-lint-ignore no-explicit-any
type AnyRecord = Record<string, any>;

function stub(target: object, name: string, impl: unknown): () => void {
  const own = Object.prototype.hasOwnProperty.call(target, name);
  const original = (target as AnyRecord)[name];
  (target as AnyRecord)[name] = impl;
  return () => {
    if (own) (target as AnyRecord)[name] = original;
    else delete (target as AnyRecord)[name];
  };
}

function responseStub() {
  const out: { status?: number; body?: AnyRecord } = {};
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
        out.body = chunk ? JSON.parse(chunk) : undefined;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// /getplay by kind
// ---------------------------------------------------------------------------

Deno.test("channels - each kind selects the rows the plan names", () => {
  // No kind is today's behaviour: every row that holds a place in the list.
  assertEquals(playlistKindWhere(undefined), { sortOrder: { [Op.gte]: 0 } });
  assertEquals(playlistKindWhere("playlist"), {
    kind: "playlist",
    sortOrder: { [Op.gte]: 0 },
  });
  // A channel is listed at any sortOrder, because the job's have -1.
  assertEquals(playlistKindWhere("channel"), {
    kind: "channel",
    playlistUrl: { [Op.notIn]: ["None", "init"] },
  });
});

async function getplayOptions(body: AnyRecord) {
  let captured: AnyRecord = {};
  const restore = stub(
    PlaylistMetadata,
    "findAndCountAll",
    (options: AnyRecord) => {
      captured = options;
      return Promise.resolve({ count: 0, rows: [] });
    },
  );
  try {
    const handlers = createQueryHandlers({
      // deno-lint-ignore no-explicit-any
      listItemsConcurrently: (() => Promise.resolve([])) as any,
      safeEmit: () => {},
    });
    const { response } = responseStub();
    await handlers.getPlaylistsForDisplay(body, response);
    return captured;
  } finally {
    restore();
  }
}

Deno.test("channels - /getplay with no kind keeps today's rows and gains the new columns", async () => {
  const options = await getplayOptions({});
  assertEquals(options.where.sortOrder, { [Op.gte]: 0 });
  assertEquals(options.where.kind, undefined);
  const added = options.attributes.include.map((a: [unknown, string]) => a[1]);
  assertEquals(added, ["videoCount", "latestAddedAt", "channelUrl"]);
});

Deno.test("channels - /getplay for channels lists any sortOrder, newest activity first", async () => {
  const options = await getplayOptions({ kind: "channel" });
  assertEquals(options.where.kind, "channel");
  assertEquals(options.where.sortOrder, undefined);
  const [expression, direction] = options.order[0];
  assert(String(expression.val).includes("latestAddedAt"));
  assert(String(direction).startsWith("DESC"));
});

Deno.test("channels - /getplay for playlists keeps the sortOrder order", async () => {
  const options = await getplayOptions({ kind: "playlist" });
  assertEquals(options.where.kind, "playlist");
  assertEquals(options.order, [["sortOrder", "ASC"]]);
});

Deno.test("channels - an unknown kind is refused", () => {
  assertEquals(
    PlaylistDisplayRequestSchema.safeParse({ kind: "feed" }).success,
    false,
  );
  assertEquals(
    PlaylistDisplayRequestSchema.safeParse({ kind: "channel" }).success,
    true,
  );
  assertEquals(PlaylistDisplayRequestSchema.safeParse({}).success, true);
});

// ---------------------------------------------------------------------------
// Monitor channel
// ---------------------------------------------------------------------------

function fakeStore(
  rows: Record<string, ChannelRow>,
  merged = false,
): ChannelStore & { promoted: Array<[string, string]> } {
  const promoted: Array<[string, string]> = [];
  return {
    promoted,
    find: (playlistUrl) => Promise.resolve(rows[playlistUrl] ?? null),
    promote: (autoUrl, channelUrl) => {
      promoted.push([autoUrl, channelUrl]);
      return Promise.resolve({ merged });
    },
  };
}

function monitorHandler(store: ChannelStore) {
  const listings: AnyRecord[] = [];
  const handlers = createChannelHandlers({
    // deno-lint-ignore no-explicit-any
    listItemsConcurrently: ((items: AnyRecord[]) => {
      listings.push(...items);
      return Promise.resolve([]);
      // deno-lint-ignore no-explicit-any
    }) as any,
    safeEmit: () => {},
  }, store);
  return { handlers, listings };
}

const AUTO = "auto:a.example:acct";

Deno.test("channels - Monitor renames an auto channel to its URL and starts a listing", async () => {
  const store = fakeStore({
    [AUTO]: {
      playlistUrl: AUTO,
      origin: "auto",
      channelUrl: "https://a.example/@acct",
    },
  });
  const { handlers, listings } = monitorHandler(store);
  const { response, out } = responseStub();

  await handlers.processMonitorChannelRequest(
    { playlistUrl: AUTO, monitoringType: "End" },
    response,
  );

  assertEquals(out.status, 200);
  assertEquals(out.body, { playlistUrl: "https://a.example/@acct" });
  // The type goes to the listing, not to the row: a row that already holds
  // it makes the listing return early without indexing anything.
  assertEquals(store.promoted, [[AUTO, "https://a.example/@acct"]]);
  // Through the normal listing path, as a user-started (not scheduled) run.
  assertEquals(listings.length, 1);
  assertEquals(listings[0].url, "https://a.example/@acct");
  assertEquals(listings[0].type, "playlist");
  assertEquals(listings[0].currentMonitoringType, "End");
});

Deno.test("channels - Monitor with no channel URL is a 400 and changes nothing", async () => {
  const store = fakeStore({
    [AUTO]: { playlistUrl: AUTO, origin: "auto", channelUrl: null },
  });
  const { handlers, listings } = monitorHandler(store);
  const { response, out } = responseStub();

  await handlers.processMonitorChannelRequest(
    { playlistUrl: AUTO, monitoringType: "Start" },
    response,
  );

  assertEquals(out.status, 400);
  assertEquals(store.promoted, []);
  assertEquals(listings, []);
});

Deno.test("channels - Monitor only promotes the job's channels", async () => {
  const store = fakeStore({
    "https://a.example/@mine": {
      playlistUrl: "https://a.example/@mine",
      origin: "user",
      channelUrl: "https://a.example/@mine",
    },
  });
  const { handlers } = monitorHandler(store);

  const user = responseStub();
  await handlers.processMonitorChannelRequest(
    { playlistUrl: "https://a.example/@mine", monitoringType: "End" },
    user.response,
  );
  assertEquals(user.out.status, 400);

  const missing = responseStub();
  await handlers.processMonitorChannelRequest(
    { playlistUrl: "auto:nothing", monitoringType: "End" },
    missing.response,
  );
  assertEquals(missing.out.status, 404);
  assertEquals(store.promoted, []);
});

Deno.test("channels - Monitor into a playlist that already has the URL still answers with it", async () => {
  const store = fakeStore({
    [AUTO]: {
      playlistUrl: AUTO,
      origin: "auto",
      channelUrl: "https://a.example/@acct",
    },
  }, true);
  const { handlers, listings } = monitorHandler(store);
  const { response, out } = responseStub();

  await handlers.processMonitorChannelRequest(
    { playlistUrl: AUTO, monitoringType: "Start" },
    response,
  );

  assertEquals(out.body, { playlistUrl: "https://a.example/@acct" });
  assertEquals(listings.length, 1);
});

Deno.test("channels - the request is validated and the endpoint is registered", () => {
  const ok = { playlistUrl: AUTO, monitoringType: "End" };
  assertEquals(MonitorChannelRequestSchema.safeParse(ok).success, true);
  assertEquals(
    MonitorChannelRequestSchema.safeParse({ ...ok, monitoringType: "Never" })
      .success,
    false,
  );
  assertEquals(
    MonitorChannelRequestSchema.safeParse({ monitoringType: "End" }).success,
    false,
  );

  const endpoint = API_ENDPOINTS.find((e) => e.path === "/channels/monitor");
  assert(
    endpoint !== undefined,
    "/channels/monitor must be in the endpoint table",
  );
  assertEquals(endpoint.kind, "authenticated");
});

// ---------------------------------------------------------------------------
// seekPlaylistListTo
// ---------------------------------------------------------------------------

Deno.test("listing - a finished playlist listing names the playlist as well as a page position", () => {
  // `seekPlaylistListTo` is a sortOrder, which is a page position only while
  // Channels and Playlists are one list. Once they are two, the position means
  // nothing, so the answer carries the URL the frontend can open directly.
  const emitted: AnyRecord[] = [];
  const result = completePlaylistListing(
    // deno-lint-ignore no-explicit-any
    {
      safeEmit: (_name: string, payload: AnyRecord) => emitted.push(payload),
    } as any,
    "https://a.example/@acct",
    3,
    "Acct",
    -1,
    true,
  );
  assertEquals(result.seekPlaylistUrl, "https://a.example/@acct");
  assertEquals(emitted[0].seekPlaylistUrl, "https://a.example/@acct");
  assertEquals(result.seekPlaylistListTo, -1);
});

Deno.test("channels - an auto key is accepted wherever a playlist key is, so it can be deleted and watched", () => {
  // It isn't a URL, and the schemas that guard /delplay and /watch must not
  // assume it is, or an auto channel could never be removed from the UI.
  assertEquals(
    DeletePlaylistRequestBodySchema.safeParse({
      playListUrl: "auto:a.example:acct",
      deletePlaylist: true,
    }).success,
    true,
  );
  assertEquals(
    UpdatePlaylistMonitoringRequestSchema.safeParse({
      url: "auto:a.example:acct",
      watch: "End",
    }).success,
    true,
  );
});
