import { CronJob } from "cron";
import { Model, Op } from "sequelize";

import { config } from "../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../db/models.ts";
import { logger } from "../logger.ts";

import {
  type CleanupOptions,
  type CleanupStaleProcesses,
  type ListingItem as JobListingItem,
  type ListingResult as JobResult,
  type ListItemsConcurrently,
  type ProcessLike,
} from "../handlers/pipeline/index.ts";

interface JobDependencies {
  cleanupStaleProcesses: CleanupStaleProcesses;
  downloadProcesses: Map<string, ProcessLike>;
  listProcesses: Map<string, ProcessLike>;
  listItemsConcurrently: ListItemsConcurrently;
}

export type AppJobs = Record<"cleanup" | "update" | "prune", CronJob>;

function formatNextRun(job: CronJob) {
  return job.nextDate().toLocaleString(
    {
      weekday: "short",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    { timeZone: config.timeZone } as Intl.DateTimeFormatOptions,
  );
}

export function createJobs({
  cleanupStaleProcesses,
  downloadProcesses,
  listProcesses,
  listItemsConcurrently,
}: JobDependencies): AppJobs {
  const jobs = {} as AppJobs;

  jobs.cleanup = new CronJob(
    config.queue.cleanUpInterval,
    () => {
      logger.debug("Starting scheduled process cleanup");

      const cleanedDownloads = cleanupStaleProcesses(
        downloadProcesses,
        {
          maxIdleTime: config.queue.maxIdle,
          maxLifetime: config.queue.maxLifetime,
          forceKill: true,
        },
        "download",
      );

      const cleanedLists = cleanupStaleProcesses(
        listProcesses,
        {
          maxIdleTime: config.queue.maxIdle,
          maxLifetime: config.queue.maxLifetime,
          forceKill: true,
        },
        "list",
      );

      logger.info("Completed scheduled process cleanup", {
        cleanedDownloads,
        cleanedLists,
        nextRun: formatNextRun(jobs.cleanup),
      });
    },
    null,
    true,
    config.timeZone,
  );

  jobs.update = new CronJob(
    config.scheduledUpdateStr,
    () => {
      logger.debug("Starting scheduled update", {
        time: new Date().toLocaleString("en-US", { timeZone: config.timeZone }),
        timeZone: config.timeZone,
        nextRun: formatNextRun(jobs.update),
      });

      void (async () => {
        try {
          // Scheduled updates cover the same modes as the legacy monolith:
          // Start is optimized for feeds where new items appear first,
          // End is for feeds that append near the tail,
          // Full forces a complete re-scan and is the most expensive mode.
          const allPlaylists = await PlaylistMetadata.findAll({
            where: {
              monitoringType: {
                [Op.in]: ["Start", "End", "Full"],
              },
            },
          });

          if (allPlaylists.length === 0) {
            logger.info(
              "No playlists with Start/End/Full monitoring found; skipping update",
            );
            return;
          }

          const startPlaylists = allPlaylists.filter(
            (p: Model) => p.getDataValue("monitoringType") === "Start",
          );
          const endPlaylists = allPlaylists.filter(
            (p: Model) => p.getDataValue("monitoringType") === "End",
          );
          const fullPlaylists = allPlaylists.filter(
            (p: Model) => p.getDataValue("monitoringType") === "Full",
          );

          // Start and End are cheaper incremental passes, so queue them ahead of
          // Full updates instead of letting full scans occupy listing slots first.
          logger.info("Scheduler: starting playlist updates", {
            startCount: startPlaylists.length,
            endCount: endPlaylists.length,
            fullCount: fullPlaylists.length,
          });

          const startItems = startPlaylists.map((p: Model) => ({
            url: p.getDataValue("playlistUrl") as string,
            type: "playlist",
            currentMonitoringType: "Start",
            isScheduledUpdate: true,
            reason: "Scheduled Start update",
          }));

          const endItems = endPlaylists.map((p: Model) => ({
            url: p.getDataValue("playlistUrl") as string,
            type: "playlist",
            currentMonitoringType: "End",
            isScheduledUpdate: true,
            reason: "Scheduled End update",
          }));

          const fullItems = fullPlaylists.map((p: Model) => ({
            url: p.getDataValue("playlistUrl") as string,
            type: "playlist",
            currentMonitoringType: "Full",
            isScheduledUpdate: true,
            reason: "Scheduled Full update",
          }));

          // isScheduledUpdate=true bypasses the "same monitoringType => skip"
          // guard in the listing pipeline so cron-driven refreshes actually run.
          const results = await listItemsConcurrently(
            [...startItems, ...endItems, ...fullItems],
            config.chunkSize,
            true,
          );

          const completedCount = results.filter(
            (r: { status?: string }) =>
              r && (r.status === "completed" || r.status === "success"),
          ).length;

          logger.info("Completed scheduled updates", {
            totalPlaylists: allPlaylists.length,
            completedCount,
            nextRun: formatNextRun(jobs.update),
          });
        } catch (err) {
          logger.error("Scheduled update failed", {
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
        }
      })();
    },
    null,
    true,
    config.timeZone,
  );

  jobs.prune = new CronJob(
    config.pruneInterval,
    () => {
      logger.debug("Starting scheduled DB prune process");
      void (async () => {
        try {
          // Use NOT EXISTS so pruning stays in SQL instead of loading all mapped
          // video URLs into memory first.
          const unreferencedVideos = await VideoMetadata.findAll({
            where: sequelize.literal(`NOT EXISTS (
              SELECT 1 FROM playlist_video_mappings 
              WHERE playlist_video_mappings."videoUrl" = video_metadata."videoUrl"
            )`),
          });

          if (unreferencedVideos.length === 0) {
            logger.info("No unreferenced videos found to prune");
            return;
          }

          const mappingsToCreate = [];
          const videoUrlsToDestroy = [];

          const maxPositionResult = await PlaylistVideoMapping.max(
            "positionInPlaylist",
            {
              where: { playlistUrl: "None" },
            },
          );
          const maxPosition =
            typeof maxPositionResult === "number" && !isNaN(maxPositionResult)
              ? maxPositionResult
              : -1;
          let nextPosition = maxPosition;

          for (const video of unreferencedVideos) {
            const isDownloaded = video.getDataValue("downloadStatus");
            const videoUrl = video.getDataValue("videoUrl");

            if (isDownloaded) {
              mappingsToCreate.push({
                videoUrl,
                playlistUrl: "None",
                positionInPlaylist: ++nextPosition,
              });
            } else {
              videoUrlsToDestroy.push(videoUrl);
            }
          }

          if (mappingsToCreate.length > 0) {
            await PlaylistVideoMapping.bulkCreate(mappingsToCreate);
            logger.info("Moved unreferenced downloaded videos to 'None' playlist", {
              count: mappingsToCreate.length,
            });
          }

          if (videoUrlsToDestroy.length > 0) {
            await VideoMetadata.destroy({
              where: { videoUrl: { [Op.in]: videoUrlsToDestroy } },
            });
            logger.info("Pruned unreferenced non-downloaded videos", {
              count: videoUrlsToDestroy.length,
            });
          }

          logger.info("Completed DB prune process", {
            movedCount: mappingsToCreate.length,
            prunedCount: videoUrlsToDestroy.length,
            nextRun: formatNextRun(jobs.prune),
          });
        } catch (err) {
          logger.error("DB prune process failed", {
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
        }
      })();
    },
    null,
    true,
    config.timeZone,
  );

  return jobs;
}

export function startJobs(jobs: AppJobs) {
  for (const [name, job] of Object.entries(jobs)) {
    job.start();
    const jobWithCronTime = job as unknown as { cronTime: { source: string } };
    logger.info(`Started ${name} job`, {
      schedule: jobWithCronTime.cronTime.source,
      nextRun: formatNextRun(job),
    });
  }
}
