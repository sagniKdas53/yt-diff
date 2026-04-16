import he from "he";
import { Op } from "sequelize";
import { config } from "../../config.ts";
import { VideoMetadata, PlaylistMetadata, PlaylistVideoMapping } from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { existsSync, mkdirSync, readdirSync } from "../../utils/fs.ts";
import { basename, extname, join, relative, resolve, sep } from "../../utils/path.ts";
import { Semaphore } from "./semaphore.ts";
import type { 
  DownloadRequestBody, DownloadItem, DownloadResult, DownloadProcessEntry, 
  DownloadCompletionUpdates, DiscoveredMetadata, FileSyncStatus, HttpError,
  PipelineHandlerDependencies, VideoEntryRecord
} from "./types.ts";
import { downloadOptions, ProcessExitCodes } from "./types.ts";
import { generateCorsHeaders, MIME_TYPES } from "../../utils/http.ts";

export function createDownloadFlow(
  deps: PipelineHandlerDependencies,
  downloadProcesses: Map<string, DownloadProcessEntry>,
  processManager: {
    updateProcessActivity: (processKey: string, isStdout?: boolean) => void;
    cleanupProcess: (processKey: string, pid: number | undefined) => void;
  }
) {
  const { safeEmit, buildSiteArgs, spawnPythonProcess, streamTextChunks } = deps;
  const jsonMimeType = MIME_TYPES[".json"];
  const DownloadSemaphore = new Semaphore(config.queue.maxDownloads, "DownloadSemaphore");
  const { updateProcessActivity, cleanupProcess } = processManager;

  async function processDownloadRequest(
    requestBody: DownloadRequestBody,
    response: HttpResponseLike,
  ) {
    try {
      const videosToDownload: DownloadItem[] = [];
      const uniqueUrls = new Set();
      const playlistUrl = requestBody.playListUrl ?? "None";

      for (const videoUrl of requestBody.urlList) {
        if (uniqueUrls.has(videoUrl)) {
          continue;
        }

        logger.debug("Checking video in database", { url: videoUrl });

        const videoEntry = await VideoMetadata.findOne({
          where: { videoUrl: videoUrl },
        });

        if (!videoEntry) {
          logger.error("Video not found in database", { url: videoUrl });
          response.writeHead(404, generateCorsHeaders(jsonMimeType));
          return response.end(JSON.stringify({
            error: `Video with URL ${videoUrl} is not indexed`,
          }));
        }

        let saveDirectory =
          (videoEntry as unknown as { saveDirectory: string })?.saveDirectory ?? "";

        if (playlistUrl !== "init" && playlistUrl !== "None") {
          try {
            const playlist = await PlaylistMetadata.findOne({
              where: { playlistUrl: playlistUrl },
            });
            if (playlist) {
              saveDirectory = (playlist as unknown as { saveDirectory: string })
                ?.saveDirectory ??
                saveDirectory;
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
                where: { playlistUrl: (mapping as any).playlistUrl },
              });
              if (playlist) {
                saveDirectory = (playlist as unknown as { saveDirectory: string })
                  ?.saveDirectory ??
                  saveDirectory;
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
          title: (videoEntry as unknown as { title: string }).title,
          saveDirectory: saveDirectory,
          videoId: (videoEntry as unknown as { videoId: string }).videoId,
        });
        uniqueUrls.add(videoUrl);
      }

      void downloadItemsConcurrently(videosToDownload, config.queue.maxDownloads);
      logger.debug("Download processes started", {
        itemCount: videosToDownload.length,
      });

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "success",
        message: "Downloads initiated",
        items: videosToDownload,
      }));
    } catch (error) {
      logger.error("Download processing failed", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      response.writeHead(statusCode, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: he.escape((error as Error).message),
      }));
    }
  }

  async function downloadItemsConcurrently(
    items: DownloadItem[],
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
    downloadItem: DownloadItem,
  ): Promise<DownloadResult> {
    logger.trace(
      `Starting download with semaphore: ${JSON.stringify(downloadItem)}`,
    );

    await DownloadSemaphore.acquire();

    try {
      const { url: videoUrl, title: videoTitle } = downloadItem;
      const now = Date.now();
      const downloadEntry: DownloadProcessEntry = {
        url: videoUrl,
        title: videoTitle,
        spawnType: "download",
        lastActivity: now,
        lastStdoutActivity: now,
        spawnTimeStamp: now,
        status: "pending",
      };

      const entryKey = `pending_${videoUrl}_${Date.now()}`;
      downloadProcesses.set(entryKey, downloadEntry);

      const result = await executeDownload(downloadItem, entryKey);

      if (downloadProcesses.has(entryKey)) {
        downloadProcesses.delete(entryKey);
      }

      return result;
    } finally {
      DownloadSemaphore.release();
    }
  }

  function executeDownload(
    downloadItem: DownloadItem,
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

      if (savePath !== config.saveLocation && !existsSync(savePath)) {
        mkdirSync(savePath, { recursive: true });
      }

      return new Promise<DownloadResult>((resolve, reject) => {
        let progressPercent: number | null = null;
        let capturedTitle: string | null = null;
        let capturedFileName: string | null = null;
        const processArgs = ["-P", "home:" + savePath, videoUrl];

        safeEmit("download-started", { url: videoUrl, percentage: 101 });

        const siteArgs = buildSiteArgs(videoUrl, config);
        if (siteArgs.length > 0) {
          processArgs.unshift(...siteArgs);
        }

        logger.debug(`Starting download for ${videoUrl}`, {
          url: videoTitle,
          savePath,
          fullCommand: `yt-dlp ${downloadOptions.join(" ")} ${
            processArgs.join(" ")
          }`,
        });

        const downloadProcess = spawnPythonProcess(
          downloadOptions.concat(processArgs),
        );

        const processEntry = downloadProcesses.get(processKey);
        if (processEntry) {
          const now = Date.now();
          processEntry.spawnedProcess = downloadProcess;
          processEntry.status = "running";
          processEntry.lastActivity = now;
          processEntry.lastStdoutActivity = now;
          processEntry.spawnTimeStamp = now;
          downloadProcesses.set(processKey, processEntry);
        } else {
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
            logger.error(`Download stdout processing error: ${(error as Error).message}`, {
              pid: downloadProcess.pid,
            });
            updateProcessActivity(processKey);
            reject(error);
          }
        })();

        void (async () => {
          for await (const error of streamTextChunks(downloadProcess.stderr)) {
            logger.error(`Download error: ${error}`, { pid: downloadProcess.pid });
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
              const unhelpfulTitle = videoTitle === videoId || videoTitle === "NA";
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
                  downloadStatus: Boolean(videoEntry.getDataValue("downloadStatus")),
                  fileName: videoEntry.getDataValue("fileName") as string | null,
                }
                : null;
              const { metadata, syncStatus } = discoverFiles(
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

              safeEmit("download-failed", {
                title: videoEntry
                  ? videoEntry.getDataValue("title") as string
                  : videoTitle,
                url: videoUrl,
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

  function discoverFiles(
    mainFileName: string | null,
    savePath: string,
    videoEntry: Pick<VideoEntryRecord, "downloadStatus" | "fileName"> | null,
  ): { metadata: DiscoveredMetadata; syncStatus: FileSyncStatus } {
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
      } else {
        logger.debug("No main file name found in database");
        return { metadata, syncStatus };
      }
    }

    try {
      const mainFileExt = extname(mainFileName!).toLowerCase();
      const mainFileBase = mainFileName!.replace(mainFileExt, "");
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

      const checkFile = (baseName: string, extensions: string[]) => {
        for (const ext of extensions) {
          const filePath = join(savePath, baseName + ext);
          if (existsSync(filePath)) {
            return baseName + ext;
          }
        }
        return null;
      };

      if (config.saveDescription) {
        const found = checkFile(mainFileBase, patterns.description);
        if (found) {
          metadata.descriptionFile = found;
          syncStatus.descriptionFileFound = true;
          logger.trace("Found description file", { file: found });
        }
      }

      if (config.saveComments) {
        const found = checkFile(mainFileBase, patterns.comments);
        if (found) {
          metadata.commentsFile = found;
          syncStatus.commentsFileFound = true;
          logger.trace("Found comments file", { file: found });
        }
      }

      if (config.saveSubs) {
        const commonLanguages = ["en", "fr", "de", "es", "it", "pt", "ru", "ja", "zh", "ko"];
        const subtitlePatterns = [
          ...patterns.subtitle,
          ...commonLanguages.flatMap((lang) =>
            patterns.subtitle.map((ext) => `.${lang}${ext}`)
          ),
        ];

        const found = checkFile(mainFileBase, subtitlePatterns);
        if (found) {
          metadata.subTitleFile = found;
          syncStatus.subTitleFileFound = true;
          logger.trace("Found subtitles file", { file: found });
        }
      }

      if (config.saveThumbnail) {
        const found = checkFile(mainFileBase, patterns.thumbnail);
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

      const videoFile = checkFile(mainFileBase, patterns.video);
      if (videoFile) {
        metadata.fileName = videoFile;
        syncStatus.videoFileFound = true;
        logger.trace("Found video file", { file: videoFile });
      } else {
        logger.trace(
          "Video file not found with common extensions, scanning directory",
        );
        const files = readdirSync(savePath);
        const filesOfInterest = files.filter((file) => file.startsWith(mainFileBase));
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

  return { processDownloadRequest };
}
