import { assertEquals } from "std/assert/mod.ts";
import {
  CHANNEL_MIN_VIDEOS,
  CHANNEL_SHARE,
  CLIP_MAX_SECONDS,
  INBOX_DAYS,
} from "../src/handlers/filing/rules.ts";
import {
  channelFromHandle,
  isChannelLike,
  type KnownPlaylist,
  placeVideos,
  UNKNOWN_OWNER,
  type UnlistedRow,
} from "../src/handlers/filing/place.ts";

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

function playlist(overrides: Partial<KnownPlaylist> = {}): KnownPlaylist {
  return {
    playlistUrl: "https://a.example/@some/videos",
    site: "a.example",
    urlSegments: ["@some", "videos"],
    monitored: false,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

function place(rows: UnlistedRow[], playlists: KnownPlaylist[] = []) {
  return placeVideos(rows, playlists);
}

Deno.test("filing rules - the numbers live in one place", () => {
  assertEquals(CLIP_MAX_SECONDS, 120);
  assertEquals(CHANNEL_MIN_VIDEOS, 3);
  assertEquals(CHANNEL_SHARE, 0.8);
  assertEquals(INBOX_DAYS, 30);
});

Deno.test("filing place - a real playlist wins, even for a clip", () => {
  const [result] = place([
    row({ realPlaylistUrl: "https://a.example/p/1", durationSeconds: 10 }),
  ]);
  assertEquals(result.placement, "playlist");
  assertEquals(result.playlistUrl, "https://a.example/p/1");
  assertEquals(result.locked, false);
});

Deno.test("filing place - a handle matches a playlist URL on the same site only", () => {
  const known = [playlist({
    playlistUrl: "https://match.example/@match-me/videos",
    site: "match.example",
    urlSegments: ["@match-me", "videos"],
  })];
  const hit = row({ site: "match.example", channelHandle: "match-me" });
  const otherSite = row({ site: "other.example", channelHandle: "match-me" });
  assertEquals(
    channelFromHandle(hit, known),
    "https://match.example/@match-me/videos",
  );
  assertEquals(channelFromHandle(otherSite, known), null);
  const [placed] = place([hit], known);
  assertEquals(placed.placement, "playlist");
  assertEquals(placed.playlistUrl, "https://match.example/@match-me/videos");
});

Deno.test("filing place - a handle that is a URL word matches nothing", () => {
  const known = [playlist({
    site: "match.example",
    urlSegments: ["@x", "videos"],
  })];
  // The same words check.sql refuses, since Task 6 compares against it.
  for (
    const word of [
      "videos",
      "playlist",
      "profile",
      "channel",
      "user",
      "shorts",
    ]
  ) {
    assertEquals(
      channelFromHandle(
        row({ site: "match.example", channelHandle: word }),
        known,
      ),
      null,
    );
  }
});

Deno.test("filing place - with two matches a monitored playlist wins, then the oldest", () => {
  const old = playlist({
    playlistUrl: "https://a.example/@dup/old",
    urlSegments: ["@dup"],
    createdAt: new Date("2024-01-01"),
  });
  const newer = playlist({
    playlistUrl: "https://a.example/@dup/new",
    urlSegments: ["@dup"],
    createdAt: new Date("2025-01-01"),
  });
  const monitored = playlist({
    playlistUrl: "https://a.example/@dup/monitored",
    urlSegments: ["@dup"],
    createdAt: new Date("2026-01-01"),
    monitored: true,
  });
  const r = row({ channelHandle: "dup" });
  assertEquals(
    channelFromHandle(r, [newer, old]),
    "https://a.example/@dup/old",
  );
  assertEquals(
    channelFromHandle(r, [newer, monitored, old]),
    "https://a.example/@dup/monitored",
  );
});

Deno.test("filing place - under two minutes is a clip, exactly two minutes or unknown is not", () => {
  const [short, edge, unknown] = place([
    row({ durationSeconds: 119.9 }),
    row({ durationSeconds: 120 }),
    row({ durationSeconds: null }),
  ]);
  assertEquals(short.placement, "clip");
  assertEquals(edge.placement, "archive");
  assertEquals(unknown.placement, "archive");
});

Deno.test("filing place - three clips from one account make clips and no channel", () => {
  const results = place(
    [1, 2, 3].map(() =>
      row({ channelKey: "a.example:acct", durationSeconds: 30 })
    ),
  );
  assertEquals(results.map((r) => r.placement), ["clip", "clip", "clip"]);
  assertEquals(results.some((r) => r.newChannel), false);
});

Deno.test("filing place - three long videos make one channel", () => {
  const results = place(
    [1, 2, 3].map(() =>
      row({
        channelKey: "a.example:acct",
        channelName: "The Account",
        channelHandle: "acct",
      })
    ),
  );
  assertEquals(results.map((r) => r.placement), [
    "channel",
    "channel",
    "channel",
  ]);
  assertEquals(
    new Set(results.map((r) => r.playlistUrl)),
    new Set(["auto:a.example:acct"]),
  );
  const created = results.filter((r) => r.newChannel);
  assertEquals(created.length, 1);
  assertEquals(created[0].newChannel, {
    key: "a.example:acct",
    title: "The Account",
  });
});

Deno.test("filing place - two long videos and a clip leave the channel short", () => {
  const results = place([
    row({ channelKey: "a.example:acct" }),
    row({ channelKey: "a.example:acct" }),
    row({ channelKey: "a.example:acct", durationSeconds: 20 }),
  ]);
  assertEquals(results.map((r) => r.placement), ["archive", "archive", "clip"]);
});

Deno.test("filing place - a channel title falls back to the handle", () => {
  const results = place(
    [1, 2, 3].map(() =>
      row({ channelKey: "a.example:acct", channelHandle: "acct" })
    ),
  );
  assertEquals(results.find((r) => r.newChannel)?.newChannel?.title, "acct");
});

Deno.test("filing place - an existing auto channel is joined by a lone video", () => {
  const existing = playlist({
    playlistUrl: "auto:a.example:acct",
    urlSegments: [],
  });
  const [placed] = place([row({ channelKey: "a.example:acct" })], [existing]);
  assertEquals(placed.placement, "channel");
  assertEquals(placed.playlistUrl, "auto:a.example:acct");
  assertEquals(placed.newChannel, undefined);
});

Deno.test("filing place - a null channel never forms a group", () => {
  const results = place([1, 2, 3, 4].map(() => row({ channelKey: null })));
  assertEquals(results.map((r) => r.placement), [
    "archive",
    "archive",
    "archive",
    "archive",
  ]);
});

Deno.test("filing place - a clip or archive row is reconsidered, a playlist or channel row stays put", () => {
  const archived = row({
    durationSeconds: 10,
    filing: { placement: "archive", playlistUrl: null, locked: false },
  });
  const clipped = row({
    realPlaylistUrl: "https://a.example/p/1",
    filing: { placement: "clip", playlistUrl: null, locked: false },
  });
  const filed = row({
    realPlaylistUrl: "https://a.example/p/other",
    durationSeconds: 10,
    hasFiledMapping: true,
    filing: {
      placement: "channel",
      playlistUrl: "auto:a.example:acct",
      locked: false,
    },
  });
  const [a, c, f] = place([archived, clipped, filed]);
  assertEquals(a.placement, "clip");
  assertEquals(c.placement, "playlist");
  assertEquals(f.placement, "channel");
  assertEquals(f.playlistUrl, "auto:a.example:acct");
});

Deno.test("filing place - a locked row is returned unchanged", () => {
  const locked = row({
    durationSeconds: 10,
    realPlaylistUrl: "https://a.example/p/1",
    filing: { placement: "archive", playlistUrl: null, locked: true },
  });
  const [placed] = place([locked]);
  assertEquals(placed, {
    videoUrl: locked.videoUrl,
    placement: "archive",
    playlistUrl: null,
    locked: true,
  });
});

Deno.test("filing place - a filed video you removed becomes a locked archive row", () => {
  const noPlaylist = row({
    filing: { placement: "playlist", playlistUrl: null, locked: false },
  });
  const noMapping = row({
    hasFiledMapping: false,
    filing: {
      placement: "channel",
      playlistUrl: "auto:a.example:acct",
      locked: false,
    },
  });
  for (const placed of place([noPlaylist, noMapping])) {
    assertEquals(placed.placement, "archive");
    assertEquals(placed.playlistUrl, null);
    assertEquals(placed.locked, true);
  }
});

Deno.test("filing place - channel-like needs a big enough, dominant owner", () => {
  assertEquals(isChannelLike(new Map([["a", 8], ["b", 2]])), true);
  assertEquals(isChannelLike(new Map([["a", 2]])), false);
  assertEquals(isChannelLike(new Map([["a", 7], ["b", 3]])), false);
  assertEquals(isChannelLike(new Map()), false);
});

Deno.test("filing place - a handle match beats a clip", () => {
  // Rule 1 comes before the clip rule, so a short post from a known account
  // joins that account's playlist instead of the Clips shelf.
  const known = [playlist({
    playlistUrl: "https://match.example/@match-me/videos",
    site: "match.example",
    urlSegments: ["@match-me", "videos"],
  })];
  const [placed] = place(
    [row({
      site: "match.example",
      channelHandle: "match-me",
      durationSeconds: 30,
    })],
    known,
  );
  assertEquals(placed.placement, "playlist");
});

Deno.test("filing place - rows already in a playlist do not count toward a channel", () => {
  const results = place([
    row({
      channelKey: "a.example:acct",
      realPlaylistUrl: "https://a.example/p/1",
    }),
    row({ channelKey: "a.example:acct" }),
    row({ channelKey: "a.example:acct" }),
  ]);
  assertEquals(results.map((r) => r.placement), [
    "playlist",
    "archive",
    "archive",
  ]);
  assertEquals(results.some((r) => r.newChannel), false);
});

Deno.test("filing place - the URL side is compared without case or @", () => {
  const known = [playlist({
    playlistUrl: "https://a.example/@Match-Me/videos",
    urlSegments: ["@Match-Me", "videos"],
  })];
  assertEquals(
    channelFromHandle(row({ channelHandle: "match-me" }), known),
    "https://a.example/@Match-Me/videos",
  );
  const bare = [playlist({
    playlistUrl: "https://a.example/MATCH-ME",
    urlSegments: ["MATCH-ME"],
  })];
  assertEquals(
    channelFromHandle(row({ channelHandle: "match-me" }), bare),
    "https://a.example/MATCH-ME",
  );
});

Deno.test("filing place - videos with no known owner never make a channel", () => {
  // 10 unknown videos are not "one account": the unknown bucket counts toward
  // the total and can never be the dominant owner.
  assertEquals(isChannelLike(new Map([[UNKNOWN_OWNER, 10]])), false);
  assertEquals(
    isChannelLike(new Map([[UNKNOWN_OWNER, 2], ["a", 8]])),
    true,
  );
  assertEquals(
    isChannelLike(new Map([[UNKNOWN_OWNER, 3], ["a", 7]])),
    false,
  );
});
