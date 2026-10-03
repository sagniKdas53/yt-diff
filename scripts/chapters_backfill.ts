/**
 * One-off backfill: read chapters out of the files that are already on disk.
 *
 * `--embed-chapters` has been in the download options all along, so every file
 * downloaded so far already carries its chapters in the container. Browsers
 * cannot read them, and nothing had read them since they were written, which
 * is why this walks the library rather than re-downloading anything.
 *
 * Run via `deno task chapters:backfill`. It only touches rows whose
 * `chapters` is still null, so it is safe to run again: a video with no
 * chapters is left as null and re-probed, which costs one ffprobe, and a video
 * with chapters is never touched twice.
 */

import { Op } from "sequelize";
import { config } from "../src/config.ts";
import {
  initializeDatabase,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";
import { readChapters } from "../src/handlers/pipeline/chapters.ts";
import { logger } from "../src/logger.ts";
import { exists } from "../src/utils/fs.ts";
import { join } from "../src/utils/path.ts";

/** How many rows one pass looks at. */
const BATCH_LIMIT = 200;

/**
 * Where the last batch stopped, so the next one starts after it rather than
 * over it.
 *
 * A cursor and not an offset: a row this pass fills in gets a new `updatedAt`
 * and would slide backwards under an offset, reappearing in every later batch
 * forever. Keyed on `(updatedAt, videoUrl)` because `updatedAt` alone is not
 * unique and a page boundary landing inside a tie would drop the rest of it.
 */
let cursor: { updatedAt: Date; videoUrl: string } | null = null;

/**
 * Probes one batch, and reports whether there may be more.
 *
 * Rows that turn out to have no chapters are left null on purpose: that is
 * what "this file has none" looks like, and re-probing them costs one ffprobe
 * each, which is cheaper than a second column that says so. Re-probing them on
 * a later *run* is the intent; re-probing them in the next *batch* is a loop
 * that never reaches the rows behind them, which is why the batch advances a
 * cursor past everything it looked at rather than starting from the top.
 */
async function backfillBatch(): Promise<boolean> {
  const rows = await VideoMetadata.findAll({
    where: {
      downloadStatus: true,
      chapters: null,
      ...(cursor === null ? {} : {
        [Op.or]: [
          { updatedAt: { [Op.gt]: cursor.updatedAt } },
          {
            updatedAt: cursor.updatedAt,
            videoUrl: { [Op.gt]: cursor.videoUrl },
          },
        ],
      }),
    },
    attributes: ["videoUrl", "saveDirectory", "fileName", "updatedAt"],
    order: [["updatedAt", "ASC"], ["videoUrl", "ASC"]],
    limit: BATCH_LIMIT,
  });

  if (rows.length === 0) {
    return false;
  }

  // Taken before anything is written. A row filled in below gets a new
  // `updatedAt`, and a cursor read afterwards would point past rows this pass
  // never looked at.
  const last = rows.at(-1)!;
  const nextCursor = {
    updatedAt: last.getDataValue("updatedAt") as Date,
    videoUrl: last.getDataValue("videoUrl") as string,
  };

  let withChapters = 0;
  for (const row of rows) {
    const saveDirectory = row.getDataValue("saveDirectory") as string | null;
    const fileName = row.getDataValue("fileName") as string | null;
    if (!fileName) {
      continue;
    }

    const filePath = join(
      config.saveLocation,
      (saveDirectory ?? "").trim(),
      fileName,
    );
    if (!(await exists(filePath))) {
      logger.warn("Downloaded row has no file on disk; skipping", {
        url: row.getDataValue("videoUrl"),
        filePath,
      });
      continue;
    }

    const chapters = await readChapters(filePath);
    if (chapters.length === 0) {
      continue;
    }

    await row.update({ chapters });
    withChapters++;
  }

  logger.info("Chapters backfill batch complete", {
    considered: rows.length,
    withChapters,
  });

  cursor = nextCursor;

  // A full batch means there may be more; a short one means this was the last.
  return rows.length === BATCH_LIMIT;
}

if (import.meta.main) {
  await initializeDatabase();
  try {
    let more = true;
    while (more) {
      more = await backfillBatch();
    }
    logger.info("Chapters backfill finished", {});
  } finally {
    await sequelize.close();
  }
}
