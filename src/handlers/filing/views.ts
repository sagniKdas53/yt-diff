import { literal, Op, type WhereOptions } from "sequelize";
import type { z } from "zod";
import { config } from "../../config.ts";
import { sequelize } from "../../db/models.ts";
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
