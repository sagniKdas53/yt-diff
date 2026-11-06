/**
 * One-off backfill: fill the facet columns for rows ingested before they
 * existed.
 *
 * Everything is derived from `raw_metadata` and the URL, both already stored,
 * so nothing is re-indexed and no network is needed. Run via
 * `deno task facets:backfill`. It only picks rows whose `site` is still null
 * and every row it touches gets a site, so it is safe to run again.
 *
 * Updates are `silent`, which leaves `updatedAt` alone: the Inbox and the
 * reaper read it, and a backfill is not an edit anyone made.
 */

import { Op } from "sequelize";
import {
  initializeDatabase,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";
import { deriveFacets } from "../src/handlers/filing/facets.ts";
import { logger } from "../src/logger.ts";

const BATCH_LIMIT = 500;

export interface BackfillTotals {
  considered: number;
  withChannel: number;
  withoutChannel: number;
  withDuration: number;
  withoutDuration: number;
}

export function emptyTotals(): BackfillTotals {
  return {
    considered: 0,
    withChannel: 0,
    withoutChannel: 0,
    withDuration: 0,
    withoutDuration: 0,
  };
}

/**
 * Fills one batch after `cursor`, and returns the last URL it looked at, or
 * null when nothing was left. A cursor and not an offset, so a row that stops
 * matching `site IS NULL` after its update can't shift the page under us.
 */
export async function backfillBatch(
  cursor: string | null,
  totals: BackfillTotals,
): Promise<string | null> {
  // Unscoped: the default scope leaves raw_metadata out.
  const rows = await VideoMetadata.unscoped().findAll({
    where: {
      site: null,
      ...(cursor === null ? {} : { videoUrl: { [Op.gt]: cursor } }),
    },
    attributes: ["videoUrl", "raw_metadata"],
    order: [["videoUrl", "ASC"]],
    limit: BATCH_LIMIT,
  });
  if (rows.length === 0) return null;

  for (const row of rows) {
    const videoUrl = row.getDataValue("videoUrl") as string;
    const raw = row.getDataValue("raw_metadata") as
      | Record<string, unknown>
      | null;
    const facets = deriveFacets(raw, videoUrl);

    await row.update(facets, { silent: true });

    totals.considered++;
    if (facets.channelKey === null) totals.withoutChannel++;
    else totals.withChannel++;
    if (facets.durationSeconds === null) totals.withoutDuration++;
    else totals.withDuration++;
  }

  logger.info("Facets backfill batch complete", { ...totals });
  return rows.at(-1)!.getDataValue("videoUrl") as string;
}

if (import.meta.main) {
  await initializeDatabase();
  try {
    const totals = emptyTotals();
    let cursor: string | null = null;
    do {
      cursor = await backfillBatch(cursor, totals);
    } while (cursor !== null);
    logger.info("Facets backfill finished", { ...totals });
  } finally {
    await sequelize.close();
  }
}
