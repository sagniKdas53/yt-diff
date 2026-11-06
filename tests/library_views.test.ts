import { assert, assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import { config } from "../src/config.ts";
import {
  buildLibraryFilter,
  filterWithout,
  type LibraryView,
  parseLibraryRequest,
  pickName,
  viewForPlaylist,
} from "../src/handlers/filing/views.ts";
import { API_ENDPOINTS } from "../src/routes/endpoints.ts";
import {
  LibraryFacetsRequestSchema,
  SubListRequestSchema,
  validateBody,
} from "../src/middleware/validator.ts";

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

const PICKED = {
  saved: true,
  site: "a.example",
  year: 2026,
  month: 3,
  channel: "a.example:acct",
  length: "short" as const,
};

Deno.test("library facets - each dimension drops its own selection and keeps the rest", () => {
  // Picking one site still has to list the other sites, or the filter bar
  // would only ever show the choice already made.
  const { site, ...withoutSite } = PICKED;
  assertEquals(filterWithout(PICKED, "site"), withoutSite);
  assert(site === "a.example");

  const { saved: _s, ...withoutSaved } = PICKED;
  assertEquals(filterWithout(PICKED, "saved"), withoutSaved);

  const { channel: _c, ...withoutChannel } = PICKED;
  assertEquals(filterWithout(PICKED, "channel"), withoutChannel);

  const { length: _l, ...withoutLength } = PICKED;
  assertEquals(filterWithout(PICKED, "length"), withoutLength);
});

Deno.test("library facets - the year drops the month with it, the month keeps the year", () => {
  // A month with no year isn't a valid filter, and the years list is the
  // count across all years, so choosing March 2026 doesn't hide 2025.
  const { year: _y, month: _m, ...withoutTime } = PICKED;
  assertEquals(filterWithout(PICKED, "year"), withoutTime);

  const { month: _mo, ...withoutMonth } = PICKED;
  assertEquals(filterWithout(PICKED, "month"), withoutMonth);
  assertEquals(filterWithout(PICKED, "month").year, 2026);
});

Deno.test("library facets - a name is the most common one for its key, then the first alphabetically", () => {
  assertEquals(
    pickName([
      { name: "Old Name", count: 2 },
      { name: "New Name", count: 7 },
    ]),
    "New Name",
  );
  assertEquals(
    pickName([{ name: "b", count: 3 }, { name: "a", count: 3 }]),
    "a",
  );
  assertEquals(pickName([]), null);
  assertEquals(
    pickName([{ name: null, count: 9 }, { name: "x", count: 1 }]),
    "x",
  );
});

Deno.test("library endpoints - summary and facets are registered, authenticated and uncosted", () => {
  for (const path of ["/library/summary", "/library/facets"]) {
    const endpoint = API_ENDPOINTS.find((e) => e.path === path);
    assert(endpoint !== undefined, `${path} must be in the endpoint table`);
    assertEquals(endpoint.kind, "authenticated");
    assertEquals(endpoint.method, "POST");
  }
});

Deno.test("library views - a malformed view or filter gets a 400 at the route and never reaches the handler", () => {
  for (const schema of [SubListRequestSchema, LibraryFacetsRequestSchema]) {
    for (
      const body of [
        { view: "everything" },
        { filter: { month: 3 } },
        { filter: { site: "x".repeat(256) } },
        { filter: { year: 2026, month: 13 } },
      ]
    ) {
      let reached = false;
      let status = 0;
      // deno-lint-ignore no-explicit-any
      const guarded = validateBody(schema as any, () => {
        reached = true;
      });
      guarded(body, {
        headersSent: false,
        setHeader: () => {},
        writeHead: (s: number) => {
          status = s;
        },
        write: () => {},
        end: () => {},
      });
      assertEquals(status, 400, JSON.stringify(body));
      assertEquals(reached, false, JSON.stringify(body));
    }
  }
});
