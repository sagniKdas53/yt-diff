import { Op } from "sequelize";

import {
  BotSubmission,
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../db/models.ts";
import { removeVideoFiles } from "../handlers/videoFiles.ts";
import { logger } from "../logger.ts";

/** Monitoring types whose videos are persistent by definition. */
const MONITORED_TYPES = ["Start", "End", "Full"];

export interface ReapSummary {
  considered: number;
  reaped: number;
  skipped: number;
}

/**
 * Deletes the files of expired ephemeral bot downloads.
 *
 * Three guards, all load-bearing:
 *
 * 1. `downloadedByBot = true` only. A file that already existed when the bot
 *    was asked for it is never reaped — that covers web-UI downloads and
 *    re-sends of something the bot fetched earlier.
 * 2. Only videos that have a BotSubmission at all, which is implied by
 *    selecting from BotSubmission but stated here because it is the same rule.
 * 3. Skip anything mapped to a playlist monitored Start/End/Full, or the reaper
 *    and the scheduled-update job fight over the same files.
 *
 * The VideoMetadata row and its playlist mapping always survive; only the files
 * go, and the row is reset to "not downloaded" so it can be fetched again.
 */
export async function reapExpiredSubmissions(
  now: Date = new Date(),
): Promise<ReapSummary> {
  const candidates = await BotSubmission.findAll({
    where: {
      status: "delivered",
      retention: "ephemeral",
      downloadedByBot: true,
      expiresAt: { [Op.ne]: null, [Op.lt]: now },
      canonicalUrl: { [Op.ne]: null },
    },
    limit: 500,
  });

  const summary: ReapSummary = {
    considered: candidates.length,
    reaped: 0,
    skipped: 0,
  };

  if (candidates.length === 0) {
    // Say so explicitly. A silent sweep is indistinguishable from a broken one,
    // and matches how the prune job reports having nothing to do.
    logger.debug("No expired bot downloads found to reap");
    return summary;
  }

  for (const submission of candidates) {
    const videoUrl = submission.canonicalUrl;
    if (!videoUrl) {
      summary.skipped++;
      continue;
    }

    try {
      const monitoredMapping = await PlaylistVideoMapping.findOne({
        where: { videoUrl },
        include: [{
          model: PlaylistMetadata,
          required: true,
          where: { monitoringType: { [Op.in]: MONITORED_TYPES } },
        }],
      });

      if (monitoredMapping) {
        logger.debug("Reaper skipping a monitored playlist's video", {
          videoUrl,
        });
        summary.skipped++;
        continue;
      }

      const video = await VideoMetadata.findOne({ where: { videoUrl } });
      if (!video || !video.downloadStatus) {
        // Already gone or already reset; just close out the submission.
        await submission.update({ status: "reaped" });
        summary.skipped++;
        continue;
      }

      const removed = await removeVideoFiles(video);
      if (!removed) {
        logger.warn("Reaper could not remove every file; leaving the row", {
          videoUrl,
        });
        summary.skipped++;
        continue;
      }

      // Matches the web UI's delete-with-cleanup reset exactly.
      await video.update({
        downloadStatus: false,
        fileName: null,
        thumbNailFile: null,
        subTitleFile: null,
        commentsFile: null,
        descriptionFile: null,
        saveDirectory: null,
      });
      await submission.update({ status: "reaped" });
      summary.reaped++;
    } catch (error) {
      logger.error("Reaper failed on a submission", {
        submissionId: submission.id,
        videoUrl,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      summary.skipped++;
    }
  }

  // Debug, not info: the cron wrapper logs the same summary at info with the
  // next run time, matching how the other jobs report. This line only matters
  // when reapExpiredSubmissions is called directly.
  logger.debug("Bot retention sweep complete", {
    considered: summary.considered,
    reaped: summary.reaped,
    skipped: summary.skipped,
  });

  return summary;
}
