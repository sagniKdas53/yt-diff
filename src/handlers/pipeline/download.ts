import he from "he";
import { Op } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { exists, mkdir, readdir } from "../../utils/fs.ts";
import {
  basename,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "../../utils/path.ts";
import { Semaphore } from "./semaphore.ts";
import type {
  DiscoveredMetadata,
  DownloadCompletionUpdates,
  DownloadItem,
  DownloadProcessEntry,
  DownloadRequestBody,
  DownloadResult,
  FileSyncStatus,
  HttpError,
  PipelineHandlerDependencies,
  VideoEntryRecord,
} from "./types.ts";
import { downloadOptions, ProcessExitCodes } from "./types.ts";
import { json } from "../../utils/http.ts";
import type { ProcessStatus, ProcessStatusOptions } from "./process-manager.ts";
import { createYtDlpLauncher } from "./ytdlp.ts";

export function createDownloadFlow(
  deps: PipelineHandlerDependencies,
  downloadProcesses: Map<string, DownloadProcessEntry>,
  processManager: {
    updateProcessActivity: (processKey: string, isStdout?: boolean) => void;
    setProcessStatus: (
      processKey: string,
      status: ProcessStatus,
      options?: ProcessStatusOptions,
    ) => boolean;
    cleanupProcess: (processKey: string, pid: number | undefined) => void;
  },
) {
  const { safeEmit, buildSiteArgs, spawnPythonProcess, streamTextChunks } =
    deps;
  const DownloadSemaphore = new Semaphore(
    config.queue.maxDownloads,
    "DownloadSemaphore",
  );
  const { updateProcessActivity, setProcessStatus, cleanupProcess } =
    processManager;
  const launchYtDlp = createYtDlpLauncher({
    buildSiteArgs,
    spawnPythonProcess,
  });
  let queueSequence = 0;

  /**
   * Resolves each URL's save directory, assigns queue positions, and starts the
   * downloads — everything `processDownloadRequest` did before it wrote a
   * response. Transport-agnostic so the bot can enqueue without an HTTP
   * response object.
   *
   * If any URL is not indexed, nothing is enqueued and the URL is returned in
   * `notIndexed`. That mirrors the original handler, which returned 404 on the
   * first miss and started no downloads at all; resolution short-circuits there
   * for the same reason, so `notIndexed` holds at most one entry.
   *
   * @param urlList - Video URLs to download; duplicates are ignored
   * @param playlistUrl - Owning playlist, or "None"/"init" for unlisted videos
   */
  async function resolveAndEnqueue(
    urlList: string[],
    playlistUrl: string,
  ): Promise<{
    items: (DownloadItem & { queuePosition: number })[];
    notIndexed: string[];
  }> {
    const videosToDownload: DownloadItem[] = [];
    const uniqueUrls = new Set();

    for (const videoUrl of urlList) {
      if (uniqueUrls.has(videoUrl)) {
        continue;
      }

      logger.debug("Checking video in database", { url: videoUrl });

      const videoEntry = await VideoMetadata.findOne({
        where: { videoUrl: videoUrl },
      });

      if (!videoEntry) {
        logger.error("Video not found in database", { url: videoUrl });
        return { items: [], notIndexed: [videoUrl] };
      }

      let saveDirectory = videoEntry.saveDirectory ?? "";

      if (playlistUrl !== "init" && playlistUrl !== "None") {
        try {
          const playlist = await PlaylistMetadata.findOne({
            where: { playlistUrl: playlistUrl },
          });
          if (playlist) {
            saveDirectory = playlist.saveDirectory;
          }
        } catch (error) {
          logger.error("Error getting playlist save directory", {
            error: (error as Error).message,
            playlistUrl,
          });
        }
      } else if (!saveDirectory || saveDirectory === "None") {
        try {
          const mapping = await PlaylistVideoMapping.findOne({
            where: {
              videoUrl: videoUrl,
              playlistUrl: {
                [Op.notIn]: ["init", "None"],
              },
            },
          });
          if (mapping) {
            const playlist = await PlaylistMetadata.findOne({
              where: { playlistUrl: mapping.playlistUrl },
            });
            if (playlist) {
              saveDirectory = playlist.saveDirectory;
            }
          }
        } catch (error) {
          logger.error("Error getting fallback playlist save directory", {
            error: (error as Error).message,
            videoUrl,
          });
        }
      }

      videosToDownload.push({
        url: videoUrl,
        title: videoEntry.title,
        saveDirectory: saveDirectory,
        videoId: videoEntry.videoId,
      });
      uniqueUrls.add(videoUrl);
    }

    // Assign queue positions before starting downloads so they can be
    // included in both the HTTP response and the socket events.
    const itemsWithPositions = videosToDownload.map((item) => ({
      ...item,
      queuePosition: ++queueSequence,
    }));

    void downloadItemsConcurrently(
      itemsWithPositions,
      config.queue.maxDownloads,
    );
    logger.debug("Download processes started", {
      itemCount: itemsWithPositions.length,
    });

    return { items: itemsWithPositions, notIndexed: [] };
  }

  async function processDownloadRequest(
    requestBody: DownloadRequestBody,
    response: HttpResponseLike,
  ) {
    try {
      const { items, notIndexed } = await resolveAndEnqueue(
        requestBody.urlList,
        requestBody.playListUrl ?? "None",
      );

      if (notIndexed.length > 0) {
        return json(response, 404, {
          error: `Video with URL ${notIndexed[0]} is not indexed`,
        });
      }

      json(response, 200, {
        status: "success",
        message: "Downloads initiated",
        items,
      });
    } catch (error) {
      logger.error("Download processing failed", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      json(response, statusCode, {
        status: "error",
        message: he.escape((error as Error).message),
      });
    }
  }

  async function downloadItemsConcurrently(
    items: (DownloadItem & { queuePosition: number })[],
    maxConcurrent: number = 2,
  ): Promise<boolean> {
    logger.trace(
      `Downloading ${items.length} videos concurrently (max ${maxConcurrent} concurrent)`,
    );

    DownloadSemaphore.setMaxConcurrent(maxConcurrent);

    const uniqueItems = items.filter((item) => {
      const existingDownload = Array.from(downloadProcesses.values())
        .find((process) =>
          process.url === item.url &&
          ["running", "pending"].includes(process.status)
        );
      return !existingDownload;
    });

    logger.trace(`Filtered ${uniqueItems.length} unique items for download`);

    const downloadResults = await Promise.all(
      uniqueItems.map((item) => downloadWithSemaphore(item)),
    );

    const allSuccessful = downloadResults.every((result) =>
      result && result.status === "success"
    );

    downloadResults.forEach((result) => {
      if (result.status === "success") {
        logger.info(`Downloaded ${result.title} successfully`);
      } else {
        logger.error(`Failed to download ${result.title}: ${result.error}`);
      }
    });

    return allSuccessful;
  }

  async function downloadWithSemaphore(
    downloadItem: DownloadItem & { queuePosition: number },
  ): Promise<DownloadResult> {
    logger.trace(
      `Starting download with semaphore: ${JSON.stringify(downloadItem)}`,
    );

    const { url: videoUrl, title: videoTitle, queuePosition } = downloadItem;
    const now = Date.now();
    const downloadEntry: DownloadProcessEntry = {
      url: videoUrl,
      title: videoTitle,
      queuePosition,
      spawnType: "download",
      lastActivity: now,
      lastStdoutActivity: now,
      spawnTimeStamp: now,
      status: "pending",
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    downloadProcesses.set(entryKey, downloadEntry);

    try {
      await DownloadSemaphore.acquire();

      try {
        const result = await executeDownload(downloadItem, entryKey);
        return result;
      } finally {
        DownloadSemaphore.release();
      }
    } finally {
      if (downloadProcesses.has(entryKey)) {
        downloadProcesses.delete(entryKey);
      }
      if (downloadProcesses.size === 0) {
        queueSequence = 0;
      }
    }
  }

  async function executeDownload(
    downloadItem: DownloadItem & { queuePosition: number },
    processKey: string,
  ): Promise<DownloadResult> {
    const {
      url: videoUrl,
      title: videoTitle,
      saveDirectory,
      videoId,
    } = downloadItem;

    try {
      const saveDirectoryTrimmed = saveDirectory.trim();
      const savePath = join(config.saveLocation, saveDirectoryTrimmed);

      logger.debug(`Downloading to path: ${savePath}`);

      if (savePath !== config.saveLocation && !(await exists(savePath))) {
        await mkdir(savePath, { recursive: true });
      }

      return new Promise<DownloadResult>((resolve, reject) => {
        let progressPercent: number | null = null;
        let capturedTitle: string | null = null;
        let capturedFileName: string | null = null;
        safeEmit("download-started", {
          url: videoUrl,
          percentage: 101,
        });

        const { process: downloadProcess } = launchYtDlp({
          url: videoUrl,
          options: downloadOptions,
          flags: ["-P", "home:" + savePath],
          reason: `Starting download for ${videoUrl}`,
          context: { title: videoTitle, savePath },
        });

        // Fatal if the entry is gone: the subprocess is running and nothing
        // would ever reap it.
        if (
          !setProcessStatus(processKey, "running", {
            spawnedProcess: downloadProcess,
          })
        ) {
          return reject(new Error(`Process entry not found: ${processKey}`));
        }

        void (async () => {
          try {
            for await (const data of streamTextChunks(downloadProcess.stdout)) {
              try {
                const output = data.toString().trim();
                const percentMatch = /(\d{1,3}\.\d)/.exec(output);
                if (percentMatch) {
                  const percent = parseFloat(percentMatch[0]);
                  const progressBlock = Math.floor(percent / 10);

                  if (progressBlock === 0 && progressPercent === null) {
                    progressPercent = 0;
                    logger.debug(output, { pid: downloadProcess.pid });
                  } else if (
                    progressPercent !== null && progressBlock > progressPercent
                  ) {
                    progressPercent = progressBlock;
                    logger.debug(output, { pid: downloadProcess.pid });
                  }

                  safeEmit("downloading-percent-update", {
                    url: videoUrl,
                    percentage: percent,
                  });
                }

                const itemTitle = /title:(.+)/m.exec(output);
                if (itemTitle?.[1] && !capturedFileName) {
                  capturedTitle = itemTitle[1].trim();
                  logger.debug(`Video Title from process ${capturedTitle}`, {
                    pid: downloadProcess.pid,
                  });
                }

                const fileNameInDest = /fileName:(.+)"/m.exec(output);
                if (fileNameInDest?.[1]) {
                  const finalFileName = fileNameInDest[1].trim();
                  capturedFileName = basename(finalFileName);
                  logger.debug(
                    `Filename in destination: ${finalFileName}, basename: ${capturedFileName}, DB title: ${videoTitle}`,
                    { pid: downloadProcess.pid },
                  );
                }

                updateProcessActivity(processKey, true);
              } catch (error) {
                if (!(error instanceof TypeError)) {
                  safeEmit("error", { message: (error as Error).message });
                }
              }
            }
          } catch (error) {
            logger.error(
              `Download stdout processing error: ${(error as Error).message}`,
              {
                pid: downloadProcess.pid,
              },
            );
            updateProcessActivity(processKey);
            reject(error);
          }
        })();

        void (async () => {
          for await (const error of streamTextChunks(downloadProcess.stderr)) {
            logger.error(`Download error: ${error}`, {
              pid: downloadProcess.pid,
            });
            updateProcessActivity(processKey);
          }
        })();

        void (async () => {
          const { code } = await downloadProcess.status;
          try {
            const videoEntry = await VideoMetadata.findOne({
              where: { videoUrl: videoUrl },
            });

            if (code === ProcessExitCodes.SUCCESS) {
              const unhelpfulTitle = videoTitle === videoId ||
                videoTitle === "NA";
              const fallbackTitle = capturedTitle || videoTitle;
              const updates: DownloadCompletionUpdates = {
                downloadStatus: true,
                isAvailable: true,
                title: unhelpfulTitle ? fallbackTitle : videoTitle,
                fileName: null,
                descriptionFile: null,
                commentsFile: null,
                subTitleFile: null,
                thumbNailFile: null,
                isMetaDataSynced: true,
                saveDirectory: computeSaveDirectory(savePath),
              };

              const videoEntryForDiscovery = videoEntry
                ? {
                  downloadStatus: Boolean(
                    videoEntry.getDataValue("downloadStatus"),
                  ),
                  fileName: videoEntry.getDataValue("fileName") as
                    | string
                    | null,
                }
                : null;
              const { metadata, syncStatus } = await discoverFiles(
                capturedFileName,
                savePath,
                videoEntryForDiscovery,
              );

              Object.assign(updates, metadata);

              const allExtraFilesFound = syncStatus.videoFileFound &&
                syncStatus.descriptionFileFound &&
                syncStatus.commentsFileFound &&
                syncStatus.subTitleFileFound &&
                syncStatus.thumbNailFileFound;

              if (allExtraFilesFound) {
                logger.info("All extra files found", {
                  updates: JSON.stringify(updates),
                });
              } else {
                logger.info("Some of the expected files are not found", {
                  updates: JSON.stringify(updates),
                });
              }

              if (videoEntry) {
                logger.debug(`Updating video: ${JSON.stringify(updates)}`, {
                  pid: downloadProcess.pid,
                });
                await videoEntry.update(updates);
              }

              try {
                safeEmit("download-done", {
                  url: videoUrl,
                  title: updates.title,
                  fileName: updates.fileName,
                  saveDirectory: computeSaveDirectory(savePath),
                  isMetaDataSynced: updates.isMetaDataSynced,
                  thumbNailFile: updates.thumbNailFile,
                  subTitleFile: updates.subTitleFile,
                  descriptionFile: updates.descriptionFile,
                });
              } catch (e) {
                logger.error("Error computing save directory, using fallback", {
                  error: (e as Error).message,
                });
                safeEmit("download-done", {
                  url: videoUrl,
                  title: updates.title,
                  fileName: updates.fileName,
                  saveDirectory: "",
                });
              }

              cleanupProcess(processKey, downloadProcess.pid);

              resolve({
                url: videoUrl,
                title: updates.title,
                status: "success",
              });
            } else {
              const errorMsg = code === ProcessExitCodes.SIGTERM
                ? "Process was killed (likely by user or timeout)"
                : `Process exited with code ${code}`;

              // `error` is additive: existing socket consumers ignore it, while
              // in-process consumers get the reason without having to await the
              // resolved ListingResult.
              safeEmit("download-failed", {
                title: videoEntry
                  ? videoEntry.getDataValue("title") as string
                  : videoTitle,
                url: videoUrl,
                error: errorMsg,
              });

              resolve({
                url: videoUrl,
                title: videoTitle,
                status: "failed",
                error: errorMsg,
              });
            }
          } catch (error) {
            logger.error(
              `Error handling download completion: ${(error as Error).message}`,
              { pid: downloadProcess.pid },
            );
            reject(error);
          }
        })().catch((error) => {
          logger.error(`Download process error: ${(error as Error).message}`, {
            pid: downloadProcess.pid,
          });
          updateProcessActivity(processKey);
          reject(error);
        });
      });
    } catch (error) {
      logger.error(`Download error: ${(error as Error).message}`);
      return Promise.resolve({
        url: videoUrl,
        title: videoTitle,
        status: "failed",
        error: (error as Error).message,
      });
    }
  }

  async function discoverFiles(
    mainFileName: string | null,
    savePath: string,
    videoEntry: Pick<VideoEntryRecord, "downloadStatus" | "fileName"> | null,
  ): Promise<{ metadata: DiscoveredMetadata; syncStatus: FileSyncStatus }> {
    const metadata: DiscoveredMetadata = {
      fileName: null,
      descriptionFile: null,
      commentsFile: null,
      subTitleFile: null,
      thumbNailFile: null,
    };

    const syncStatus: FileSyncStatus = {
      videoFileFound: false,
      descriptionFileFound: !config.saveDescription,
      commentsFileFound: !config.saveComments,
      subTitleFileFound: !config.saveSubs,
      thumbNailFileFound: !config.saveThumbnail,
    };

    if (!mainFileName) {
      logger.debug("No main file name provided for metadata discovery");
      if (videoEntry && videoEntry.downloadStatus) {
        mainFileName = videoEntry.fileName ?? null;
        logger.debug("Using main file name from database", { mainFileName });
      }
    }

    if (!mainFileName) {
      logger.debug("No main file name found in database");
      return { metadata, syncStatus };
    }

    try {
      const base = basename(mainFileName);
      const mainFileExt = extname(mainFileName);
      const mainFileBase = base.endsWith(mainFileExt)
        ? base.slice(0, -mainFileExt.length)
        : base;

      logger.debug("Scanning savePath for extra metadata files", {
        savePath,
        mainFileBase,
      });

      const patterns = {
        video: [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".m4v"],
        description: [".description"],
        comments: [".info.json"],
        subtitle: [".vtt", ".srt"],
        thumbnail: [".webp", ".jpg", ".jpeg", ".png"],
      };

      const checkFile = async (baseName: string, extensions: string[]) => {
        for (const ext of extensions) {
          const filePath = join(savePath, baseName + ext);
          if (await exists(filePath)) {
            return baseName + ext;
          }
        }
        return null;
      };

      if (config.saveDescription) {
        const found = await checkFile(mainFileBase, patterns.description);
        if (found) {
          metadata.descriptionFile = found;
          syncStatus.descriptionFileFound = true;
          logger.trace("Found description file", { file: found });
        }
      }

      if (config.saveComments) {
        const found = await checkFile(mainFileBase, patterns.comments);
        if (found) {
          metadata.commentsFile = found;
          syncStatus.commentsFileFound = true;
          logger.trace("Found comments file", { file: found });
        }
      }

      if (config.saveSubs) {
        const commonLanguages = [
          "en",
          "fr",
          "de",
          "es",
          "it",
          "pt",
          "ru",
          "ja",
          "zh",
          "ko",
        ];
        const subtitlePatterns = [
          ...patterns.subtitle,
          ...commonLanguages.flatMap((lang) =>
            patterns.subtitle.map((ext) => `.${lang}${ext}`)
          ),
        ];

        const found = await checkFile(mainFileBase, subtitlePatterns);
        if (found) {
          metadata.subTitleFile = found;
          syncStatus.subTitleFileFound = true;
          logger.trace("Found subtitles file", { file: found });
        }
      }

      if (config.saveThumbnail) {
        const found = await checkFile(mainFileBase, patterns.thumbnail);
        if (found) {
          metadata.thumbNailFile = found;
          syncStatus.thumbNailFileFound = true;
          logger.trace("Found thumbnail file", { file: found });
        }
      }

      if (mainFileExt && patterns.video.includes(mainFileExt)) {
        patterns.video = [
          mainFileExt,
          ...patterns.video.filter((ext) => ext !== mainFileExt),
        ];
      }

      const videoFile = await checkFile(mainFileBase, patterns.video);
      if (videoFile) {
        metadata.fileName = videoFile;
        syncStatus.videoFileFound = true;
        logger.trace("Found video file", { file: videoFile });
      } else {
        logger.trace(
          "Video file not found with common extensions, scanning directory",
        );
        const files = await readdir(savePath);
        const filesOfInterest = files.filter((file) =>
          file.startsWith(mainFileBase)
        );
        const knownMetadataExts = [
          ...patterns.description,
          ...patterns.comments,
          ...patterns.subtitle,
          ...patterns.thumbnail,
        ];

        for (const file of filesOfInterest) {
          if (!knownMetadataExts.some((metaExt) => file.endsWith(metaExt))) {
            metadata.fileName = file;
            syncStatus.videoFileFound = true;
            logger.trace("Found video file", { file });
            break;
          }
        }
      }

      return { metadata, syncStatus };
    } catch (error) {
      logger.debug("Could not read savePath for extra metadata files", {
        savePath,
        error: (error as Error).message,
      });
      return {
        metadata,
        syncStatus: {
          videoFileFound: false,
          descriptionFileFound: false,
          commentsFileFound: false,
          subTitleFileFound: false,
          thumbNailFileFound: false,
        },
      };
    }
  }

  function computeSaveDirectory(savePath: string) {
    try {
      let saveDir = relative(
        resolve(config.saveLocation),
        resolve(savePath),
      );

      if (saveDir === sep || saveDir === ".") {
        saveDir = "";
      }
      if (saveDir.startsWith(sep)) {
        saveDir = saveDir.slice(1);
      }
      if (saveDir.endsWith(sep)) {
        saveDir = saveDir.slice(0, -1);
      }

      return saveDir;
    } catch (error) {
      logger.error("Error computing save directory", {
        savePath,
        saveLocation: config.saveLocation,
        error: (error as Error).message,
      });
      return "";
    }
  }

  function getQueueSnapshot() {
    const sortedEntries = Array.from(downloadProcesses.values())
      .sort((a, b) => a.queuePosition - b.queuePosition);

    return sortedEntries.map((entry, index) => ({
      url: entry.url,
      title: entry.title,
      status: entry.status,
      queuePosition: index + 1,
    }));
  }

  return { processDownloadRequest, resolveAndEnqueue, getQueueSnapshot };
}
