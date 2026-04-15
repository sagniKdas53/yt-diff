import he from "he";
import { Model, Op } from "sequelize";

import { config } from "../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../db/models.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { existsSync, mkdirSync, readdirSync } from "../utils/fs.ts";
import { basename, extname, join, relative, resolve, sep } from "../utils/path.ts";
import {
  extractPlaylistId,
  fetchPlaylistItemsChunked,
  isChannelUrl,
  isYouTubeApiConfigured,
  isYouTubeUrl,
  resolveChannelUploadsPlaylistId,
} from "./youtube-api.ts";

const playlistRegex = /(?:playlist|list=|videos$)\b/i;

export const downloadOptions = [
  "--progress",
  "--embed-metadata",
  "--embed-chapters",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveDescription ? "--write-description" : "",
  config.saveComments ? "--write-comments" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  config.restrictFilenames ? "--restrict-filenames" : "",
  "-P",
  "temp:/tmp",
  "-o",
  config.restrictFilenames ? "%(id)s.%(ext)s" : "%(title)s[%(id)s].%(ext)s",
  "--print",
  "before_dl:title:%(title)s [%(id)s]",
  "--print",
  config.restrictFilenames
    ? 'post_process:"fileName:%(id)s.%(ext)s"'
    : 'post_process:"fileName:%(title)s[%(id)s].%(ext)s"',
  "--progress-template",
  "download-title:%(info.id)s-%(progress.eta)s",
].filter(Boolean) as string[];

if (!isNaN(config.maxFileNameLength) && config.maxFileNameLength > 0) {
  downloadOptions.push("--trim-filenames");
  downloadOptions.push(`${config.maxFileNameLength}`);
}

export interface ManagedProcess {
  pid: number;
  readonly killed: boolean;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): boolean;
}

export interface ProcessLike {
  status: string;
  spawnType: string;
  lastActivity: number;
  lastStdoutActivity: number;
  spawnTimeStamp: number;
  spawnedProcess?: { kill: (signal: string) => boolean } | ManagedProcess | null;
}

export interface ListingRequestBody {
  urlList?: string[];
  chunkSize?: number | string;
  sleep?: boolean;
  monitoringType?: string;
}

export interface DownloadRequestBody {
  urlList: string[];
  playListUrl?: string;
}

interface ListingItem {
  url: string;
  type: string;
  currentMonitoringType: string;
  previousMonitoringType?: string;
  reason: string;
  isScheduledUpdate?: boolean;
}

interface ListingResult {
  url: string;
  status: string;
  title?: string;
  playlistTitle?: string;
  type?: string;
  processedChunks?: number;
  seekPlaylistListTo?: number;
  error?: string;
}

interface DownloadItem {
  url: string;
  title: string;
  saveDirectory: string;
  videoId: string;
}

interface DownloadResult {
  url: string;
  title: string;
  status: string;
  error?: string;
}

interface VideoEntrySnapshot {
  videoId: string;
  approximateSize: number | string;
  title: string;
  isAvailable: boolean;
}

interface VideoEntryRecord extends VideoEntrySnapshot {
  downloadStatus?: boolean;
  fileName?: string | null;
}

interface StreamedItemData extends Record<string, unknown> {
  webpage_url?: string;
  url?: string;
  thumbnail?: string | null;
  title?: string;
  id?: string;
  filesize_approx?: number | string;
  formats?: unknown;
  requested_formats?: unknown;
  thumbnails?: unknown;
  subtitles?: unknown;
  automatic_captions?: unknown;
}

interface ParsedStreamItem {
  itemData: StreamedItemData;
  videoUrl: string;
  index: number;
  onlineThumbnail: string | null;
}

interface StreamingVideoProcessingResult {
  count: number;
  title: string;
  responseUrl: string;
  alreadyExistedCount: number;
}

interface VideoUpsertData extends VideoEntrySnapshot {
  videoUrl: string;
  downloadStatus: boolean;
  isAvailable: boolean;
  onlineThumbnail: string | null;
  raw_metadata: StreamedItemData;
}

interface PlaylistMappingCreate {
  videoUrl: string;
  playlistUrl: string;
  positionInPlaylist: number;
}

interface PlaylistMappingUpdate {
  instance: Model;
  position: number;
}

interface DiscoveredMetadata {
  fileName: string | null;
  descriptionFile: string | null;
  commentsFile: string | null;
  subTitleFile: string | null;
  thumbNailFile: string | null;
}

interface FileSyncStatus {
  videoFileFound: boolean;
  descriptionFileFound: boolean;
  commentsFileFound: boolean;
  subTitleFileFound: boolean;
  thumbNailFileFound: boolean;
}

interface DownloadCompletionUpdates extends DiscoveredMetadata {
  downloadStatus: boolean;
  isAvailable: boolean;
  title: string;
  isMetaDataSynced: boolean;
  saveDirectory: string;
}

interface DownloadProcessEntry extends ProcessLike {
  url: string;
  title: string;
}

interface ListingProcessEntry extends ProcessLike {
  url: string;
  type: string;
  monitoringType: string;
}

type GenerateCorsHeaders = (contentType: string) => Record<string, string | number>;
type SafeEmit = (event: string, payload: unknown) => void;
type SiteArgBuilder = (url: string, config: unknown) => string[];
type StreamTextChunks = (
  stream: ReadableStream<Uint8Array>,
) => AsyncGenerator<string>;
type StreamLines = (stream: ReadableStream<Uint8Array>) => AsyncGenerator<string>;
type SpawnPythonProcess = (args: string[]) => ManagedProcess;
type HttpError = Error & { status?: number };

interface PipelineHandlerDependencies {
  generateCorsHeaders: GenerateCorsHeaders;
  jsonMimeType: string;
  safeEmit: SafeEmit;
  buildSiteArgs: SiteArgBuilder;
  spawnPythonProcess: SpawnPythonProcess;
  streamTextChunks: StreamTextChunks;
  streamLines: StreamLines;
}

