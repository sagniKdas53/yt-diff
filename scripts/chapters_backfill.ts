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
 * Probes one batch, and reports whether there may be more.
 *
 * Rows that turn out to have no chapters are left null on purpose: that is
 * what "this file has none" looks like, and re-probing them on the next pass
 * is one ffprobe each, which is cheaper than a second column that says so.
 */
async function backfillBatch(): Promise<boolean> {
  const rows = await VideoMetadata.findAll({
    where: { downloadStatus: true, chapters: null },
    attributes: ["videoUrl", "saveDirectory", "fileName"],
    order: [["updatedAt", "ASC"]],
    limit: BATCH_LIMIT,
  });

  if (rows.length === 0) {
    return false;
  }

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
