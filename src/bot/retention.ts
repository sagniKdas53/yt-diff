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
export const MONITORED_TYPES = ["Start", "End", "Full"];

/** How many submissions one sweep will look at. */
const REAP_BATCH_LIMIT = 500;

export interface ReapSummary {
  considered: number;
  reaped: number;
  skipped: number;
}

/** The only fields the reaper needs from a submission. */
export interface ReapCandidate {
  id: string;
  canonicalUrl: string | null;
}

/**
 * Every database interaction the reaper needs, behind one injectable seam.
 *
 * Mirrors `BotStore` so the sweep's orchestration can be tested without a
 * database, exactly as `BotCore` is.
 */
export interface RetentionStore {
  findExpiredSubmissions(now: Date, limit: number): Promise<ReapCandidate[]>;
  /** True when the video belongs to a Start/End/Full monitored playlist. */
  isInMonitoredPlaylist(videoUrl: string): Promise<boolean>;
  /** True/false for the row's downloadStatus, or null when there is no row. */
  getDownloadStatus(videoUrl: string): Promise<boolean | null>;
  /** Removes files and clears the file columns. False if anything failed. */
  purgeVideoFiles(videoUrl: string): Promise<boolean>;
  markReaped(submissionId: string): Promise<void>;
}

/**
 * The selection criteria for a reapable submission.
 *
 * Exported so the guards can be asserted directly — two of the three live in
 * this WHERE clause rather than in control flow, and a fake store would happily
 * return anything regardless of what the real query filters.
 *
 * 1. `downloadedByBot: true` — never touch a file the bot did not fetch.
 * 2. Selecting from BotSubmission at all — a video with no submission is
 *    unreachable.
 */
export function buildExpiredSubmissionWhere(now: Date) {
  return {
    status: "delivered",
    retention: "ephemeral",
    downloadedByBot: true,
    expiresAt: { [Op.ne]: null, [Op.lt]: now },
    canonicalUrl: { [Op.ne]: null },
  };
}

/** Sequelize-backed implementation used in production. */
export function createSequelizeRetentionStore(): RetentionStore {
  return {
    async findExpiredSubmissions(now, limit) {
      const rows = await BotSubmission.findAll({
        where: buildExpiredSubmissionWhere(now),
        limit,
      });
      return rows.map((row) => ({
        id: row.id,
        canonicalUrl: row.canonicalUrl ?? null,
      }));
    },

    async isInMonitoredPlaylist(videoUrl) {
      const mapping = await PlaylistVideoMapping.findOne({
        where: { videoUrl },
        include: [{
          model: PlaylistMetadata,
          required: true,
          where: { monitoringType: { [Op.in]: MONITORED_TYPES } },
        }],
      });
      return mapping !== null;
    },

    async getDownloadStatus(videoUrl) {
      const video = await VideoMetadata.findOne({ where: { videoUrl } });
      return video ? video.downloadStatus : null;
    },

    async purgeVideoFiles(videoUrl) {
      const video = await VideoMetadata.findOne({ where: { videoUrl } });
      if (!video) {
        return false;
      }

      const removed = await removeVideoFiles(video);
      if (!removed) {
        return false;
      }

      // Matches the web UI's delete-with-cleanup reset exactly, so the two
      // cannot drift on which columns count as file state.
      await video.update({
        downloadStatus: false,
        fileName: null,
        thumbNailFile: null,
        subTitleFile: null,
        commentsFile: null,
        descriptionFile: null,
        saveDirectory: null,
      });
      return true;
    },

    async markReaped(submissionId) {
      await BotSubmission.update(
        { status: "reaped" },
        { where: { id: submissionId } },
      );
    },
  };
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
 *
 * @param now - Treated as the current time; injectable for tests
 * @param store - Database seam; defaults to the Sequelize implementation
 */
export async function reapExpiredSubmissions(
  now: Date = new Date(),
  store: RetentionStore = createSequelizeRetentionStore(),
): Promise<ReapSummary> {
  const candidates = await store.findExpiredSubmissions(now, REAP_BATCH_LIMIT);

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
      if (await store.isInMonitoredPlaylist(videoUrl)) {
        logger.debug("Reaper skipping a monitored playlist's video", {
          videoUrl,
        });
        summary.skipped++;
        continue;
      }

      const downloadStatus = await store.getDownloadStatus(videoUrl);
      if (downloadStatus !== true) {
        // Already gone or already reset; just close out the submission.
        await store.markReaped(submission.id);
        summary.skipped++;
        continue;
      }

      const removed = await store.purgeVideoFiles(videoUrl);
      if (!removed) {
        // Leave the submission alone so the next sweep retries it.
        logger.warn("Reaper could not remove every file; leaving the row", {
          videoUrl,
        });
        summary.skipped++;
        continue;
      }

      await store.markReaped(submission.id);
      summary.reaped++;
    } catch (error) {
      // One bad submission must not abort the whole sweep.
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