export function createPipelineHandlers({
  generateCorsHeaders,
  jsonMimeType,
  safeEmit,
  buildSiteArgs,
  spawnPythonProcess,
  streamTextChunks,
  streamLines,
}: PipelineHandlerDependencies) {
  const downloadProcesses = new Map<string, DownloadProcessEntry>();
  const listProcesses = new Map<string, ListingProcessEntry>();

  let pendingPlaylistSortCounter: number | null = null;
  let pendingPlaylistSortCounterPromise: Promise<number> | null = null;

  const DownloadSemaphore = {
    maxConcurrent: 2,
    currentConcurrent: 0,
    queue: [] as Array<(value?: unknown) => void>,

    acquire() {
      return new Promise((resolve) => {
        if (this.currentConcurrent < this.maxConcurrent) {
          this.currentConcurrent++;
          logger.debug(
            `Semaphore acquired, current concurrent: ${this.currentConcurrent}`,
          );
          resolve(undefined);
        } else {
          logger.debug("Semaphore full, queuing request");
          this.queue.push(resolve);
          logger.debug(`Queue length: ${this.queue.length}`);
        }
      });
    },

    release() {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        logger.debug(
          `Semaphore released, current concurrent: ${this.currentConcurrent}`,
        );
        if (next) next();
      } else {
        logger.debug("Semaphore released");
        this.currentConcurrent--;
      }
    },

    setMaxConcurrent(max: number) {
      this.maxConcurrent = max;
      while (
        this.currentConcurrent < this.maxConcurrent && this.queue.length > 0
      ) {
        const next = this.queue.shift();
        this.currentConcurrent++;
        if (next) next();
      }
    },
  };

  const ListingSemaphore = {
    maxConcurrent: config.queue.maxListings,
    currentConcurrent: 0,
    queue: [] as Array<(value?: unknown) => void>,

    acquire() {
      return new Promise((resolve) => {
        if (this.currentConcurrent < this.maxConcurrent) {
          this.currentConcurrent++;
          logger.debug(
            `Listing semaphore acquired, current concurrent: ${this.currentConcurrent}`,
          );
          resolve(undefined);
        } else {
          logger.debug("Listing semaphore full, queuing request");
          this.queue.push(resolve);
        }
      });
    },

    release() {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        logger.debug(
          `Listing semaphore released, current concurrent: ${this.currentConcurrent}`,
        );
        if (next) next();
      } else {
        logger.debug("Listing semaphore released");
        this.currentConcurrent--;
      }
    },

    setMaxConcurrent(max: number) {
      this.maxConcurrent = max;
      while (
        this.currentConcurrent < this.maxConcurrent && this.queue.length > 0
      ) {
        const next = this.queue.shift();
        this.currentConcurrent++;
        if (next) next();
      }
    },
  };

  function normalizeUrl(url: string) {
    let hostname = "";
    try {
      hostname = (new URL(url)).hostname;
    } catch (e) {
      logger.warn(`Invalid videoUrl: ${url}`, { error: (e as Error).message });
    }
    const youtubeHostNames = [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "www.youtu.be",
      "m.youtube.com",
      "www.m.youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ];
    if (youtubeHostNames.includes(hostname)) {
      if (!/\/videos\/?$/.test(url) && url.includes("/@")) {
        url = url.replace(/\/$/, "") + "/videos";
      }
      logger.debug(`Normalized YouTube URL: ${url}`);
    }
    return url;
  }

  function urlToTitle(url: string) {
    try {
      const pathSegments = new URL(url).pathname.split("/");
      const unwantedSegments = new Set(["videos", "channel", "user", "playlist"]);
      const titleSegments = pathSegments.filter((segment) =>
        segment && !unwantedSegments.has(segment.toLowerCase())
      );
      return titleSegments.join("_") || url;
    } catch (error) {
      logger.error("Failed to generate title from URL", {
        url,
        error: (error as Error).message,
      });
      return url;
    }
  }

  function truncateText(text: string, maxLength: number) {
    if (!text || typeof text !== "string") {
      logger.warn("Invalid text provided for truncation", {
        text,
        type: typeof text,
      });
      return "";
    }
    if (text.length <= maxLength) {
      return text;
    }
    const truncated = text.slice(0, maxLength);
    logger.debug(
      `Truncated text from ${text.length} to ${truncated.length} characters`,
    );
    return truncated;
  }

  function isSiteXDotCom(videoUrl: string): boolean {
    let hostname = "";
    try {
      hostname = (new URL(videoUrl)).hostname;
    } catch (e) {
      logger.warn(`Invalid videoUrl: ${videoUrl}`, {
        error: (e as Error).message,
      });
    }
    const allowedXHost = "x.com";
    return hostname === allowedXHost || hostname.endsWith("." + allowedXHost);
  }

  function hasEphemeralThumbnails(videoUrl: string): boolean {
    let hostname = "";
    try {
      hostname = (new URL(videoUrl)).hostname;
    } catch {
      return false;
    }
    const ephemeralHosts = ["facebook.com", "instagram.com", "pornhub.com"];
    return ephemeralHosts.some((h) => hostname === h || hostname.endsWith("." + h));
  }

  function getProcessStates(processMap: Map<string, ProcessLike>) {
    const states: Record<string, { status: string; type: string; lastActive: number }> = {};
    for (const [processId, process] of processMap.entries()) {
      states[processId] = {
        status: process.status,
        type: process.spawnType,
        lastActive: process.lastActivity,
      };
    }
    return JSON.stringify(states);
  }

  function cleanupStaleProcesses(
    processMap: Map<string, ProcessLike>,
    {
      maxIdleTime = config.queue.maxIdle,
      maxLifetime = config.queue.maxLifetime,
      forceKill = false,
    } = {},
    processType: string,
  ) {
    const now = Date.now();
    let cleanedCount = 0;

    logger.info(
      `Cleaning up processes older than ${
        maxIdleTime / 1000
      } seconds in ${processType} processes`,
    );
    logger.trace("Current process states:", {
      states: getProcessStates(processMap),
    });

    for (const [processId, process] of processMap.entries()) {
      const {
        status,
        lastActivity,
        lastStdoutActivity,
        spawnTimeStamp,
        spawnedProcess,
      } = process;

      const age = now - spawnTimeStamp;
      const idleTime = now - lastActivity;
      const stdoutIdleTime = lastStdoutActivity ? now - lastStdoutActivity : age;
      const isErrorOnly = lastStdoutActivity &&
        (lastActivity > lastStdoutActivity) && (stdoutIdleTime > maxIdleTime);

      if (status === "completed" || status === "failed") {
        processMap.delete(processId);
        cleanedCount++;
        continue;
      }

      if (
        status === "running" &&
        (idleTime > maxIdleTime || age > maxLifetime || isErrorOnly)
      ) {
        // For list processes actively producing stdout data, skip the maxLifetime kill.
        // A process receiving real data within the idle window is not stale — just slow.
        const isActivelyProducingData = lastStdoutActivity &&
          (now - lastStdoutActivity < maxIdleTime);
        if (
          processType === "list" && isActivelyProducingData &&
          !(idleTime > maxIdleTime) && !isErrorOnly
        ) {
          logger.info(
            `Skipping cleanup for active list process ${processId} (age: ${Math.round(age / 1000)}s, last stdout: ${Math.round((now - lastStdoutActivity) / 1000)}s ago)`,
          );
          continue;
        }

        if (spawnedProcess?.kill && forceKill) {
          try {
            const killed = spawnedProcess.kill("SIGKILL");
            if (!killed) {
              const terminated = spawnedProcess.kill("SIGTERM");
              if (!terminated) {
                throw new Error("Failed to terminate process");
              }
            }
          } catch (error) {
            logger.error(`Failed to kill process ${processId}`, {
              error: (error as Error).message,
            });
          }
        }

        processMap.delete(processId);
        cleanedCount++;
      }
    }

    logger.info(`Cleaned up ${cleanedCount} processes`);
    logger.trace("Updated process states:", {
      states: getProcessStates(processMap),
    });

    return cleanedCount;
  }

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

            if (code === 0) {
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
              const errorMsg = code === 143
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

  function updateProcessActivity(processKey: string, isStdout = false) {
    const downloadEntry = downloadProcesses.get(processKey);
    if (downloadEntry) {
      const now = Date.now();
      downloadEntry.lastActivity = now;
      if (isStdout) {
        downloadEntry.lastStdoutActivity = now;
      }
    }

    const listEntry = listProcesses.get(processKey);
    if (listEntry) {
      const now = Date.now();
      listEntry.lastActivity = now;
      if (isStdout) {
        listEntry.lastStdoutActivity = now;
      }
    }
  }

  function cleanupProcess(processKey: string, pid: number | undefined) {
    if (downloadProcesses.has(processKey)) {
      downloadProcesses.delete(processKey);
      logger.trace(`Removed process from cache: ${pid}`, { pid });
      logger.trace(`Process map state: ${getProcessStates(downloadProcesses)}`);
      logger.trace(`Process map size: ${downloadProcesses.size}`);
    }
  }

  async function processListingRequest(
    requestBody: ListingRequestBody,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      if (!requestBody.urlList) {
        throw new Error("URL list is required");
      }

      const chunkSize = Math.max(
        config.chunkSize,
        +(requestBody.chunkSize ?? config.chunkSize),
      );
      const monitoringType = requestBody.monitoringType ?? "N/A";
      const itemsToList: ListingItem[] = [];
      const uniqueUrls = new Set();

      logger.trace("Processing URL list", {
        urlCount: requestBody.urlList.length,
        chunkSize,
        monitoringType,
      });

      for (const url of requestBody.urlList) {
        const normalizedUrl = normalizeUrl(url);
        if (uniqueUrls.has(normalizedUrl)) {
          continue;
        }

        logger.debug("Checking URL in database", { url: normalizedUrl });

        const playlistEntry = await PlaylistMetadata.findOne({
          where: { playlistUrl: normalizedUrl },
        });

        if (playlistEntry) {
          logger.debug("Playlist found in database", { url: normalizedUrl });
          if ((playlistEntry as any).monitoringType === monitoringType) {
            logger.debug("Playlist monitoring hasn't changed so skipping", {
              url: normalizedUrl,
            });
            safeEmit("listing-playlist-skipped-because-same-monitoring", {
              message: `Playlist ${
                (playlistEntry as any).title
              } is already being monitored with type ${monitoringType}, skipping.`,
            });
            continue;
          } else {
            logger.debug("Playlist monitoring has changed", {
              url: normalizedUrl,
            });
            itemsToList.push({
              url: normalizedUrl,
              type: "playlist",
              previousMonitoringType: (playlistEntry as any).monitoringType,
              currentMonitoringType: monitoringType,
              reason: "Monitoring type changed",
            });
          }
        }

        const videoEntry = await VideoMetadata.findOne({
          where: { videoUrl: normalizedUrl },
        });
        if (videoEntry) {
          logger.debug("Video found in database", { url: normalizedUrl });
          if ((videoEntry as any).downloadStatus) {
            logger.debug("Video already downloaded", { url: normalizedUrl });
            const existingMapping = await PlaylistVideoMapping.findOne({
              where: {
                videoUrl: normalizedUrl,
                playlistUrl: "None",
              },
            });

            if (existingMapping) {
              safeEmit("listing-single-item-complete", {
                url: normalizedUrl,
                type: "video",
                title: (videoEntry as any).title,
                status: "completed",
                processedChunks: 1,
                seekSubListTo: (existingMapping as any).positionInPlaylist,
                alreadyExisted: true,
              });
              continue;
            }

            safeEmit("listing-video-skipped-because-downloaded", {
              message: `Video ${
                (videoEntry as any).title
              } is already downloaded, skipping.`,
            });
            continue;
          } else {
            logger.debug("Video not downloaded yet, updating status", {
              url: normalizedUrl,
            });
            itemsToList.push({
              url: normalizedUrl,
              type: "undownloaded",
              currentMonitoringType: "N/A",
              reason: "Video not downloaded yet",
            });
          }
        }

        if (!playlistEntry && !videoEntry) {
          logger.debug("URL not found in database, adding to list", {
            url: normalizedUrl,
          });
          itemsToList.push({
            url: normalizedUrl,
            type: "undetermined",
            currentMonitoringType: monitoringType,
            reason: "URL not found in database",
          });
        }

        uniqueUrls.add(normalizedUrl);
      }

      void listItemsConcurrently(itemsToList, chunkSize, false);

      logger.debug("Listing processes started", {
        itemCount: itemsToList.length,
      });

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "success",
        message: "Listing initiated",
        items: itemsToList,
      }));
    } catch (error) {
      logger.error("Failed to process URL list", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: he.escape((error as Error).message),
      }));
    }
  }

  async function listItemsConcurrently(
    items: ListingItem[],
    chunkSize: number,
    isScheduledUpdate: boolean,
  ): Promise<ListingResult[]> {
    logger.trace(
      `Listing ${items.length} items concurrently (chunk size: ${chunkSize})`,
    );

    if (items.length === 0) {
      logger.trace("No items to list");
      return [];
    }

    ListingSemaphore.setMaxConcurrent(config.queue.maxListings);

    const listingResults = await Promise.all(
      items.map((item) => listWithSemaphore(item, chunkSize, isScheduledUpdate)),
    );

    try {
      listingResults.forEach((result) => {
        if (result.status === "completed") {
          logger.info(
            `Listed ${result.title || result.playlistTitle} successfully`,
          );
        } else {
          logger.error(`Failed to list ${result.title}: ${JSON.stringify(result)}`);
        }
      });
    } catch (error) {
      logger.error("Failed to log listing results", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
    }

    return listingResults;
  }

  async function listWithSemaphore(
    item: ListingItem,
    chunkSize: number,
    isScheduledUpdate: boolean,
  ): Promise<ListingResult> {
    logger.trace(`Starting listing with semaphore: ${JSON.stringify(item)}`);

    await ListingSemaphore.acquire();

    try {
      const { url: videoUrl, type: itemType, currentMonitoringType } = item;
      const now = Date.now();
      const listEntry: ListingProcessEntry = {
        url: videoUrl,
        type: itemType,
        monitoringType: currentMonitoringType,
        spawnType: "list",
        lastActivity: now,
        lastStdoutActivity: now,
        spawnTimeStamp: now,
        status: "pending",
      };

      const entryKey = `pending_${videoUrl}_${Date.now()}`;
      listProcesses.set(entryKey, listEntry);

      const result = await executeListing(
        item,
        entryKey,
        chunkSize,
        item.isScheduledUpdate === true || isScheduledUpdate,
      );

      listEntry.spawnedProcess = null;

      logger.trace("Listing completed", {
        result: JSON.stringify(result),
        listEntry: JSON.stringify(listEntry),
      });

      if (listProcesses.has(entryKey)) {
        listProcesses.delete(entryKey);
      }

      return result;
    } finally {
      ListingSemaphore.release();
    }
  }

  async function executeListing(
    item: ListingItem,
    processKey: string,
    chunkSize: number,
    isScheduledUpdate: boolean = false,
  ): Promise<ListingResult> {
    const resolvedIsScheduledUpdate = isScheduledUpdate ||
      item.isScheduledUpdate === true;
    logger.debug(`isScheduledUpdate: ${resolvedIsScheduledUpdate}`, {
      item: JSON.stringify(item),
      isScheduledUpdate,
    });
    const { url: videoUrl, currentMonitoringType } = item;
    let itemType = item.type;

    try {
      if (!resolvedIsScheduledUpdate) {
        safeEmit("listing-started", {
          url: videoUrl,
          type: itemType,
          status: "started",
        });
      }

      const isPlaylist = playlistRegex.test(videoUrl) || itemType === "playlist";
      itemType = isPlaylist && !isSiteXDotCom(videoUrl) ? "playlist" : "unlisted";

      let playlistTitle = "";
      let seekPlaylistListTo = 0;

      if (itemType === "playlist") {
        const existingPlaylist = await PlaylistMetadata.findOne({
          where: { playlistUrl: videoUrl },
        });
        if (existingPlaylist) {
          logger.debug("Playlist already exists in database", { url: videoUrl });
          if (
            existingPlaylist.getDataValue("monitoringType") ===
              currentMonitoringType && !resolvedIsScheduledUpdate
          ) {
            return handleEmptyResponse(videoUrl);
          } else if (
            existingPlaylist.getDataValue("monitoringType") !==
              currentMonitoringType
          ) {
            logger.debug("Playlist monitoring has changed", { url: videoUrl });
            await existingPlaylist.update({
              monitoringType: ["Refresh", "Full"].includes(currentMonitoringType)
                ? "N/A"
                : currentMonitoringType,
              lastUpdatedByScheduler: resolvedIsScheduledUpdate ||
                  ["Refresh", "Full"].includes(currentMonitoringType)
                ? Date.now()
                : existingPlaylist.getDataValue("lastUpdatedByScheduler"),
            });
            logger.debug("Playlist monitoring type updated", { url: videoUrl });
          } else if (resolvedIsScheduledUpdate) {
            await existingPlaylist.update({
              monitoringType: currentMonitoringType === "Full"
                ? "N/A"
                : existingPlaylist.getDataValue("monitoringType"),
              lastUpdatedByScheduler: Date.now(),
            });
          }
          playlistTitle = existingPlaylist.getDataValue("title");
          seekPlaylistListTo = (existingPlaylist as any).sortOrder;
        } else {
          logger.debug("Playlist not found in database, adding to database", {
            url: videoUrl,
          });
          const newPlaylist = await addPlaylist(
            videoUrl,
            ["Refresh", "Full"].includes(currentMonitoringType)
              ? "N/A"
              : currentMonitoringType,
          );
          playlistTitle = (newPlaylist as any).title;
          seekPlaylistListTo = (newPlaylist as any).sortOrder;
        }

        return await handlePlaylistStreaming({
          videoUrl,
          chunkSize,
          isScheduledUpdate: resolvedIsScheduledUpdate,
          playlistTitle,
          seekPlaylistListTo,
          processKey,
          monitoringType: currentMonitoringType,
        });
      }

      return await handleSingleVideoStreaming({
        videoUrl,
        itemType,
        isScheduledUpdate: resolvedIsScheduledUpdate,
        processKey,
      });
    } catch (error) {
      return handleListingError(error as Error, videoUrl, itemType);
    }
  }

  async function handlePlaylistStreaming(
    item: {
      videoUrl: string;
      chunkSize: number;
      isScheduledUpdate: boolean;
      playlistTitle: string;
      seekPlaylistListTo: number;
      processKey: string;
      monitoringType: string;
    },
  ): Promise<ListingResult> {
    const {
      videoUrl,
      chunkSize,
      isScheduledUpdate,
      playlistTitle,
      seekPlaylistListTo,
      processKey,
      monitoringType,
    } = item;

    let processedChunks = 0;

    logger.info("Starting streaming listing for playlist", { url: videoUrl });

    // If YouTube API is configured and this is a YouTube URL, always use the API
    if (isYouTubeApiConfigured() && isYouTubeUrl(videoUrl)) {
      // Try extracting playlist ID directly, or resolve channel URL to uploads playlist
      let playlistId = extractPlaylistId(videoUrl);
      if (!playlistId && isChannelUrl(videoUrl)) {
        playlistId = await resolveChannelUploadsPlaylistId(videoUrl);
      }
      if (playlistId) {
        try {
          logger.info(
            "Routing to YouTube API path",
            { url: videoUrl, playlistId },
          );
          return await handlePlaylistViaApi({
            ...item,
            playlistId,
          });
        } catch (apiError) {
          logger.warn(
            "YouTube API failed, falling back to yt-dlp",
            { url: videoUrl, error: (apiError as Error).message },
          );
        }
      }
    }

    if (monitoringType === "Full" || monitoringType === "Refresh") {
      const deletedCount = await PlaylistVideoMapping.destroy({
        where: { playlistUrl: videoUrl },
      });
      logger.info(
        `Cleared ${deletedCount} existing mapping(s) before ${monitoringType} re-index`,
        { url: videoUrl },
      );
    }

    let startIndex = 1;
    if (monitoringType === "End") {
      const lastVideo = await PlaylistVideoMapping.findOne({
        where: { playlistUrl: videoUrl },
        order: [["positionInPlaylist", "DESC"]],
        attributes: ["positionInPlaylist"],
      });

      const maxPosition = lastVideo
        ? lastVideo.getDataValue("positionInPlaylist")
        : 0;
      if (maxPosition > 0) {
        startIndex = Math.max(1, maxPosition - chunkSize + 1);
      }
    }

    let chunkItems: string[] = [];
    let absoluteIndexCount = startIndex - 1;
    let consecutiveDuplicateChunks = 0;
    let processSucceeded = false;
    let error: Error | undefined;
    let ytDlpProcess: ManagedProcess;

    try {
      const streamProcessor = streamPlayListItems(videoUrl, processKey, startIndex);
      ytDlpProcess = streamProcessor.process;

      for await (const line of streamProcessor.iterator) {
        absoluteIndexCount++;
        chunkItems.push(line);

        if (chunkItems.length >= chunkSize) {
          const result = await processStreamingVideoInformation(
            chunkItems,
            videoUrl,
            absoluteIndexCount - chunkSize + 1,
            isScheduledUpdate,
            monitoringType,
          );

          processedChunks++;
          chunkItems = [];
          updateProcessActivity(processKey, true);

          if (!isScheduledUpdate) {
            safeEmit("listing-playlist-chunk-complete", {
              url: videoUrl,
              type: "playlist-chunk",
              status: "chunk-completed",
              processedChunks,
              playlistTitle,
              seekPlaylistListTo,
            });
          }

          if (
            result.alreadyExistedCount === chunkSize && monitoringType === "Start"
          ) {
            consecutiveDuplicateChunks++;
            if (consecutiveDuplicateChunks >= 2) {
              ytDlpProcess.kill("SIGTERM");
              break;
            }
          } else {
            consecutiveDuplicateChunks = 0;
          }
        }
      }

      if (chunkItems.length > 0) {
        await processStreamingVideoInformation(
          chunkItems,
          videoUrl,
          absoluteIndexCount - chunkItems.length + 1,
          isScheduledUpdate,
          monitoringType,
        );
        processedChunks++;
        updateProcessActivity(processKey, true);
        if (!isScheduledUpdate) {
          safeEmit("listing-playlist-chunk-complete", {
            url: videoUrl,
            type: "playlist-chunk",
            status: "chunk-completed",
            processedChunks,
            playlistTitle,
            seekPlaylistListTo,
          });
        }
      } else if (processedChunks === 0) {
        if (monitoringType === "End" && startIndex > 1) {
          throw new Error(
            "End mode index returned empty due to likely deletions.",
          );
        } else {
          return handleEmptyResponse(videoUrl);
        }
      }
      processSucceeded = true;
    } catch (e) {
      error = e as Error;
    }

    if (
      !processSucceeded && error &&
      error.message !== "Process exited with code null" &&
      error.message !== "Process exited with code 143"
    ) {
      return handleListingError(error, videoUrl, "playlist");
    }

    return completePlaylistListing(
      videoUrl,
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
      isScheduledUpdate,
    );
  }

  async function handlePlaylistViaApi(
    item: {
      videoUrl: string;
      chunkSize: number;
      isScheduledUpdate: boolean;
      playlistTitle: string;
      seekPlaylistListTo: number;
      processKey: string;
      monitoringType: string;
      playlistId: string;
    },
  ): Promise<ListingResult> {
    const {
      videoUrl,
      chunkSize,
      isScheduledUpdate,
      playlistTitle,
      seekPlaylistListTo,
      processKey,
      monitoringType,
      playlistId,
    } = item;

    let processedChunks = 0;

    logger.info("Starting YouTube API listing for playlist", {
      url: videoUrl,
      playlistId,
    });

    // For Full/Refresh modes, clear existing mappings before re-indexing
    if (monitoringType === "Full" || monitoringType === "Refresh") {
      const deletedCount = await PlaylistVideoMapping.destroy({
        where: { playlistUrl: videoUrl },
      });
      logger.info(
        `Cleared ${deletedCount} existing mapping(s) before ${monitoringType} re-index (API path)`,
        { url: videoUrl },
      );
    }

    // Update process status to "running" for the cleanup job
    const processEntry = listProcesses.get(processKey);
    if (processEntry) {
      processEntry.status = "running";
      processEntry.lastActivity = Date.now();
      processEntry.lastStdoutActivity = Date.now();
      listProcesses.set(processKey, processEntry);
    }

    try {
      let hasItems = false;
      let consecutiveDuplicateChunks = 0;

      // Stream chunks progressively from the YouTube API
      for await (
        const { items: chunkItems, chunkStartIndex, totalExpected }
          of fetchPlaylistItemsChunked(playlistId, chunkSize)
      ) {
        hasItems = true;

        const result = await processStreamingVideoInformation(
          chunkItems,
          videoUrl,
          chunkStartIndex,
          isScheduledUpdate,
          monitoringType,
        );

        processedChunks++;
        updateProcessActivity(processKey, true);

        if (!isScheduledUpdate) {
          safeEmit("listing-playlist-chunk-complete", {
            url: videoUrl,
            type: "playlist-chunk",
            status: "chunk-completed",
            processedChunks,
            playlistTitle,
            seekPlaylistListTo,
          });
        }

        // Early termination for "Start" mode if all items already exist
        if (
          result.alreadyExistedCount === chunkItems.length &&
          monitoringType === "Start"
        ) {
          consecutiveDuplicateChunks++;
          if (consecutiveDuplicateChunks >= 2) {
            logger.info(
              "YouTube API path: 2 consecutive duplicate chunks, stopping early",
              { url: videoUrl, processedChunks },
            );
            break;
          }
        } else {
          consecutiveDuplicateChunks = 0;
        }

        // Log progress every 10 chunks
        if (processedChunks % 10 === 0) {
          logger.info("YouTube API processing progress", {
            url: videoUrl,
            processedChunks,
            totalExpected,
          });
        }
      }

      if (!hasItems) {
        return handleEmptyResponse(videoUrl);
      }

      // Mark process as completed
      if (processEntry) {
        processEntry.status = "completed";
        processEntry.lastActivity = Date.now();
        listProcesses.set(processKey, processEntry);
      }

      return completePlaylistListing(
        videoUrl,
        processedChunks,
        playlistTitle,
        seekPlaylistListTo,
        isScheduledUpdate,
      );
    } catch (error) {
      logger.error("YouTube API listing failed", {
        url: videoUrl,
        playlistId,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Mark process as failed
      if (processEntry) {
        processEntry.status = "failed";
        processEntry.lastActivity = Date.now();
        listProcesses.set(processKey, processEntry);
      }

      throw error; // Re-throw so the caller can fall back to yt-dlp
    }
  }

  async function handleSingleVideoStreaming(
    item: {
      videoUrl: string;
      itemType: string;
      isScheduledUpdate: boolean;
      processKey: string;
    },
  ): Promise<ListingResult> {
    const { videoUrl, itemType, isScheduledUpdate, processKey } = item;
    const playlistUrl = "None";

    if (itemType === "undownloaded") {
      return {
        url: videoUrl,
        title: "Video",
        status: "unchanged",
        processedChunks: 0,
      };
    }

    try {
      const streamProcessor = streamPlayListItems(videoUrl, processKey);
      const chunkItems: string[] = [];

      for await (const line of streamProcessor.iterator) {
        chunkItems.push(line);
      }

      if (chunkItems.length === 0) {
        return handleEmptyResponse(videoUrl);
      }

      const existingMapping = await PlaylistVideoMapping.findOne({
        where: {
          videoUrl: chunkItems.length === 1
            ? (JSON.parse(chunkItems[0]).webpage_url ||
              JSON.parse(chunkItems[0]).url || "")
            : "",
          playlistUrl,
        },
      });

      let newStartIndex: number;
      if (existingMapping) {
        newStartIndex = existingMapping.getDataValue("positionInPlaylist") as number;
      } else {
        const lastVideo = await PlaylistVideoMapping.findOne({
          where: { playlistUrl },
          order: [["positionInPlaylist", "DESC"]],
          attributes: ["positionInPlaylist"],
          limit: 1,
        });
        newStartIndex = lastVideo
          ? lastVideo.getDataValue("positionInPlaylist") + 1
          : 1;
      }

      const result = await processStreamingVideoInformation(
        chunkItems,
        playlistUrl,
        newStartIndex,
        isScheduledUpdate,
      );

      if (result.count === 1) {
        safeEmit("listing-single-item-complete", {
          url: videoUrl,
          type: itemType,
          title: result.title,
          status: "completed",
          processedChunks: 1,
          seekSubListTo: newStartIndex,
          alreadyExisted: result.alreadyExistedCount > 0,
        });
        return {
          url: videoUrl,
          title: result.title,
          status: "completed",
          processedChunks: 1,
        };
      }

      return {
        url: videoUrl,
        title: result.title,
        status: "completed",
        processedChunks: result.count,
      };
    } catch (error) {
      return handleListingError(error as Error, videoUrl, itemType);
    }
  }

  function streamPlayListItems(
    videoUrl: string,
    processKey: string,
    startIndex: number = 1,
  ): { process: ManagedProcess; iterator: AsyncGenerator<string> } {
    logger.trace("Starting streaming fetch for items", {
      url: videoUrl,
      processKey,
      startIndex,
    });

    const processArgs = [
      "--playlist-start",
      startIndex.toString(),
      "--dump-json",
      "--no-download",
      videoUrl,
    ];

    const siteArgs = buildSiteArgs(videoUrl, config);
    if (siteArgs.length > 0) {
      processArgs.unshift(...siteArgs);
    }

    const fullCommandString = [
      "yt-dlp",
      ...processArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)),
    ].join(" ");

    logger.debug(`Starting streaming listing for ${videoUrl}`, {
      url: videoUrl,
      fullCommand: fullCommandString,
    });

    const listProcess = spawnPythonProcess(processArgs);
    const processEntry = listProcesses.get(processKey);

    if (processEntry) {
      const now = Date.now();
      processEntry.spawnedProcess = listProcess;
      processEntry.status = "running";
      processEntry.spawnTimeStamp = now;
      processEntry.lastActivity = now;
      processEntry.lastStdoutActivity = now;
      listProcesses.set(processKey, processEntry);
    } else {
      throw new Error(`Process entry not found: ${processKey}`);
    }

    void (async () => {
      for await (const data of streamTextChunks(listProcess.stderr)) {
        logger.error("List process error", {
          error: data,
          pid: listProcess.pid,
        });
        updateProcessActivity(processKey);
      }
    })();

    async function* lineIterator() {
      let linesYielded = 0;
      try {
        for await (const line of streamLines(listProcess.stdout)) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            updateProcessActivity(processKey, true);
            linesYielded++;
            yield trimmed;
          }
        }

        const exitCode = listProcess.killed ? null : (await listProcess.status).code;
        const isAllowedError = exitCode === 1 && linesYielded > 0;

        if (!listProcess.killed && exitCode !== 0 && !isAllowedError) {
          const processEntryInt = listProcesses.get(processKey);
          if (processEntryInt) {
            processEntryInt.status = "failed";
            processEntryInt.lastActivity = Date.now();
            listProcesses.set(processKey, processEntryInt);
          }
          throw new Error(`Process exited with code ${exitCode}`);
        } else {
          const processEntryInt = listProcesses.get(processKey);
          if (processEntryInt) {
            processEntryInt.status = "completed";
            processEntryInt.lastActivity = Date.now();
            listProcesses.set(processKey, processEntryInt);
          }
        }
      } catch (error) {
        const processEntryInt = listProcesses.get(processKey);
        if (processEntryInt) {
          processEntryInt.status = "errored";
          processEntryInt.lastActivity = Date.now();
          listProcesses.set(processKey, processEntryInt);
        }
        if (!listProcess.killed) {
          listProcess.kill();
        }
        throw error;
      }
    }

    return {
      process: listProcess,
      iterator: lineIterator(),
    };
  }

  async function processStreamingVideoInformation(
    responseItems: string[],
    playlistUrl: string,
    chunkStartIndex: number,
    isUpdate: boolean,
    monitoringType?: string,
  ): Promise<StreamingVideoProcessingResult> {
    logger.trace("Processing video information chunk", {
      playlistUrl,
      chunkStartIndex,
      isUpdate,
      itemCount: responseItems.length,
    });

    const result: StreamingVideoProcessingResult = {
      count: 0,
      title: "",
      responseUrl: playlistUrl,
      alreadyExistedCount: 0,
    };

    const parsedItems = responseItems.map(
      (item, index): ParsedStreamItem | null => {
        try {
          const itemData = JSON.parse(item) as StreamedItemData;
          const videoUrl = itemData.webpage_url || itemData.url || "";
          const onlineThumbnail = hasEphemeralThumbnails(videoUrl)
            ? null
            : (itemData.thumbnail || null);

          delete itemData.formats;
          delete itemData.requested_formats;
          delete itemData.thumbnails;
          delete itemData.subtitles;
          delete itemData.automatic_captions;

          return { itemData, videoUrl, index, onlineThumbnail };
        } catch (e) {
          logger.error("Failed to parse JSON from stream", {
            item,
            error: e as Error,
          });
          return null;
        }
      },
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    if (parsedItems.length === 0) {
      return result;
    }

    const videoUrls = parsedItems.map((parsedItem) => parsedItem.videoUrl);
    const [existingVideos, existingMappings] = await Promise.all([
      VideoMetadata.findAll({ where: { videoUrl: { [Op.in]: videoUrls } } }),
      PlaylistVideoMapping.findAll({
        where: {
          videoUrl: { [Op.in]: videoUrls },
          playlistUrl: playlistUrl,
        },
      }),
    ]);

    const existingVideosMap = new Map<string, Model>(
      existingVideos.map((video) => [
        video.getDataValue("videoUrl") as string,
        video,
      ]),
    );
    const existingMappingsMap = new Map<string, Model>(
      existingMappings.map((mapping) => [
        `${mapping.getDataValue("videoUrl")}|${
          mapping.getDataValue("positionInPlaylist")
        }`,
        mapping,
      ]),
    );
    const existingMappingsByUrl = new Map<string, Model>(
      existingMappings.map((mapping) => [
        mapping.getDataValue("videoUrl") as string,
        mapping,
      ]),
    );

    const videosToUpsert: VideoUpsertData[] = [];
    const mappingsToCreate: PlaylistMappingCreate[] = [];
    const mappingsToUpdate: PlaylistMappingUpdate[] = [];

    for (const { itemData, videoUrl, index, onlineThumbnail } of parsedItems) {
      const title = itemData.title || "";
      const videoId = itemData.id || "";
      const approxSize = itemData.filesize_approx || "NA";
      const existingVideo = existingVideosMap.get(videoUrl);
      const absoluteIndex = playlistUrl === "None"
        ? chunkStartIndex
        : chunkStartIndex + index;
      const existingMapping = existingMappingsMap.get(`${videoUrl}|${absoluteIndex}`);

      if (
        monitoringType !== "Refresh" &&
        existingVideo && existingMapping &&
        existingMapping.getDataValue("positionInPlaylist") === absoluteIndex
      ) {
        result.alreadyExistedCount++;
        result.count++;
        result.title = existingVideo.getDataValue("title");
        continue;
      }

      const videoData: VideoUpsertData = {
        videoUrl: videoUrl,
        videoId: videoId.trim(),
        title: truncateText(
          title === "NA" ? videoId.trim() : title,
          config.maxTitleLength,
        ),
        approximateSize: approxSize === "NA" ? -1 : parseInt(String(approxSize)),
        downloadStatus: existingVideo
          ? Boolean(existingVideo.getDataValue("downloadStatus"))
          : false,
        isAvailable: ![
          "[Deleted video]",
          "[Private video]",
          "[Unavailable video]",
        ].includes(title),
        onlineThumbnail: onlineThumbnail,
        raw_metadata: itemData,
      };

      videosToUpsert.push(videoData);

      if (!existingMapping) {
        if (playlistUrl === "None") {
          // "None" is the pseudo-playlist for unlisted/unplaylisted videos.
          // Duplicates are NOT allowed here — if the video already has a mapping,
          // update its position instead of creating a new one.
          const driftedMapping = existingMappingsByUrl.get(videoUrl);
          if (
            driftedMapping &&
            driftedMapping.getDataValue("positionInPlaylist") !== absoluteIndex
          ) {
            mappingsToUpdate.push({
              instance: driftedMapping,
              position: absoluteIndex,
            });
          } else if (!driftedMapping) {
            mappingsToCreate.push({
              videoUrl: videoUrl,
              playlistUrl: playlistUrl,
              positionInPlaylist: absoluteIndex,
            });
          }
        } else {
          // Real playlists: duplicates ARE allowed. YouTube allows the same video
          // at multiple positions in a playlist, so we must create a separate
          // mapping for each occurrence. Do NOT look for drifted mappings to update.
          mappingsToCreate.push({
            videoUrl: videoUrl,
            playlistUrl: playlistUrl,
            positionInPlaylist: absoluteIndex,
          });
        }
      } else if (
        existingMapping.getDataValue("positionInPlaylist") !== absoluteIndex
      ) {
        mappingsToUpdate.push({
          instance: existingMapping,
          position: absoluteIndex,
        });
      }

      result.count++;
      result.title = videoData.title;
      logger.debug("Processed video item in memory", {
        videoUrl,
        title: videoData.title,
        playlistUrl,
        index: absoluteIndex,
      });
    }

    if (videosToUpsert.length > 0) {
      const deduplicatedVideos = [
        ...new Map(
          videosToUpsert.map((video) => [video.videoUrl, video]),
        ).values(),
      ];
      await VideoMetadata.unscoped().bulkCreate(
        deduplicatedVideos as unknown as Array<Record<string, unknown>>,
        {
          updateOnDuplicate: [
            "videoId",
            "title",
            "approximateSize",
            "isAvailable",
            "updatedAt",
            "onlineThumbnail",
            "raw_metadata",
          ],
        },
      );
    }

    if (mappingsToCreate.length > 0) {
      await PlaylistVideoMapping.bulkCreate(
        mappingsToCreate as unknown as Array<Record<string, unknown>>,
      );
    }

    if (mappingsToUpdate.length > 0) {
      await Promise.all(
        mappingsToUpdate.map((m) =>
          m.instance.update({ positionInPlaylist: m.position })
        ),
      );
    }

    return result;
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

  function handleEmptyResponse(videoUrl: string) {
    safeEmit("listing-error", {
      url: videoUrl,
      error: "No items found",
    });

    return {
      url: videoUrl,
      title: "Video",
      status: "failed",
      error: "No items found",
    };
  }

  function handleListingError(error: Error, videoUrl: string, itemType: string) {
    logger.error("Listing failed", {
      url: videoUrl,
      error: error.message,
      stack: error.stack,
    });
    safeEmit("listing-error", {
      url: videoUrl,
      error: error.message,
    });
    return {
      url: videoUrl,
      title: itemType === "playlist" ? "Playlist" : "Video",
      status: "failed",
      error: error.message,
    };
  }

  function completePlaylistListing(
    videoUrl: string,
    processedChunks: number,
    playlistTitle: string,
    seekPlaylistListTo: number,
    isScheduledUpdate: boolean,
  ) {
    logger.info("Playlist listing completed", {
      url: videoUrl,
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
    });

    if (!isScheduledUpdate) {
      safeEmit("listing-playlist-complete", {
        url: videoUrl,
        type: "playlist",
        status: "completed",
        processedChunks,
        playlistTitle,
        seekPlaylistListTo,
      });
    }

    return {
      url: videoUrl,
      type: "Playlist",
      status: "completed",
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
    };
  }

  async function addPlaylist(playlistUrl: string, monitoringType: string) {
    let playlistTitle = "";
    if (pendingPlaylistSortCounter === null) {
      if (pendingPlaylistSortCounterPromise === null) {
        pendingPlaylistSortCounterPromise = PlaylistMetadata.findOne({
          order: [["sortOrder", "DESC"]],
          attributes: ["sortOrder"],
          limit: 1,
        }).then((lastPlaylist: Model | null) => {
          const initialValue = lastPlaylist !== null
            ? (lastPlaylist as any).sortOrder + 1
            : 0;
          pendingPlaylistSortCounter = initialValue;
          return initialValue;
        });
      }
      await pendingPlaylistSortCounterPromise;
    }
    const nextPlaylistIndex = pendingPlaylistSortCounter!++;

    const processArgs = [
      "--playlist-end",
      "1",
      "--dump-json",
      "--no-download",
      playlistUrl,
    ];

    const siteArgs = buildSiteArgs(playlistUrl, config);
    if (siteArgs.length > 0) {
      processArgs.unshift(...siteArgs);
    }

    const titleProcess = spawnPythonProcess(processArgs);

    logger.debug("Trying to get playlist title", {
      url: playlistUrl,
      fullCommand: [
        "yt-dlp",
        ...processArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)),
      ].join(" "),
    });

    return new Promise((resolve, reject) => {
      void (async () => {
        for await (const data of streamTextChunks(titleProcess.stdout)) {
          playlistTitle += data;
        }
      })();

      void (async () => {
        for await (const data of streamTextChunks(titleProcess.stderr)) {
          logger.error(`Error getting playlist title: ${data}`);
        }
      })();

      void (async () => {
        const { code } = await titleProcess.status;
        try {
          if (code !== 0) {
            throw new Error("Failed to get playlist title");
          }

          try {
            const jsonData = JSON.parse(playlistTitle.toString().trim());
            if (jsonData) {
              playlistTitle = jsonData.playlist_title || jsonData.title ||
                playlistTitle;
            }
          } catch (e) {
            logger.error("Failed to parse playlist title JSON", {
              playlistTitle,
              error: e as Error,
            });
          }

          if (!playlistTitle || playlistTitle.toString().trim() === "NA") {
            playlistTitle = urlToTitle(playlistUrl);
          }

          playlistTitle = truncateText(playlistTitle, config.maxTitleLength);

          logger.debug(`Creating playlist with title: ${playlistTitle}`, {
            url: playlistUrl,
            pid: titleProcess.pid,
            code: code,
            monitoringType: monitoringType,
            lastUpdatedByScheduler: Date.now(),
          });

          const [playlist, created] = await PlaylistMetadata.findOrCreate({
            where: { playlistUrl: playlistUrl },
            defaults: {
              title: playlistTitle.trim(),
              monitoringType: monitoringType,
              saveDirectory: playlistTitle.trim(),
              sortOrder: nextPlaylistIndex,
              lastUpdatedByScheduler: Date.now(),
            },
          });

          if (!created) {
            logger.warn("Playlist already exists", { url: playlistUrl });
          }

          resolve(playlist);
        } catch (error) {
          logger.error("Failed to create playlist", {
            url: playlistUrl,
            error: (error as Error).message,
          });
          reject(error);
        }
      })().catch(reject);
    });
  }

  function resetPendingPlaylistSortCounter() {
    pendingPlaylistSortCounter = null;
    pendingPlaylistSortCounterPromise = null;
  }

  return {
    cleanupStaleProcesses,
    downloadProcesses,
    listProcesses,
    listItemsConcurrently,
    processDownloadRequest,
    processListingRequest,
    resetPendingPlaylistSortCounter,
  };
}
