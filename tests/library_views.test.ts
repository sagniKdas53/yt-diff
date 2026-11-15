import { assert, assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import { config } from "../src/config.ts";
import { PlaylistVideoMapping } from "../src/db/models.ts";
import {
  buildLibraryFilter,
  creatorMatches,
  filterWithout,
  libraryFacets,
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

// deno-lint-ignore no-explicit-any
type AnyRecord = Record<string, any>;

/** Shadows an inherited static property; the returned fn restores it. */
function stub(target: object, name: string, impl: unknown): () => void {
  const own = Object.prototype.hasOwnProperty.call(target, name);
  const original = (target as AnyRecord)[name];
  (target as AnyRecord)[name] = impl;
  return () => {
    if (own) (target as AnyRecord)[name] = original;
    else delete (target as AnyRecord)[name];
  };
}

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

// ---------------------------------------------------------------------------
// 05c Task 4: find a creator by name, and filter by upload date
// ---------------------------------------------------------------------------

Deno.test("library views - uploaded dates put the range on uploadDate as plain dates", () => {
  const { videoWhere, mappingWhere } = buildLibraryFilter(
    null,
    { dateField: "uploaded", year: 2026, month: 3 },
    NOW,
  );
  // Plain YYYY-MM-DD strings: an upload date has no time or zone, so there is
  // nothing to convert and no literal to build. A video with no uploadDate has
  // nothing to compare, and is excluded.
  assertEquals(videoWhere, {
    [Op.and]: [{
      uploadDate: {
        [Op.ne]: null,
        [Op.gte]: "2026-03-01",
        [Op.lt]: "2026-04-01",
      },
    }],
  });
  assertEquals(literalsIn(videoWhere), []);
  // And the time it was added is no longer part of the question.
  assertEquals(mappingWhere, undefined);

  const december = buildLibraryFilter(
    null,
    { dateField: "uploaded", year: 2026, month: 12 },
    NOW,
  ).videoWhere;
  assert(leaves(december).includes("2027-01-01"));

  const yearOnly = buildLibraryFilter(
    null,
    { dateField: "uploaded", year: 2026 },
    NOW,
  ).videoWhere;
  assert(leaves(yearOnly).includes("2026-01-01"));
  assert(leaves(yearOnly).includes("2027-01-01"));
});

Deno.test("library views - dateField added is the default and keeps reading the mapping", () => {
  const explicit = buildLibraryFilter(
    null,
    { dateField: "added", year: 2026, month: 3 },
    NOW,
  );
  const implicit = buildLibraryFilter(null, { year: 2026, month: 3 }, NOW);
  assertEquals(
    literalsIn(explicit.mappingWhere),
    literalsIn(implicit.mappingWhere),
  );
  assertEquals(explicit.videoWhere, undefined);
});

Deno.test("library views - a dateField without a year filters nothing", () => {
  for (const dateField of ["added", "uploaded"] as const) {
    assertEquals(buildLibraryFilter(null, { dateField }, NOW), {
      videoWhere: undefined,
      mappingWhere: undefined,
    });
  }
});

Deno.test("library views - an unknown dateField, or an empty or long creatorQuery, is rejected", () => {
  assertEquals(parseLibraryRequest({ filter: { dateField: "created" } }), null);
  assertEquals(
    parseLibraryRequest({ filter: { dateField: "uploaded", year: 2026 } }),
    { view: null, filter: { dateField: "uploaded", year: 2026 } },
  );
  const ok = { creatorQuery: "a" };
  assertEquals(LibraryFacetsRequestSchema.safeParse(ok).success, true);
  assertEquals(
    LibraryFacetsRequestSchema.safeParse({ creatorQuery: "x".repeat(100) })
      .success,
    true,
  );
  for (const creatorQuery of ["", "x".repeat(101), 5, null]) {
    assertEquals(
      LibraryFacetsRequestSchema.safeParse({ creatorQuery }).success,
      false,
      JSON.stringify(creatorQuery),
    );
  }
});

Deno.test("library facets - a creator query is matched as text, so wildcards and SQL mean nothing", () => {
  const names = ["Plain Name"];
  // Matched against the text itself, not a pattern: `%` and `_` are only
  // themselves, and nothing here ever reaches SQL.
  assertEquals(creatorMatches("a.example:x", names, "%"), false);
  assertEquals(creatorMatches("a.example:x", names, "_"), false);
  assertEquals(creatorMatches("a.example:x", names, "'; DROP TABLE"), false);
  assertEquals(creatorMatches("a.example:100%", ["100% Real"], "%"), true);
  assertEquals(creatorMatches("a.example:a_b", ["A_B"], "_"), true);
  assertEquals(
    creatorMatches("a.example:x", ["o'; drop table--"], "'; DROP TABLE"),
    true,
  );
});

Deno.test("library facets - a creator query matches the name or the key, without case", () => {
  assertEquals(creatorMatches("a.example:ucabc", ["Some Name"], "SOME"), true);
  assertEquals(creatorMatches("a.example:ucabc", ["Some Name"], "UCAB"), true);
  assertEquals(
    creatorMatches("a.example:ucabc", ["Some Name"], "other"),
    false,
  );
  // Any name the key has been seen under counts, not only the one shown.
  assertEquals(
    creatorMatches("a.example:k", ["Old Name", "New Name"], "old"),
    true,
  );
});

/** Stands in for the two queries the facets run, with fixed rows. */
function stubFacetQueries() {
  const grouped: Array<Record<string, unknown>> = [];
  const rows = [
    {
      site: "a.example",
      siteName: "A",
      year: 2026,
      month: 3,
      channelKey: "a.example:big",
      channelName: "Big One",
      count: "5",
    },
    {
      site: "a.example",
      siteName: "A",
      year: 2026,
      month: 3,
      channelKey: "a.example:small",
      channelName: "Tiny Find",
      count: "1",
    },
  ];
  const restoreFind = stub(PlaylistVideoMapping, "findAll", (
    options: Record<string, unknown>,
  ) => {
    grouped.push(options);
    return Promise.resolve(rows);
  });
  const restoreCount = stub(
    PlaylistVideoMapping,
    "count",
    () => Promise.resolve(7),
  );
  return {
    grouped,
    restore: () => {
      restoreFind();
      restoreCount();
    },
  };
}

Deno.test("library facets - a creator query narrows the creators and nothing else", async () => {
  const stubbed = stubFacetQueries();
  try {
    const plain = await libraryFacets("archive", { year: 2026 }, NOW);
    const searched = await libraryFacets(
      "archive",
      { year: 2026 },
      NOW,
      "tiny",
    );
    assertEquals(plain.creators.map((c) => c.key), [
      "a.example:big",
      "a.example:small",
    ]);
    assertEquals(searched.creators, [
      { key: "a.example:small", name: "Tiny Find", count: 1 },
    ]);
    assertEquals(searched.sites, plain.sites);
    assertEquals(searched.years, plain.years);
    assertEquals(searched.months, plain.months);
    assertEquals(searched.lengths, plain.lengths);
    assertEquals(searched.saved, plain.saved);

    // A query nothing matches is an empty list, not an error.
    assertEquals(
      (await libraryFacets("archive", {}, NOW, "no such creator")).creators,
      [],
    );
  } finally {
    stubbed.restore();
  }
});

/** The grouped query that counts under `alias` (year, month, site, ...). */
function queryFor(grouped: Array<Record<string, unknown>>, alias: string) {
  const found = grouped.find((options) =>
    (options.attributes as Array<unknown>).some((a) =>
      Array.isArray(a) && a[1] === alias
    )
  );
  assert(found !== undefined, `no query counts ${alias}`);
  const attribute = (found.attributes as Array<[unknown, string]>).find((a) =>
    a[1] === alias
  )!;
  return {
    // The SQL function and the text it reads from.
    expression: JSON.stringify(attribute[0]),
    videoWhere: (found.include as Array<{ where: unknown }>)[0].where,
  };
}

/** Whether a where tree names this column anywhere. */
function names(node: unknown, key: string): boolean {
  if (node === null || typeof node !== "object") return false;
  return Reflect.ownKeys(node).some((k) =>
    k === key ||
    names((node as Record<string | symbol, unknown>)[k], key)
  );
}

Deno.test("library facets - uploaded years count the upload date and skip videos without one", async () => {
  const stubbed = stubFacetQueries();
  try {
    await libraryFacets(null, { dateField: "uploaded" }, NOW);
    const uploaded = queryFor(stubbed.grouped, "year");
    assert(uploaded.expression.includes("uploadDate"));
    assert(!uploaded.expression.includes("createdAt"));
    // No uploadDate means no year to count the video under.
    assertEquals(
      leaves(uploaded.videoWhere).length,
      0,
      "the only condition is the not-null test",
    );
    assert(names(uploaded.videoWhere, "uploadDate"));

    // The default still reads when the video was added.
    stubbed.grouped.length = 0;
    await libraryFacets(null, {}, NOW);
    const added = queryFor(stubbed.grouped, "year");
    assert(added.expression.includes("createdAt"));
    assert(!added.expression.includes("uploadDate"));
  } finally {
    stubbed.restore();
  }
});

Deno.test("library facets - uploaded months are counted inside the chosen year, on the upload date", async () => {
  const stubbed = stubFacetQueries();
  try {
    await libraryFacets(null, { dateField: "uploaded", year: 2026 }, NOW);
    const month = queryFor(stubbed.grouped, "month");
    assert(month.expression.includes("uploadDate"));
    // The year's range is on uploadDate too, so a month is a month of that
    // year's uploads.
    assert(leaves(month.videoWhere).includes("2026-01-01"));
    assert(leaves(month.videoWhere).includes("2027-01-01"));
  } finally {
    stubbed.restore();
  }
});

Deno.test("library facets - the creator query is validated at the route", () => {
  for (const creatorQuery of ["", "x".repeat(101)]) {
    let reached = false;
    let status = 0;
    // deno-lint-ignore no-explicit-any
    const guarded = validateBody(LibraryFacetsRequestSchema as any, () => {
      reached = true;
    });
    guarded({ creatorQuery }, {
      headersSent: false,
      setHeader: () => {},
      writeHead: (s: number) => {
        status = s;
      },
      write: () => {},
      end: () => {},
    });
    assertEquals(status, 400);
    assertEquals(reached, false);
  }
});
