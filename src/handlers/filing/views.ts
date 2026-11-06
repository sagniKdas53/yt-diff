import { col, fn, literal, Op, type WhereOptions } from "sequelize";
import type { z } from "zod";
import { config } from "../../config.ts";
import {
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import {
  LibraryFilterSchema,
  LibraryViewSchema,
} from "../../middleware/validator.ts";
import { CLIP_MAX_SECONDS, INBOX_DAYS } from "./rules.ts";

export type LibraryView = z.infer<typeof LibraryViewSchema>;
export type LibraryFilter = z.infer<typeof LibraryFilterSchema>;
export type LengthBand = NonNullable<LibraryFilter["length"]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validates the `view` and `filter` of a request body. Null means a malformed
 * value, which the caller answers with 400 and never queries.
 */
export function parseLibraryRequest(
  raw: unknown,
): { view: LibraryView | null; filter: LibraryFilter } | null {
  const body = (raw ?? {}) as Record<string, unknown>;
  const view = LibraryViewSchema.nullish().safeParse(body.view);
  const filter = LibraryFilterSchema.optional().safeParse(body.filter);
  if (!view.success || !filter.success) return null;
  return { view: view.data ?? null, filter: filter.data ?? {} };
}

/** A view only means something in Unlisted; on a real playlist it's ignored. */
export function viewForPlaylist(
  playlistUrl: string,
  view: LibraryView | null,
): LibraryView | null {
  return playlistUrl === "None" ? view : null;
}

/** Joins the conditions that are there, so none can overwrite another. */
export function andWhere(
  ...parts: Array<WhereOptions | undefined>
): WhereOptions | undefined {
  const present = parts.filter((p): p is WhereOptions => p !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : { [Op.and]: present };
}

function lengthBand(band: LengthBand): WhereOptions {
  switch (band) {
    case "unknown":
      return { durationSeconds: null };
    case "clip":
      return { durationSeconds: { [Op.lt]: CLIP_MAX_SECONDS } };
    case "short":
      return {
        durationSeconds: { [Op.gte]: CLIP_MAX_SECONDS, [Op.lt]: 10 * 60 },
      };
    case "medium":
      return { durationSeconds: { [Op.gte]: 10 * 60, [Op.lt]: 60 * 60 } };
    case "long":
      return { durationSeconds: { [Op.gte]: 60 * 60 } };
  }
}

/**
 * The start of a month (or of a year, when `month` is 1) in the configured
 * zone, as a value expression. A range on the added time rather than an
 * EXTRACT over it: nothing here names the table alias, and the added time
 * stays comparable with an index. Year and month are integers by the schema;
 * the zone is escaped.
 */
function startOf(year: number, month: number) {
  return literal(
    `make_timestamptz(${year}, ${month}, 1, 0, 0, 0, ${
      sequelize.escape(config.timeZone)
    })`,
  );
}

/**
 * Turns a view and a filter into conditions on the mapping and on the video.
 *
 * Every condition is its own entry under `Op.and`, never a spread, so a filter
 * can't overwrite what the view needs: the Inbox is saved videos, and "Links
 * only" inside it is correctly empty rather than a list of unsaved links.
 * Nothing user-supplied is concatenated into SQL. Site and channel are
 * equality values Sequelize sends as parameters, and the subqueries below are
 * constants that name no table alias.
 */
export function buildLibraryFilter(
  view: LibraryView | null,
  filter: LibraryFilter,
  now: Date = new Date(),
): { videoWhere?: WhereOptions; mappingWhere?: WhereOptions } {
  const video: WhereOptions[] = [];
  const mapping: WhereOptions[] = [];

  switch (view) {
    case "inbox":
      mapping.push({
        createdAt: { [Op.gte]: new Date(now.getTime() - INBOX_DAYS * DAY_MS) },
      });
      video.push({ downloadStatus: true });
      break;
    case "bot":
      mapping.push({
        videoUrl: {
          [Op.in]: literal(`(SELECT "canonicalUrl" FROM bot_submissions)`),
        },
      });
      break;
    case "clips":
      mapping.push({
        videoUrl: {
          [Op.in]: literal(
            `(SELECT "videoUrl" FROM video_filing WHERE "placement" = 'clip')`,
          ),
        },
      });
      break;
    case "archive":
      // Swept as Archive, or not swept yet. `video_filing."videoUrl"` is a
      // primary key, so it is never null and NOT IN is safe here.
      mapping.push({
        videoUrl: {
          [Op.notIn]: literal(
            `(SELECT "videoUrl" FROM video_filing WHERE "placement" <> 'archive')`,
          ),
        },
      });
      break;
  }

  if (filter.saved !== undefined) video.push({ downloadStatus: filter.saved });
  if (filter.site !== undefined) video.push({ site: filter.site });
  if (filter.channel !== undefined) video.push({ channelKey: filter.channel });
  if (filter.length !== undefined) video.push(lengthBand(filter.length));

  if (filter.year !== undefined) {
    const { year, month } = filter;
    const next = month === undefined
      ? [year + 1, 1]
      : month === 12
      ? [year + 1, 1]
      : [year, month + 1];
    mapping.push(
      { createdAt: { [Op.gte]: startOf(year, month ?? 1) } },
      { createdAt: { [Op.lt]: startOf(next[0], next[1]) } },
    );
  }

  return {
    videoWhere: video.length > 0 ? { [Op.and]: video } : undefined,
    mappingWhere: view !== null || mapping.length > 0
      ? {
        ...(view !== null ? { playlistUrl: "None" } : {}),
        ...(mapping.length > 0 ? { [Op.and]: mapping } : {}),
      }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Counts for the rail and the filter bar
// ---------------------------------------------------------------------------

export type FacetDimension =
  | "saved"
  | "site"
  | "year"
  | "month"
  | "length"
  | "channel";

/**
 * The filter a dimension's own counts are taken under: everything except that
 * dimension's selection. Picking one site must still list the other sites, or
 * the filter bar would only ever show the choice already made. Dropping the
 * year drops the month with it, because a month means nothing without a year.
 */
export function filterWithout(
  filter: LibraryFilter,
  dimension: FacetDimension,
): LibraryFilter {
  const rest = { ...filter };
  switch (dimension) {
    case "year":
      delete rest.year;
      delete rest.month;
      break;
    default:
      delete rest[dimension];
  }
  return rest;
}

/**
 * The label for a key that has been seen under several names: the most common
 * one, then the first alphabetically so the choice never flips between runs.
 */
export function pickName(
  entries: Array<{ name: string | null; count: number }>,
): string | null {
  const named = entries.filter(
    (e): e is { name: string; count: number } => e.name !== null,
  );
  if (named.length === 0) return null;
  named.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return named[0].name;
}

export interface LibrarySummary {
  inbox: number;
  bot: number;
  clips: number;
  archive: number;
  all: number;
  notSwept: number;
}

export interface LibraryFacets {
  saved: { saved: number; links: number };
  sites: Array<{ site: string; name: string; count: number }>;
  years: Array<{ year: number; count: number }>;
  months: Array<{ month: number; count: number }>;
  lengths: Array<{ band: LengthBand; count: number }>;
  creators: Array<{ key: string; name: string; count: number }>;
}

const LENGTH_BANDS: LengthBand[] = [
  "clip",
  "short",
  "medium",
  "long",
  "unknown",
];
const CREATOR_LIMIT = 50;

/** Counts of Unlisted under a view and filter. */
async function countUnlisted(
  view: LibraryView | null,
  filter: LibraryFilter,
  now: Date,
): Promise<number> {
  const { videoWhere, mappingWhere } = buildLibraryFilter(view, filter, now);
  return await PlaylistVideoMapping.count({
    where: andWhere({ playlistUrl: "None" }, mappingWhere)!,
    include: videoWhere === undefined ? undefined : [{
      model: VideoMetadata,
      attributes: [],
      required: true,
      where: videoWhere,
    }],
  });
}

/**
 * Grouped counts of Unlisted under a view and filter. The expressions name the
 * two table aliases Sequelize gives this query (the mapping, and the video
 * through its association); there is no limit here, so the query is never
 * wrapped in a subquery and they hold.
 */
async function groupedCounts(
  view: LibraryView | null,
  filter: LibraryFilter,
  now: Date,
  groups: Array<
    [expression: ReturnType<typeof col> | ReturnType<typeof fn>, alias: string]
  >,
): Promise<Array<Record<string, unknown> & { count: number }>> {
  const { videoWhere, mappingWhere } = buildLibraryFilter(view, filter, now);
  const found = await PlaylistVideoMapping.findAll({
    attributes: [
      ...groups.map(([expression, alias]): [typeof expression, string] => [
        expression,
        alias,
      ]),
      [fn("COUNT", col("playlist_video_mapping.id")), "count"],
    ],
    where: andWhere({ playlistUrl: "None" }, mappingWhere)!,
    include: [{
      model: VideoMetadata,
      attributes: [],
      required: true,
      where: videoWhere,
    }],
    group: groups.map(([expression]) => expression),
    raw: true,
  }) as unknown as Array<Record<string, unknown>>;
  return found.map((row) => ({ ...row, count: Number(row.count) }));
}

const addedIn = (unit: "year" | "month") =>
  fn(
    "date_part",
    unit,
    literal(
      `"playlist_video_mapping"."createdAt" AT TIME ZONE ${
        sequelize.escape(config.timeZone)
      }`,
    ),
  );

/** How many videos each view holds, for the rail. */
export async function librarySummary(
  now: Date = new Date(),
): Promise<LibrarySummary> {
  const [inbox, bot, clips, archive, all, notSwept] = await Promise.all([
    countUnlisted("inbox", {}, now),
    countUnlisted("bot", {}, now),
    countUnlisted("clips", {}, now),
    countUnlisted("archive", {}, now),
    countUnlisted(null, {}, now),
    PlaylistVideoMapping.count({
      where: {
        playlistUrl: "None",
        videoUrl: {
          [Op.notIn]: literal(`(SELECT "videoUrl" FROM video_filing)`),
        },
      },
    }),
  ]);
  return { inbox, bot, clips, archive, all, notSwept };
}

/**
 * The options and counts for the filter bar. Each list is counted under the
 * view and every filter except its own selection, so each one still offers the
 * alternatives to what is picked.
 */
export async function libraryFacets(
  view: LibraryView | null,
  filter: LibraryFilter,
  now: Date = new Date(),
): Promise<LibraryFacets> {
  const [saved, links, lengths, sites, years, months, creators] = await Promise
    .all([
      countUnlisted(
        view,
        { ...filterWithout(filter, "saved"), saved: true },
        now,
      ),
      countUnlisted(
        view,
        { ...filterWithout(filter, "saved"), saved: false },
        now,
      ),
      Promise.all(LENGTH_BANDS.map(async (band) => ({
        band,
        count: await countUnlisted(
          view,
          { ...filterWithout(filter, "length"), length: band },
          now,
        ),
      }))),
      groupedCounts(view, filterWithout(filter, "site"), now, [
        [col("video_metadatum.site"), "site"],
        [col("video_metadatum.siteName"), "siteName"],
      ]),
      groupedCounts(view, filterWithout(filter, "year"), now, [
        [addedIn("year"), "year"],
      ]),
      // Months only mean something inside a year.
      filter.year === undefined ? Promise.resolve([]) : groupedCounts(
        view,
        filterWithout(filter, "month"),
        now,
        [[addedIn("month"), "month"]],
      ),
      groupedCounts(view, filterWithout(filter, "channel"), now, [
        [col("video_metadatum.channelKey"), "channelKey"],
        [col("video_metadatum.channelName"), "channelName"],
      ]),
    ]);

  // Rows come back per (key, name); fold them into one entry per key.
  const fold = (
    rows: Array<Record<string, unknown> & { count: number }>,
    keyField: string,
    nameField: string,
  ) => {
    const byKey = new Map<
      string,
      Array<{ name: string | null; count: number }>
    >();
    for (const row of rows) {
      const key = row[keyField] as string | null;
      if (key === null || key === undefined) continue;
      const entries = byKey.get(key) ?? [];
      entries.push({
        name: (row[nameField] as string | null) ?? null,
        count: row.count,
      });
      byKey.set(key, entries);
    }
    return [...byKey].map(([key, entries]) => ({
      key,
      name: pickName(entries) ?? key,
      count: entries.reduce((sum, e) => sum + e.count, 0),
    }));
  };
  const byCountThenName = <T extends { count: number; name: string }>(
    a: T,
    b: T,
  ) => b.count - a.count || a.name.localeCompare(b.name);

  return {
    saved: { saved, links },
    sites: fold(sites, "site", "siteName")
      .map(({ key, name, count }) => ({ site: key, name, count }))
      .sort(byCountThenName),
    years: years
      .map((row) => ({ year: Number(row.year), count: row.count }))
      .sort((a, b) => b.year - a.year),
    months: months
      .map((row) => ({ month: Number(row.month), count: row.count }))
      .sort((a, b) => a.month - b.month),
    lengths,
    creators: fold(creators, "channelKey", "channelName")
      .sort(byCountThenName)
      .slice(0, CREATOR_LIMIT),
  };
}
