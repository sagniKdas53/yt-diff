import { assert, assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import { config } from "../src/config.ts";
import {
  buildLibraryFilter,
  type LibraryView,
  parseLibraryRequest,
  viewForPlaylist,
} from "../src/handlers/filing/views.ts";

const VIEWS: LibraryView[] = ["inbox", "bot", "clips", "archive"];
const NOW = new Date("2026-03-01T00:00:00Z");

/** Every leaf in a where tree, including Sequelize literals and symbol keys. */
function leaves(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined) return out;
  if (node instanceof Date) {
    out.push(node);
  } else if (
    typeof node === "object" && "val" in node && !Array.isArray(node)
  ) {
    // A Sequelize Literal: its SQL text is what reaches the database as-is.
    out.push({ literal: String((node as { val: unknown }).val) });
  } else if (typeof node === "object") {
    for (const key of Reflect.ownKeys(node)) {
      leaves((node as Record<string | symbol, unknown>)[key], out);
    }
  } else {
    out.push(node);
  }
  return out;
}

const literalsIn = (node: unknown) =>
  leaves(node).filter((v): v is { literal: string } =>
    typeof v === "object" && v !== null && "literal" in v
  ).map((v) => v.literal);

Deno.test("library views - each view is valid and an unknown one is rejected", () => {
  for (const view of VIEWS) {
    assertEquals(parseLibraryRequest({ view }), { view, filter: {} });
  }
  assertEquals(parseLibraryRequest({}), { view: null, filter: {} });
  assertEquals(parseLibraryRequest(undefined), { view: null, filter: {} });
  assertEquals(parseLibraryRequest({ view: "everything" }), null);
});

Deno.test("library views - malformed filters are rejected, not queried", () => {
  const bad: unknown[] = [
    { filter: { month: 3 } },
    { filter: { year: 2026, month: 13 } },
    { filter: { year: 2026, month: 0 } },
    { filter: { year: 1800 } },
    { filter: { site: "x".repeat(256) } },
    { filter: { channel: "x".repeat(256) } },
    { filter: { length: "enormous" } },
    { filter: { saved: "yes" } },
    { filter: { nonsense: 1 } },
  ];
  for (const raw of bad) {
    assertEquals(parseLibraryRequest(raw), null, JSON.stringify(raw));
  }
  assertEquals(
    parseLibraryRequest({
      filter: { year: 2026, month: 3, site: "a.example" },
    }),
    { view: null, filter: { year: 2026, month: 3, site: "a.example" } },
  );
});

Deno.test("library views - hostile text never reaches a literal", () => {
  const hostile = "'; DROP TABLE video_metadata;--";
  const { videoWhere, mappingWhere } = buildLibraryFilter(
    null,
    { site: hostile, channel: hostile, year: 2026, month: 3 },
    NOW,
  );
  for (
    const literal of [...literalsIn(videoWhere), ...literalsIn(mappingWhere)]
  ) {
    assert(!literal.includes("DROP"), `unescaped input in: ${literal}`);
    assert(!literal.includes(hostile));
  }
  // It is a plain equality value, which Sequelize sends as a parameter.
  assert(leaves(videoWhere).includes(hostile));
});

Deno.test("library views - a view on a real playlist is ignored, a filter is not", () => {
  assertEquals(viewForPlaylist("https://x/playlist", "inbox"), null);
  assertEquals(viewForPlaylist("None", "inbox"), "inbox");
  assertEquals(viewForPlaylist("None", null), null);

  const { videoWhere, mappingWhere } = buildLibraryFilter(
    null,
    { saved: true },
    NOW,
  );
  assertEquals(videoWhere, { [Op.and]: [{ downloadStatus: true }] });
  assertEquals(mappingWhere, undefined);
});

Deno.test("library views - every view is scoped to Unlisted", () => {
  for (const view of VIEWS) {
    const { mappingWhere } = buildLibraryFilter(view, {}, NOW);
    assertEquals(
      (mappingWhere as Record<string, unknown>).playlistUrl,
      "None",
      view,
    );
  }
});

Deno.test("library views - the inbox counts back from the time it is given", () => {
  const { videoWhere, mappingWhere } = buildLibraryFilter("inbox", {}, NOW);
  const since = leaves(mappingWhere).find((v) => v instanceof Date) as Date;
  assertEquals(since.toISOString(), "2026-01-30T00:00:00.000Z");
  assertEquals(videoWhere, { [Op.and]: [{ downloadStatus: true }] });

  const later = buildLibraryFilter(
    "inbox",
    {},
    new Date("2027-01-31T00:00:00Z"),
  );
  assertEquals(
    (leaves(later.mappingWhere).find((v) => v instanceof Date) as Date)
      .toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});

Deno.test("library views - bot, clips and archive read their own tables without naming an alias", () => {
  const sql = (view: LibraryView) =>
    literalsIn(buildLibraryFilter(view, {}, NOW).mappingWhere).join(" ");
  assert(sql("bot").includes("bot_submissions"));
  assert(sql("bot").includes(`"canonicalUrl"`));
  assert(sql("clips").includes("video_filing"));
  assert(sql("clips").includes(`'clip'`));
  assert(sql("archive").includes("video_filing"));
  assert(sql("archive").includes(`<> 'archive'`));
  // The table alias is Sequelize's to choose, and it changes if the query is
  // ever wrapped in a subquery, so no view may spell it.
  for (const view of VIEWS) {
    assert(!sql(view).includes("playlist_video_mapping"), view);
  }
});

Deno.test("library views - an inbox with a saved filter keeps both conditions", () => {
  // Spreading the two objects would let the filter overwrite the view, and
  // "Links only" in the Inbox would show unsaved links instead of nothing.
  const { videoWhere } = buildLibraryFilter("inbox", { saved: false }, NOW);
  assertEquals(videoWhere, {
    [Op.and]: [{ downloadStatus: true }, { downloadStatus: false }],
  });
});

Deno.test("library views - year and month bound the added time in the configured zone", () => {
  const { mappingWhere } = buildLibraryFilter(
    null,
    { year: 2026, month: 3 },
    NOW,
  );
  const sql = literalsIn(mappingWhere);
  assertEquals(sql.length, 2);
  assert(sql[0].includes("make_timestamptz(2026, 3, 1"));
  assert(sql[1].includes("make_timestamptz(2026, 4, 1"));
  for (const part of sql) {
    assert(
      part.includes(`'${config.timeZone}'`),
      "the zone is a quoted literal",
    );
    assert(!part.includes("playlist_video_mapping"));
  }

  // December rolls into the next year.
  const december = literalsIn(
    buildLibraryFilter(null, { year: 2026, month: 12 }, NOW).mappingWhere,
  );
  assert(december[1].includes("make_timestamptz(2027, 1, 1"));

  const yearOnly = literalsIn(
    buildLibraryFilter(null, { year: 2026 }, NOW).mappingWhere,
  );
  assert(yearOnly[0].includes("make_timestamptz(2026, 1, 1"));
  assert(yearOnly[1].includes("make_timestamptz(2027, 1, 1"));
});

Deno.test("library views - length bands split on 2, 10 and 60 minutes, and unknown is null", () => {
  const band = (length: "clip" | "short" | "medium" | "long" | "unknown") =>
    buildLibraryFilter(null, { length }, NOW).videoWhere as Record<
      string,
      unknown
    >;

  assertEquals(band("unknown"), {
    [Op.and]: [{ durationSeconds: null }],
  });
  assertEquals(band("clip"), {
    [Op.and]: [{ durationSeconds: { [Op.lt]: 120 } }],
  });
  assertEquals(band("short"), {
    [Op.and]: [{ durationSeconds: { [Op.gte]: 120, [Op.lt]: 600 } }],
  });
  assertEquals(band("medium"), {
    [Op.and]: [{ durationSeconds: { [Op.gte]: 600, [Op.lt]: 3600 } }],
  });
  assertEquals(band("long"), {
    [Op.and]: [{ durationSeconds: { [Op.gte]: 3600 } }],
  });
});

Deno.test("library views - site and channel are equality filters on the facet columns", () => {
  const { videoWhere } = buildLibraryFilter(
    null,
    { site: "a.example", channel: "a.example:acct", saved: false },
    NOW,
  );
  assertEquals(videoWhere, {
    [Op.and]: [
      { downloadStatus: false },
      { site: "a.example" },
      { channelKey: "a.example:acct" },
    ],
  });
});
