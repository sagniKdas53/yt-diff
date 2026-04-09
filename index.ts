/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any
import { Model, Op } from "sequelize";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import he from "he";
import Redis from "ioredis";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

import { config, YT_DLP_PATCHED_CMD } from "./src/config.ts";
import {
  initializeDatabase,
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "./src/db/models.ts";
import {
  type BulkSignedFilesRequestBody,
  createFileHandlers,
  type RefreshSignedUrlRequestBody,
  type SignedFileRequestBody,
} from "./src/handlers/files.ts";
import {
  createPlaylistHandlers,
  type DeletePlaylistRequestBody,
  type DeleteVideosRequestBody,
  type PlaylistDisplayRequest,
  type ReindexAllRequestBody,
  type SubListRequest,
  type UpdatePlaylistMonitoringRequest,
} from "./src/handlers/playlists.ts";
import { createJobs, startJobs } from "./src/jobs/index.ts";
import { logger } from "./src/logger.ts";
import { createAuthMiddleware } from "./src/middleware/auth.ts";
import { createRateLimit } from "./src/middleware/rateLimit.ts";
import { createApiRoutes } from "./src/routes/api.ts";
import { dispatchRoute } from "./src/routes/http.ts";
import { tryServeSignedFile } from "./src/routes/helpers/serveSignedFile.ts";
import { serveStaticAsset, type StaticAsset } from "./src/routes/helpers/serveStaticAsset.ts";
import { createSocketServer } from "./src/socket/index.ts";

const pipelineAsync = promisify(pipeline);

logger.info("Logger initialized", { logLevel: config.logLevel });

/**
 * An array of download options for a YouTube downloader.
 * The options are conditionally included based on the configuration settings.
 *
 * Options included:
 * - "--embed-metadata": Always included to embed metadata in the downloaded file.
 * - "--embed-chapters": Always included to embed chapters in the downloaded file.
 * - "--write-subs": Included if `config.saveSubs` is true, to write subtitles.
 * - "--write-auto-subs": Included if `config.saveSubs` is true, to write automatic subtitles.
 * - "--write-description": Included if `config.saveDescription` is true, to write the video description.
 * - "--write-comments": Included if `config.saveComments` is true, to write the video comments.
 * - "--write-thumbnail": Included if `config.saveThumbnail` is true, to write the video thumbnail.
 * - "--paths": Always included to specify the download paths.
 *
 * Options that are supported but not included by default:
 * - "--embed-thumbnail": This option is not included as it is not be supported for webm formats and can cause conversion to mkv/mp4, which adds time to the process.
 * - "--embed-subs": This option is not included as embedding subtitles to every video may not be possible depending on the format.
 *
 * The array is filtered to remove any empty strings.
 */
const downloadOptions = [
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
// Check if file name length limit is set and valid
if (!isNaN(config.maxFileNameLength) && config.maxFileNameLength > 0) {
  downloadOptions.push(`--trim-filenames`);
  downloadOptions.push(`${config.maxFileNameLength}`);
}
// Regex needs to be separate
const playlistRegex = /(?:playlist|list=|videos$)\b/i;

// Static content and server configuration
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".gz": "application/gzip",
  ".br": "application/brotli",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};
const CORS_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  // `http://localhost:${config.port}`,
  // `${config.protocol}://${config.host}:${config.port}`,
  // "*"
];
const CORS_ALLOWED_HEADERS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "OPTIONS",
];

if (config.secretKey instanceof Error) {
  logger.error("Configuration error", { error: config.secretKey });
  throw config.secretKey;
}
if (config.db.password instanceof Error) {
  logger.error("Configuration error", { error: config.db.password });
  throw config.db.password;
}
if (config.cookiesFile instanceof Error) {
  logger.warn("Cookies file configuration error, proceeding without cookies", {
    error: config.cookiesFile,
  });
  config.cookiesFile = false;
}
if (config.proxy_string instanceof Error) {
  logger.warn(
    "Proxy string configuration error, proceeding with direct connection",
    {
      error: config.proxy_string,
    },
  );
  config.proxy_string = "";
}
if (config.iwara._parseError) {
  logger.error("Failed to parse IWARA config", {
    error: config.iwara._parseError,
  });
}
if (!fs.existsSync(config.saveLocation)) {
  logger.info("Save location doesn't exists", {
    saveLocation: config.saveLocation,
  });
  try {
    logger.info("Creating save location", {
      saveLocation: config.saveLocation,
    });
    fs.mkdirSync(config.saveLocation, { recursive: true });
  } catch (error) {
    logger.error("Failed to create save location", {
      saveLocation: config.saveLocation,
      error: (error as Error).message,
    });
    throw new Error(
      `Failed to create save location: ${(error as Error).message}`,
    );
  }
}

const redis = new (Redis as any)({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
});

redis.on("error", (err: Error) => {
  logger.error("Redis error", { error: err.message });
});

redis.on("connect", () => {
  logger.info("Connected to Redis");
});

/**
 * Safely emit socket.io events if socket server is available.
 * Wraps emit calls in try/catch to avoid crashing the process when socket is not ready.
 * @param {string} event - Event name
 * @param {any} payload - Event payload
 */
function safeEmit(event: string, payload: unknown) {
  try {
    if (
      typeof sock !== "undefined" && sock && typeof sock.emit === "function"
    ) {
      sock.emit(event, payload);
    }
  } catch (e) {
    logger.warn("safeEmit failed", {
      event,
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}

void initializeDatabase();

// Utility functions
/**
 * Extracts and parses JSON data from a request stream
 *
 * @param {http.IncomingMessage} request - The HTTP request object
 * @returns {Promise<Object>} Parsed JSON data from request body
 * @throws {Object} Error with status code and message if request is too large or JSON is invalid
 */
function parseRequestJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let requestBody = "";
    const maxRequestSize = 1e6; // 1MB limit
    const textDecoder = new TextDecoder();

    request.on("data", (chunk: Uint8Array) => {
      requestBody += textDecoder.decode(chunk, { stream: true });

      // Check request size
      if (requestBody.length > maxRequestSize) {
        logger.warn("Request exceeded size limit", {
          ip: request.socket.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method,
        });

        request.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });

    request.on("end", () => {
      requestBody += textDecoder.decode();

      if (requestBody.length === 0) {
        logger.warn("Empty request body", {
          ip: request.socket.remoteAddress,
          url: request.url,
          method: request.method,
        });

        reject({ status: 400, message: "Empty Request Body" });
        return;
      }

      try {
        const parsedData = JSON.parse(requestBody);
        resolve(parsedData);
      } catch (error) {
        logger.error("Failed to parse JSON", {
          ip: request.socket.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method,
          error: (error as Error).message,
        });

        reject({ status: 400, message: "Invalid JSON" });
      }
    });
    request.on("error", (err: Error) => {
      reject({
        status: 500,
        message: "Request stream error",
        error: err.message,
      });
    });
  });
}
/**
 * Fixes common URL formatting issues for various platforms
 *
 * @param {string} url - URL to process
 * @returns {string} Fixed URL
 */
function normalizeUrl(url: string) {
  let hostname = "";
  try {
    hostname = (new URL(url)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${url}`, { error: (e as Error).message });
  }
  // Non-exhaustive list of YouTube hostnames, can be expanded as needed
  // Also handles youtu.be short URLs
  // https://support.google.com/youtube/answer/6180214?hl=en
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
    // Add /videos to YouTube channel URLs if missing
    if (!/\/videos\/?$/.test(url) && url.includes("/@")) {
      url = url.replace(/\/$/, "") + "/videos";
    }
    logger.debug(`Normalized YouTube URL: ${url}`);
  }
  return url;
}
/**
 * Generates a title from a URL by extracting meaningful path segments
 *
 * @param {string} url - URL to convert to title
 * @returns {Promise<string>} Generated title
 */
function urlToTitle(url: string) {
  try {
    // Extract path segments and join them
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
/**
 * Pauses execution for specified duration
 *
 * @param {number} [seconds=config.sleepTime] - Duration to sleep in seconds
 * @returns {Promise<void>} Resolves after sleep completes
 */
async function sleep(seconds = Number(config.sleepTime)) {
  logger.trace(`Sleeping for ${seconds} seconds`);

  const start = Date.now();
  await new Promise((resolve) =>
    setTimeout(resolve, seconds * 1000)
  );
  const duration = (Date.now() - start) / 1000;

  logger.trace(`Sleep completed after ${duration} seconds`);
}
/**
 * Truncates a string to specified length if needed
 *
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum allowed length
 * @returns {Promise<string>} Truncated string
 */
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
/**
 * Checks if the given video URL belongs to x.com or any of its subdomains.
 *
 * @param {string} videoUrl - The URL of the video to check.
 * @returns {boolean} True if the URL's hostname is x.com or a subdomain of x.com, false otherwise.
 */
function isSiteXDotCom(videoUrl: string): boolean {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${videoUrl}`, {
      error: (e as Error).message,
    });
  }
  // Only match x.com or its subdomains (e.g. foo.x.com)
  const allowedXHost = "x.com";
  const isAllowedXCom = hostname === allowedXHost ||
    hostname.endsWith("." + allowedXHost);
  return isAllowedXCom;
}
/**
 * Checks if the given video URL belongs to a site whose thumbnail URLs are
 * ephemeral (signed CDN URLs that expire within hours/days).
 * Currently covers: facebook.com, instagram.com, pornhub.com and their subdomains.
 *
 * @param {string} videoUrl - The URL of the video to check.
 * @returns {boolean} True if the site's thumbnails are known to be ephemeral.
 */
function hasEphemeralThumbnails(videoUrl: string): boolean {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch {
    return false;
  }
  const ephemeralHosts = ["facebook.com", "instagram.com", "pornhub.com"];
  return ephemeralHosts.some(
    (h) => hostname === h || hostname.endsWith("." + h),
  );
}

/**
 * Checks if the given video URL belongs to iwara.tv or any of its subdomains.
 *
 * @param {string} videoUrl - The URL of the video to check.
 * @returns {boolean} True if the URL's hostname is iwara.tv or a subdomain of iwara.tv, false otherwise.
 */
function isSiteIwaraDotTv(videoUrl: string): boolean {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${videoUrl}`, {
      error: (e as Error).message,
    });
  }
  // Only match iwara.tv or its subdomains (e.g. foo.iwara.tv)
  const allowedIwaraHost = "iwara.tv";
  const isAllowedIwaraDotTv = hostname === allowedIwaraHost ||
    hostname.endsWith("." + allowedIwaraHost);
  return isAllowedIwaraDotTv;
}

// Site specific argument builders
export type SiteArgBuilder = (url: string, config: any) => string[];

const siteArgBuilders: SiteArgBuilder[] = [
  // x.com
  (url, config) => {
    if (config.cookiesFile && isSiteXDotCom(url)) {
      logger.debug(`Using cookies file: ${config.cookiesFile}`);
      return ["--cookies", config.cookiesFile as string];
    }
    return [];
  },
  // iwara.tv
  (url, config) => {
    if (isSiteIwaraDotTv(url)) {
      const args = ["--impersonate", "Chrome-133"];
      if (config.iwara && config.iwara.username && config.iwara.password) {
        args.push(
          "--username",
          config.iwara.username,
          "--password",
          config.iwara.password,
        );
      }
      return args;
    }
    return [];
  },
];

export function buildSiteArgs(url: string, config: any): string[] {
  const args = siteArgBuilders.flatMap((builder) => builder(url, config));
  if (config.proxy_string && !isSiteIwaraDotTv(url)) {
    args.push("--proxy", config.proxy_string);
  }
  return args;
}

//Authentication functions
/**
 * Hashes a password using bcrypt with configurable salt rounds
 *
 * @param {string} plaintextPassword - The password to hash
 * @returns {Promise<[string, string]>} Promise resolving to [salt, hashedPassword]
 * @throws {Error} If hashing fails
 */
async function hashPassword(
  plaintextPassword: string,
): Promise<[string, string]> {
  try {
    const salt = await bcrypt.genSalt(config.saltRounds);
    const hashedPassword = await bcrypt.hash(plaintextPassword, salt);
    return [salt, hashedPassword];
  } catch (error) {
    logger.error("Password hashing failed", {
      error: (error as Error).message,
    });
    throw new Error("Failed to secure password");
  }
}
/**
 * Generates a JWT token for authenticated user sessions
 *
 * @param {Object} user - User object from database
 * @param {string} user.id - User's unique identifier
 * @param {Date} user.updatedAt - Timestamp of last password update
 * @param {string} expiryDuration - Token expiry duration (e.g., "24h", "7d")
 * @returns {string} JWT token
 */
function generateAuthToken(
  user: { id: string; updatedAt: Date },
  expiryDuration: string,
): string {
  return jwt.sign(
    {
      id: user.id,
      lastPasswordChangeTime: user.updatedAt,
    },
    config.secretKey as string,
    { expiresIn: expiryDuration as any },
  );
}
function emitTokenExpired(payload: { error: string }) {
  sock.emit("token-expired", payload);
}

const { authenticateRequest, authenticateSocket, authenticateUser, isRegistrationAllowed, registerUser } =
  createAuthMiddleware({
    parseRequestJson,
    generateCorsHeaders,
    jsonMimeType: MIME_TYPES[".json"],
    redis,
    generateAuthToken,
    hashPassword,
    emitTokenExpired,
  });

const rateLimit = createRateLimit({
  redis,
  generateCorsHeaders,
  jsonMimeType: MIME_TYPES[".json"],
});

const { makeSignedUrl, makeSignedUrls, refreshSignedUrl } = createFileHandlers({
  redis,
  generateCorsHeaders,
  jsonMimeType: MIME_TYPES[".json"],
  mimeTypes: MIME_TYPES,
});

const {
  updatePlaylistMonitoring,
  processDeletePlaylistRequest,
  processReindexAllRequest,
  processDeleteVideosRequest,
  getPlaylistsForDisplay,
  getSubListVideos,
} = createPlaylistHandlers({
  generateCorsHeaders,
  jsonMimeType: MIME_TYPES[".json"],
  listItemsConcurrently,
  resetPendingPlaylistSortCounter: () => {
    pendingPlaylistSortCounter = null;
    pendingPlaylistSortCounterPromise = null;
  },
});

interface Process {
  status: string;
  spawnType: string;
  lastActivity: number;
  spawnTimeStamp: number;
  spawnedProcess?: { kill: (signal: string) => boolean };
}
interface ListingRequestBody {
  urlList?: string[];
  chunkSize?: number | string;
  sleep?: boolean;
  monitoringType?: string;
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
  save: () => Promise<unknown>;
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
// Download process tracking
const downloadProcesses = new Map(); // Map to track download processes
/**
 * A semaphore implementation to control the number of concurrent asynchronous operations.
 *
 * @property {number} maxConcurrent - The maximum number of concurrent operations allowed.
 * @property {number} currentConcurrent - The current number of active concurrent operations.
 * @property {Array<Function>} queue - A queue of pending operations waiting for a semaphore slot.
 *
 * @method acquire
 * Acquires a semaphore slot. If the maximum concurrency is reached, the operation is queued.
 * @returns {Promise<void>} A promise that resolves when the semaphore slot is acquired.
 *
 * @method release
 * Releases a semaphore slot. If there are pending operations in the queue, the next one is started.
 *
 * @method setMaxConcurrent
 * Updates the maximum number of concurrent operations allowed. If the new limit allows for more
 * operations to start, queued operations are processed.
 * @param {number} max - The new maximum number of concurrent operations.
 */
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
        logger.debug(`Semaphore full, queuing request`);
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
      logger.debug(`Semaphore released`);
      this.currentConcurrent--;
    }
  },

  setMaxConcurrent(max: number) {
    this.maxConcurrent = max;
    // Check if we can start any queued tasks
    while (
      this.currentConcurrent < this.maxConcurrent && this.queue.length > 0
    ) {
      const next = this.queue.shift();
      this.currentConcurrent++;
      if (next) next();
    }
  },
};
/**
 * Converts a process map to a serializable state object
 *
 * @param {Map<string, {status: string}>} processMap - Map of process entries
 * @returns {Object} Object containing process states by ID
 */
function getProcessStates(processMap: Map<string, Process>) {
  const states: Record<
    string,
    { status: string; type: string; lastActive: number }
  > = {};

  for (const [processId, process] of processMap.entries()) {
    logger.debug(`Processing state for ${processId}`, {
      status: process.status,
    });

    states[processId] = {
      status: process.status,
      type: process.spawnType,
      lastActive: process.lastActivity,
    };
  }

  return JSON.stringify(states);
}
/**
 * Cleans up stale processes from the process map
 *
 * @param {Map<string, Object>} processMap - Map of active processes
 * @param {Object} [options] - Cleanup options
 * @param {number} [options.maxIdleTime=config.queue.maxIdle] - Maximum idle time in ms
 * @param {boolean} [options.forceKill=false] - Whether to force kill hanging processes
 * @returns {number} Number of processes cleaned up
 */
function cleanupStaleProcesses(
  processMap: Map<string, Process>,
  {
    maxIdleTime = config.queue.maxIdle,
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

  // Iterate through processes
  for (const [processId, process] of processMap.entries()) {
    const { status, lastActivity, spawnTimeStamp, spawnedProcess } = process;

    logger.debug(`Checking process ${processId}`, {
      status,
      lastActivity,
      age: now - spawnTimeStamp,
    });

    // Handle completed processes
    if (status === "completed" || status === "failed") {
      processMap.delete(processId);
      cleanedCount++;
      continue;
    }

    // Handle stale processes
    if (status === "running" && (now - lastActivity > maxIdleTime)) {
      logger.warn(`Found stale process: ${processId}`, {
        idleTime: (now - lastActivity) / 1000,
        lastActivity: new Date(lastActivity).toISOString(),
      });

      if (spawnedProcess?.kill && forceKill) {
        try {
          // Try SIGKILL first
          const killed = spawnedProcess.kill("SIGKILL");
          if (killed) {
            logger.info(`Killed stale process ${processId}`);
          } else {
            // Fall back to SIGTERM
            const terminated = spawnedProcess.kill("SIGTERM");
            logger.info(`Terminated stale process ${processId}`);

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
/**
 * Processes download requests for videos and initiates downloads
 *
 * @param {Object} requestBody - The request parameters
 * @param {Array<string>} requestBody.urlList - Array of video URLs to download
 * @param {string} [requestBody.playListUrl="None"] - Optional playlist URL the videos belong to
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when download processing is complete
 */
async function processDownloadRequest(
  requestBody: { urlList: string[]; playListUrl?: string },
  response: ServerResponse,
) {
  try {
    // Initialize download tracking
    const videosToDownload: DownloadItem[] = [];
    const uniqueUrls = new Set();
    const playlistUrl = requestBody.playListUrl ?? "None";

    // Process each URL
    for (const videoUrl of requestBody.urlList) {
      if (uniqueUrls.has(videoUrl)) {
        continue; // Skip duplicates
      }

      logger.debug(`Checking video in database`, { url: videoUrl });

      // Look up video in database
      const videoEntry = await VideoMetadata.findOne({
        where: { videoUrl: videoUrl },
      });

      if (!videoEntry) {
        logger.error(`Video not found in database`, { url: videoUrl });
        response.writeHead(404, generateCorsHeaders(MIME_TYPES[".json"]));
        return response.end(JSON.stringify({
          error: `Video with URL ${videoUrl} is not indexed`,
        }));
      }

      // Get save directory from video entry as fallback
      let saveDirectory =
        (videoEntry as unknown as { saveDirectory: string })?.saveDirectory ??
          "";

      // Override with playlist save directory if a specific playlist is provided
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
          logger.error(`Error getting playlist save directory`, {
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
          logger.error(`Error getting fallback playlist save directory`, {
            error: (error as Error).message,
            videoUrl,
          });
        }
      }

      // Add to download queue
      videosToDownload.push({
        url: videoUrl,
        title: (videoEntry as unknown as { title: string }).title,
        saveDirectory: saveDirectory,
        videoId: (videoEntry as unknown as { videoId: string }).videoId,
      });
      uniqueUrls.add(videoUrl);
    }

    // Start downloads
    downloadItemsConcurrently(videosToDownload, config.queue.maxDownloads);
    logger.debug(`Download processes started`, {
      itemCount: videosToDownload.length,
    });

    // Send success response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "success",
      message: "Downloads initiated",
      items: videosToDownload,
    }));
  } catch (error) {
    logger.error(`Download processing failed`, {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    const statusCode = (error as any).status || 500;
    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "error",
      message: he.escape((error as Error).message),
    }));
  }
}
/**
 * Downloads multiple items concurrently with enhanced process tracking and concurrency control
 *
 * @param {Array<Map<string, string>>} items - Array of items to download, each represented as a Map with keys:
 *   - url: URL of video
 *   - title: Title of video
 *   - saveDirectory: Save directory path
 *   - videoId: Video ID
 * @param {number} [maxConcurrent=2] - Maximum number of concurrent downloads
 * @returns {Promise<boolean>} Resolves to true if all downloads successful
 */

async function downloadItemsConcurrently(
  items: DownloadItem[],
  maxConcurrent: number = 2,
): Promise<boolean> {
  logger.trace(
    `Downloading ${items.length} videos concurrently (max ${maxConcurrent} concurrent)`,
  );

  // Update the semaphore's max concurrent value
  DownloadSemaphore.setMaxConcurrent(maxConcurrent);

  // Filter out URLs already being downloaded
  const uniqueItems = items.filter((item) => {
    const videoUrl = item.url;
    const existingDownload = Array.from(downloadProcesses.values())
      .find((process) =>
        process.url === videoUrl &&
        ["running", "pending"].includes(process.status)
      );

    return !existingDownload;
  });

  logger.trace(`Filtered ${uniqueItems.length} unique items for download`);

  // Process all items with semaphore control
  const downloadResults = await Promise.all(
    uniqueItems.map((item) => downloadWithSemaphore(item)),
  );

  // Check for any failures

  const allSuccessful = downloadResults.every((result) =>
    result && result.status === "success"
  );

  // Log results

  downloadResults.forEach((result) => {
    if (result.status === "success") {
      logger.info(`Downloaded ${result.title} successfully`);
    } else {
      logger.error(`Failed to download ${result.title}: ${result.error}`);
    }
  });

  return allSuccessful;
}
/**
 * Wrapper function that handles downloading a video item with semaphore-based concurrency control
 *
 * @param {Object} downloadItem - Object containing video details:
 *   - url: Video URL
 *   - title: Video title
 *   - saveDirectory: Save directory path
 *   - videoId: Video ID
 * @returns {Promise<Object>} Download result containing:
 *   - url: Video URL
 *   - title: Video title
 *   - status: 'success' | 'failed'
 *   - error?: Error message if failed
 */

async function downloadWithSemaphore(
  downloadItem: DownloadItem,
): Promise<DownloadResult> {
  logger.trace(
    `Starting download with semaphore: ${JSON.stringify(downloadItem)}`,
  );

  // Acquire semaphore before starting download
  await DownloadSemaphore.acquire();

  try {
    const { url: videoUrl, title: videoTitle } = downloadItem;

    // Create pending download entry
    const downloadEntry = {
      url: videoUrl,
      title: videoTitle,
      lastActivity: Date.now(),
      spawnTimeStamp: Date.now(),
      status: "pending",
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    downloadProcesses.set(entryKey, downloadEntry);

    // Execute download
    const result = await executeDownload(downloadItem, entryKey);

    // Cleanup pending entry if still exists
    if (downloadProcesses.has(entryKey)) {
      downloadProcesses.delete(entryKey);
    }

    return result;
  } finally {
    // Always release semaphore
    DownloadSemaphore.release();
  }
}
/**
 * Downloads a video using yt-dlp with progress tracking and status updates
 *
 * @param {Object} downloadItem - Object containing video details:
 *   - url: Video URL
 *   - title: Video title
 *   - saveDirectory: Save directory path
 *   - videoId: Video ID
 * @param {string} processKey - Key to track download process
 * @returns {Promise<Object>} Download result containing:
 *   - url: Video URL
 *   - title: Video title
 *   - status: 'success' | 'failed'
 *   - error?: Error message if failed
 */

function executeDownload(
  downloadItem: DownloadItem,
  processKey: string,
): Promise<DownloadResult> {
  const {
    url: videoUrl,
    title: videoTitle,
    saveDirectory: saveDirectory,
    videoId: videoId,
  } = downloadItem;

  try {
    // Trim the saveDirectory just as a precaution
    const saveDirectoryTrimmed = saveDirectory.trim();
    // Prepare save path
    const savePath = path.join(config.saveLocation, saveDirectoryTrimmed);
    logger.debug(`Downloading to path: ${savePath}`);

    // Create directory if needed, good to have
    if (savePath !== config.saveLocation && !fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    return new Promise<DownloadResult>((resolve, reject) => {
      let progressPercent: number | null = null;
      let capturedTitle: string | null = null;
      let capturedFileName: string | null = null;
      // Prepare final parameters
      const processArgs = ["-P", "home:" + savePath, videoUrl];

      // Notify frontend of download start
      safeEmit("download-started", { url: videoUrl, percentage: 101 });

      // Add site-specific args (like cookies for x.com, impersonation for iwara.tv)
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
      // Spawn download process, by assembling full args
      const downloadProcess = spawn("python3", [
        "-c",
        YT_DLP_PATCHED_CMD,
        ...downloadOptions.concat(processArgs),
      ]);

      // Update process tracking
      const processEntry = downloadProcesses.get(processKey);
      if (processEntry) {
        processEntry.spawnedProcess = downloadProcess;
        processEntry.status = "running";
        processEntry.lastActivity = Date.now();
        downloadProcesses.set(processKey, processEntry);
      } else {
        logger.error(`Process entry not found: ${processKey}`);
        return reject(new Error(`Process entry not found: ${processKey}`));
      }

      // Handle stdout for progress tracking
      downloadProcess.stdout.setEncoding("utf8");
      downloadProcess.stdout.on("data", (data) => {
        try {
          const output = data.toString().trim();

          // Track download progress
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

            // Emit progress update to frontend
            // TODO: Check if this is needed, as when multiple downloads are running this does not work properly
            safeEmit("downloading-percent-update", {
              url: videoUrl,
              percentage: percent,
            });
          }

          // Extract the title, no extension
          const itemTitle = /title:(.+)/m.exec(output);
          if (itemTitle?.[1] && !capturedFileName) {
            capturedTitle = itemTitle[1].trim();
            logger.debug(`Video Title from process ${capturedTitle}`, {
              pid: downloadProcess.pid,
            });
          }

          // Get the final file name (only the video) from that we can get the rest
          const fileNameInDest = /fileName:(.+)"/m.exec(output);
          if (fileNameInDest?.[1]) {
            const finalFileName = fileNameInDest[1].trim();
            capturedFileName = path.basename(finalFileName);
            logger.debug(
              `Filename in destination: ${finalFileName}, basename: ${capturedFileName}, DB title: ${videoTitle}`,
              { pid: downloadProcess.pid },
            );
          }
          // Update activity timestamp
          updateProcessActivity(processKey);
        } catch (error) {
          if (!(error instanceof TypeError)) {
            safeEmit("error", { message: (error as Error).message });
          }
        }
      });

      // Handle stderr
      downloadProcess.stderr.setEncoding("utf8");
      downloadProcess.stderr.on("data", (error) => {
        logger.error(`Download error: ${error}`, { pid: downloadProcess.pid });
        updateProcessActivity(processKey);
      });

      // Handle process errors
      downloadProcess.on("error", (error) => {
        logger.error(`Download process error: ${error.message}`, {
          pid: downloadProcess.pid,
        });
        updateProcessActivity(processKey);
        reject(error);
      });

      // Handle process completion
      downloadProcess.on("close", async (code) => {
        try {
          const videoEntry = await VideoMetadata.findOne({
            where: { videoUrl: videoUrl },
          });

          if (code === 0) {
            // ===== SUCCESS: Update video entry =====

            const unhelpfulTitle = videoTitle === videoId ||
              videoTitle === "NA";
            const fallbackTitle = capturedTitle || videoTitle;

            // Build initial updates object
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

            // Discover associated metadata files
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

            // Add discovered metadata files to updates
            Object.assign(updates, metadata);

            // Determine if all expected metadata files were found
            const allExtraFilesFound = syncStatus.videoFileFound &&
              syncStatus.descriptionFileFound &&
              syncStatus.commentsFileFound &&
              syncStatus.subTitleFileFound &&
              syncStatus.thumbNailFileFound;

            // Log metadata sync status
            if (allExtraFilesFound) {
              logger.info("All extra files found", {
                updates: JSON.stringify(updates),
              });
            } else {
              logger.info("Some of the expected files are not found", {
                updates: JSON.stringify(updates),
              });
            }

            logger.debug(`Updating video: ${JSON.stringify(updates)}`, {
              pid: downloadProcess.pid,
            });

            if (videoEntry) await videoEntry.update(updates);

            // Notify frontend: send saveDirectory and fileName
            try {
              const fileName = updates.fileName;
              const thumbNailFile = updates.thumbNailFile;
              const subTitleFile = updates.subTitleFile;
              const descriptionFile = updates.descriptionFile;
              const isMetaDataSynced = updates.isMetaDataSynced;
              const saveDir = computeSaveDirectory(savePath);

              // Check if computed saveDir matches expected saveDirectory (if available)
              if (
                typeof saveDirectory !== "undefined" &&
                saveDir === saveDirectory.trim()
              ) {
                logger.debug(
                  `Computed saveDir matches expected saveDirectory`,
                  {
                    saveDir,
                    saveDirectory,
                  },
                );
              } else if (typeof saveDirectory !== "undefined") {
                logger.debug(
                  `Computed saveDir differs from expected saveDirectory`,
                  {
                    saveDir,
                    saveDirectory,
                  },
                );
              }

              safeEmit("download-done", {
                url: videoUrl,
                title: updates.title,
                fileName: fileName,
                saveDirectory: saveDir,
                isMetaDataSynced: isMetaDataSynced,
                thumbNailFile: thumbNailFile,
                subTitleFile: subTitleFile,
                descriptionFile: descriptionFile,
              });
            } catch (e) {
              // Fallback to previous behavior if something goes wrong
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

            // Cleanup process entry
            cleanupProcess(processKey, downloadProcess.pid);

            resolve({
              url: videoUrl,
              title: updates.title,
              status: "success",
            });
          } else {
            // ===== FAILURE: Handle download failure =====

            logger.error("Download failed", {
              videoUrl,
              exitCode: code,
              pid: downloadProcess.pid,
            });

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
            });
          }
        } catch (error) {
          logger.error(
            `Error handling download completion: ${(error as Error).message}`,
            {
              pid: downloadProcess.pid,
            },
          );
          reject(error);
        }
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
// Helper function to update process activity timestamp
/**
 * Updates the last activity timestamp of a process entry
 *
 * @param {string} processKey - Key of the process entry to update
 */
function updateProcessActivity(processKey: string) {
  const downloadEntry = downloadProcesses.get(processKey);
  if (downloadEntry) {
    downloadEntry.lastActivity = Date.now();
  }
  const listEntry = listProcesses.get(processKey);
  if (listEntry) {
    listEntry.lastActivity = Date.now();
  }
}
// Helper function to cleanup process entry
/**
 * Removes a process entry from the download processes map
 * @param {string} processKey - Key of the process entry to remove
 * @param {number} pid - Process ID of the process to remove
 */
function cleanupProcess(processKey: string, pid: number | undefined) {
  if (downloadProcesses.has(processKey)) {
    downloadProcesses.delete(processKey);
    logger.trace(`Removed process from cache: ${pid}`, { pid });
    logger.trace(`Process map state: ${getProcessStates(downloadProcesses)}`);
    logger.trace(`Process map size: ${downloadProcesses.size}`);
  }
}

// List functions
const listProcesses = new Map(); // Map to track listing processes
/**
 * A semaphore implementation to control the number of concurrent listing operations.
 *
 * @property {number} maxConcurrent - The maximum number of concurrent operations allowed.
 * @property {number} currentConcurrent - The current number of active concurrent operations.
 * @property {Array<Function>} queue - A queue of pending operations waiting for a semaphore slot.
 *
 * @method acquire
 * Acquires a semaphore slot. If the maximum concurrency is reached, the operation is queued.
 * @returns {Promise<void>} A promise that resolves when the semaphore slot is acquired.
 *
 * @method release
 * Releases a semaphore slot. If there are pending operations in the queue, the next one is started.
 *
 * @method setMaxConcurrent
 * Updates the maximum number of concurrent operations allowed. If the new limit allows for more
 * operations to start, queued operations are processed.
 * @param {number} max - The new maximum number of concurrent operations.
 */

// Lazily initialized from DB; incremented synchronously in addPlaylist
// so concurrent callers each get a distinct sortOrder.
let pendingPlaylistSortCounter: number | null = null;
let pendingPlaylistSortCounterPromise: Promise<number> | null = null;

const ListingSemaphore = {
  maxConcurrent: config.queue.maxListings,
  currentConcurrent: 0,

  queue: [] as Array<(value?: any) => void>,

  acquire() {
    return new Promise((resolve) => {
      if (this.currentConcurrent < this.maxConcurrent) {
        this.currentConcurrent++;
        logger.debug(
          `Listing semaphore acquired, current concurrent: ${this.currentConcurrent}`,
        );
        resolve(undefined);
      } else {
        logger.debug(`Listing semaphore full, queuing request`);
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
      logger.debug(`Listing semaphore released`);
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
/**
 * Processes a list of URLs and initiates listing operations for undownloaded videos and unmonitored playlists.
 *
 * @param {Object} requestBody - The request parameters
 * @param {Array<string>} requestBody.urlList - Array of URLs to process
 * @param {number} [requestBody.chunkSize=config.chunkSize] - Maximum number of concurrent listing operations
 * @param {boolean} [requestBody.sleep=false] - If true, the listing process will sleep between each chunk
 * @param {string} [requestBody.monitoringType="N/A"] - Monitoring type to apply to the playlist or video
 * @param {import('http').ServerResponse} response - The Node.js HTTP response object used to send status and body
 * @returns {Promise<void>} Resolves when listing processes are started
 */

async function processListingRequest(
  requestBody: ListingRequestBody,
  response: ServerResponse,
): Promise<void> {
  try {
    // Validate required parameters
    if (!requestBody.urlList) {
      throw new Error("URL list is required");
    }

    // Extract and normalize parameters
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
      // Normalize URL
      const normalizedUrl = normalizeUrl(url);
      if (uniqueUrls.has(normalizedUrl)) {
        continue; // Skip duplicates
      }

      logger.debug(`Checking URL in database`, { url: normalizedUrl });

      // Look up URL in database as a playlist
      const playlistEntry = await PlaylistMetadata.findOne({
        where: { playlistUrl: normalizedUrl },
      });

      if (playlistEntry) {
        logger.debug(`Playlist found in database`, { url: normalizedUrl });

        if ((playlistEntry as any).monitoringType === monitoringType) {
          logger.debug(`Playlist monitoring hasn't changed so skipping`, {
            url: normalizedUrl,
          });
          safeEmit("listing-playlist-skipped-because-same-monitoring", {
            message: `Playlist ${
              (playlistEntry as any).title
            } is already being monitored with type ${monitoringType}, skipping.`,
          });
          continue; // Skip as it's already monitored
        } else if ((playlistEntry as any).monitoringType !== monitoringType) {
          // If the monitoring type change is Full the reindex the entire playlist,
          // if it is changed to Fast then update from the last index known
          logger.debug(`Playlist monitoring has changed`, {
            url: normalizedUrl,
          });
          itemsToList.push({
            url: normalizedUrl,
            type: "playlist",

            previousMonitoringType: (playlistEntry as any).monitoringType,
            currentMonitoringType: monitoringType,
            reason: `Monitoring type changed`,
          });
        }
      }

      // Look up URL in database as an unlisted video
      const videoEntry = await VideoMetadata.findOne({
        where: { videoUrl: normalizedUrl },
      });
      if (videoEntry) {
        logger.debug(`Video found in database`, { url: normalizedUrl });

        if ((videoEntry as any).downloadStatus) {
          logger.debug(`Video already downloaded`, { url: normalizedUrl });
          safeEmit("listing-video-skipped-because-downloaded", {
            message: `Video ${
              (videoEntry as any).title
            } is already downloaded, skipping.`,
          });
          continue; // Skip as it's already downloaded
        } else {
          logger.debug(`Video not downloaded yet, updating status`, {
            url: normalizedUrl,
          });
          itemsToList.push({
            url: normalizedUrl,
            type: "undownloaded",
            currentMonitoringType: "N/A",
            reason: `Video not downloaded yet`,
          });
        }
      }

      // If URL is not found in either table, add to list for processing
      if (!playlistEntry && !videoEntry) {
        logger.debug(`URL not found in database, adding to list`, {
          url: normalizedUrl,
        });
        itemsToList.push({
          url: normalizedUrl,
          type: "undetermined",
          currentMonitoringType: monitoringType,
          reason: `URL not found in database`,
        });
      }

      // Add to unique URLs set
      uniqueUrls.add(normalizedUrl);
    }

    // Start listing processes
    listItemsConcurrently(itemsToList, chunkSize, false);
    logger.debug(`Listing processes started`, {
      itemCount: itemsToList.length,
    });

    // Send success response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
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
  }
}
/**
 * Lists a given array of items concurrently, controlling the number of concurrent listing operations using a semaphore.
 *
 * @param {Array<Object>} items - Array of items to list, each containing properties:
 *   - url: URL of video or playlist
 *   - type: Type of item (video, playlist, undownloaded, undetermined)
 *   - currentMonitoringType: Current monitoring type of the item
 *   - reason: Reason for the item being added to the list
 * @param {number} chunkSize - Maximum number of concurrent listing operations
 * @param {boolean} isScheduledUpdate - If true, the listing process will update the item
 * @returns {Promise<boolean>} Resolves to true if all listings successful, false otherwise
 */

async function listItemsConcurrently(
  items: ListingItem[],
  chunkSize: number,
  isScheduledUpdate: boolean,
): Promise<ListingResult[]> {
  logger.trace(
    `Listing ${items.length} items concurrently (chunk size: ${chunkSize})`,
  );

  // If no items to list, return
  if (items.length === 0) {
    logger.trace("No items to list");
    return [];
  }

  // Update the semaphore's max concurrent value
  ListingSemaphore.setMaxConcurrent(config.queue.maxListings);

  // Process all items with semaphore control
  // TODO: Fix the issue where if send playlists (since they take long time)
  // the semaphore behavior is not consistent, sometimes it gets un-tracked
  const listingResults = await Promise.all(
    items.map((item) => listWithSemaphore(item, chunkSize, isScheduledUpdate)),
  );

  // Check for any failures  // Log results
  try {
    listingResults.forEach((result) => {
      if (result.status === "completed") {
        logger.info(
          `Listed ${result.title || result.playlistTitle} successfully`,
        );
      } else {
        logger.error(
          `Failed to list ${result.title}: ${JSON.stringify(result)}`,
        );
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
/**
 * Lists a single item with semaphore control to prevent excessive concurrent listing operations.
 *
 * @param {Object} item - Item to list containing properties:
 *   - url: URL of video or playlist
 *   - type: Type of item (video, playlist, undownloaded, undetermined)
 *   - monitoringType: Current monitoring type of the item
 * @param {number} chunkSize - Maximum number of concurrent listing operations
 * @param {boolean} isScheduledUpdate - If true, the listing process will update the item
 * @returns {Promise<Object>} Listing result containing:
 *   - url: Video URL
 *   - title: Video title
 *   - status: 'success' | 'failed'
 *   - error?: Error message if failed
 */

async function listWithSemaphore(
  item: ListingItem,
  chunkSize: number,
  isScheduledUpdate: boolean,
): Promise<ListingResult> {
  logger.trace(`Starting listing with semaphore: ${JSON.stringify(item)}`);

  // Acquire semaphore before starting listing
  await ListingSemaphore.acquire();

  try {
    const { url: videoUrl, type: itemType, currentMonitoringType } = item;

    // Create pending listing entry
    const listEntry = {
      url: videoUrl,
      type: itemType,
      monitoringType: currentMonitoringType,
      lastActivity: Date.now(),
      spawnTimeStamp: null,
      status: "pending",
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    listProcesses.set(entryKey, listEntry);

    // Execute listing process — honour any isScheduledUpdate flag carried on the item
    const result = await executeListing(
      item,
      entryKey,
      chunkSize,
      // I don't remember why item has a isScheduledUpdate property, but I'll keep it for now
      // TODO: Remove it if not needed
      item.isScheduledUpdate === true || isScheduledUpdate,
    );
    // Null out the spawned process as it's completed and we don't want to keep it in logs

    (listEntry as any)["spawnedProcess"] = null;
    logger.trace(`Listing completed`, {
      result: JSON.stringify(result),
      listEntry: JSON.stringify(listEntry),
    });

    // Cleanup pending entry if still exists
    if (listProcesses.has(entryKey)) {
      listProcesses.delete(entryKey);
    }

    return result;
  } finally {
    // Always release semaphore
    ListingSemaphore.release();
  }
}
// so that stalled processes can be cleaned up by the cleanup cron job
/**
 * Executes the listing process for a given item
 *
 * @param {Object} item - The item to list
 * @param {string} processKey - The key to track the listing process
 * @param {number} chunkSize - The size of each chunk to process
 * @param {boolean} isScheduledUpdate - Indicates if the listing is part of a scheduled update
 * @returns {Promise<Object>} The result of the listing process
 */

async function executeListing(
  item: ListingItem,
  processKey: string,
  chunkSize: number,
  isScheduledUpdate: boolean = false,
): Promise<ListingResult> {
  // Allow the item itself to carry the flag (e.g. when called from the scheduler)
  // I don't remember why item has a isScheduledUpdate property, but I'll keep it for now
  // TODO: Remove it if not needed
  const resolvedIsScheduledUpdate = isScheduledUpdate ||
    item.isScheduledUpdate === true;
  logger.debug(`isScheduledUpdate: ${resolvedIsScheduledUpdate}`, {
    item: JSON.stringify(item),
    isScheduledUpdate,
  });
  const { url: videoUrl, currentMonitoringType } = item;
  let itemType = item.type;

  try {
    // Send initial status, if not an update
    if (!resolvedIsScheduledUpdate) {
      safeEmit("listing-started", {
        url: videoUrl,
        type: itemType,
        status: "started",
      });
    }

    // Check if it's a playlist
    const isPlaylist = playlistRegex.test(videoUrl) || itemType === "playlist";
    if (isPlaylist && !isSiteXDotCom(videoUrl)) {
      itemType = "playlist";
    } else {
      itemType = "unlisted";
    }

    let playlistTitle = "";
    let seekPlaylistListTo = 0;

    if (itemType === "playlist") {
      const existingPlaylist = await PlaylistMetadata.findOne({
        where: { playlistUrl: videoUrl },
      });
      if (existingPlaylist) {
        logger.debug(`Playlist already exists in database`, { url: videoUrl });

        if (
          existingPlaylist.getDataValue("monitoringType") ===
            currentMonitoringType && !resolvedIsScheduledUpdate
        ) {
          // Only skip if this is NOT a scheduled update — the scheduler
          // intentionally re-lists playlists that haven't changed type.
          logger.debug(`Playlist monitoring hasn't changed so skipping`, {
            url: videoUrl,
          });
          return handleEmptyResponse(videoUrl);
        } else if (
          existingPlaylist.getDataValue("monitoringType") !==
            currentMonitoringType
        ) {
          logger.debug(`Playlist monitoring has changed`, { url: videoUrl });
          await existingPlaylist.update({
            monitoringType: ["Refresh", "Full"].includes(currentMonitoringType)
              ? "N/A"
              : currentMonitoringType,
            lastUpdatedByScheduler: resolvedIsScheduledUpdate ||
                ["Refresh", "Full"].includes(currentMonitoringType)
              ? Date.now()
              : existingPlaylist.getDataValue("lastUpdatedByScheduler"),
          });
          logger.debug(`Playlist monitoring type updated`, { url: videoUrl });
        } else if (resolvedIsScheduledUpdate) {
          // Same type but triggered by scheduler — just update the timestamp
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
        logger.debug(`Playlist not found in database, adding to database`, {
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
    } else {
      // Unlisted / single video streaming
      return await handleSingleVideoStreaming({
        videoUrl,
        itemType,
        isScheduledUpdate,
        processKey,
      });
    }
  } catch (error) {
    return handleListingError(error as Error, videoUrl, itemType);
  }
}

// Helpers for streaming execution

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

  logger.info(`Starting streaming listing for playlist`, { url: videoUrl });

  // For Full and Refresh modes, clear all existing mappings first so the
  // re-index starts clean.  Downloaded-but-missing videos will be picked up
  // by the periodic prune job and moved to the "None" playlist.
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
  let ytDlpProcess: any;

  try {
    const streamProcessor = streamPlayListItems(
      videoUrl,
      processKey,
      startIndex,
    );
    ytDlpProcess = streamProcessor.process;

    for await (const line of streamProcessor.iterator) {
      absoluteIndexCount++;
      chunkItems.push(line);

      if (chunkItems.length >= chunkSize) {
        // Process the chunk
        const result = await processStreamingVideoInformation(
          chunkItems,
          videoUrl,
          absoluteIndexCount - chunkSize + 1, // startIndex for this chunk
          isScheduledUpdate,
          monitoringType,
        );

        processedChunks++;
        chunkItems = []; // Reset chunk buffer
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

        // If every single item in this chunk already existed, we might want to exit early for 'Start' mode
        if (
          result.alreadyExistedCount === chunkSize && monitoringType === "Start"
        ) {
          consecutiveDuplicateChunks++;
          if (consecutiveDuplicateChunks >= 2) {
            logger.info(
              `Start mode incremental update found 2 consecutive chunks of already existing videos. Terminating stream.`,
              { url: videoUrl },
            );
            // Kill process cleanly to exit stream
            ytDlpProcess.kill("SIGTERM");
            break;
          }
        } else {
          consecutiveDuplicateChunks = 0;
        }
      }
    }

    // Process any remaining items
    if (chunkItems.length > 0) {
      await processStreamingVideoInformation(
        chunkItems,
        videoUrl,
        absoluteIndexCount - chunkItems.length + 1,
        isScheduledUpdate,
        monitoringType,
      );
      processedChunks++;
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
        logger.error(
          "End mode index returned empty. Too many deletions may have occurred. Please remove and re-add the playlist to re-index.",
          { url: videoUrl },
        );
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
    // Code 143 or null indicates we killed it natively via SIGTERM
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

    // For single videos going into the "None" playlist, check if a mapping
    // already exists to prevent duplicates when the same URL is added again.
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
      // Re-use the existing position so processStreamingVideoInformation
      // sees it as an "already existed" record and just updates metadata.
      newStartIndex = existingMapping.getDataValue(
        "positionInPlaylist",
      ) as number;
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

/**
 * Spawns an unending yt-dlp process to stream playlist/video information
 * @param {string} videoUrl - URL to fetch information from
 * @param {string} processKey - Unique key for the process
 * @param {number} startIndex - Playist item start index (default 1)
 * @returns {Object} An object containing the un-finished process and an async iterator representing the lines
 */
function streamPlayListItems(
  videoUrl: string,
  processKey: string,
  startIndex: number = 1,
): { process: ReturnType<typeof spawn>; iterator: AsyncGenerator<string> } {
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

  const listProcess = spawn("python3", [
    "-c",
    YT_DLP_PATCHED_CMD,
    ...processArgs,
  ]);
  const processEntry = listProcesses.get(processKey);

  if (processEntry) {
    processEntry.spawnedProcess = listProcess;
    processEntry.status = "running";
    processEntry.spawnTimeStamp = Date.now();
    processEntry.lastActivity = Date.now();
    listProcesses.set(processKey, processEntry);
  } else {
    logger.error(`Process entry not found: ${processKey}`);
    throw new Error(`Process entry not found: ${processKey}`);
  }

  listProcess.stderr.setEncoding("utf8");
  listProcess.stderr.on("data", (data) => {
    logger.error("List process error", {
      error: data,
      pid: listProcess.pid,
    });
    updateProcessActivity(processKey);
  });

  let _exitStatus: number | null = null;
  let exitCodePromiseResolve: ((code: number | null) => void) | null = null;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    exitCodePromiseResolve = resolve;
  });

  listProcess.on("close", (code) => {
    _exitStatus = code;
    logger.debug("List process closed", {
      pid: listProcess.pid,
      code: code,
    });
    if (exitCodePromiseResolve) exitCodePromiseResolve(code);
  });

  async function* lineIterator() {
    const rl = createInterface({
      input: listProcess.stdout,
      crlfDelay: Infinity,
    });

    let linesYielded = 0;
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          updateProcessActivity(processKey);
          linesYielded++;
          yield trimmed;
        }
      }

      // Wait for exit code to ensure no unexpected failures happened, but only if we didn't deliberately kill it
      const exitCode = listProcess.killed ? null : await exitCodePromise;
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
      if (!listProcess.killed) listProcess.kill();
      throw error;
    }
  }

  return {
    process: listProcess,
    iterator: lineIterator(),
  };
}

/**
 * Processes video information and updates database records using streaming absolute indices
 */
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

  // Batch process parsing and metadata extraction
  const parsedItems = responseItems.map((item, index): ParsedStreamItem | null => {
    try {
      const itemData = JSON.parse(item) as StreamedItemData;
      const videoUrl = itemData.webpage_url || itemData.url || "";

      // Extract online thumbnail before pruning
      // Skip ephemeral thumbnails (FB/IG signed CDN URLs expire in hours)
      const onlineThumbnail = hasEphemeralThumbnails(videoUrl)
        ? null
        : (itemData.thumbnail || null);

      // Prune bulky arrays from yt-dlp JSON to reduce storage size
      // (~62KB -> ~12KB per video)
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
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  if (parsedItems.length === 0) return result;

  const videoUrls = parsedItems.map((parsedItem) => parsedItem.videoUrl);

  // Fetch all existing meta and mappings for the chunk
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
  // Key by "videoUrl|positionInPlaylist" so that duplicate videos at different
  // positions (allowed by the schema) each get their own map entry.
  const existingMappingsMap = new Map<string, Model>(
    existingMappings.map((mapping) =>
      [
        `${mapping.getDataValue("videoUrl")}|${
          mapping.getDataValue("positionInPlaylist")
        }`,
        mapping,
      ]
    ),
  );
  // Secondary lookup by videoUrl only — used by Start/End modes to find a
  // mapping at a *different* position so we update it instead of creating a dupe.
  const existingMappingsByUrl = new Map<string, Model>(
    existingMappings.map((mapping) =>
      [
        mapping.getDataValue("videoUrl") as string,
        mapping,
      ]
    ),
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
    const existingMapping = existingMappingsMap.get(
      `${videoUrl}|${absoluteIndex}`,
    );

    // Fast skip logic for unchanged records
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
      title: await truncateText(
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
      // Before creating a new mapping, check if this video already has a
      // mapping at a different position in the same playlist (position drift
      // during Start/End incremental updates).  If so, update it instead.
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
    } else if (
      existingMapping.getDataValue("positionInPlaylist") !== absoluteIndex
    ) {
      if (existingMapping.getDataValue("positionInPlaylist") > absoluteIndex) {
        logger.warn(
          "Video index decreased. Previous videos in the playlist may have been deleted.",
          {
            url: videoUrl,
            currentIndex: absoluteIndex,
            oldIndex: existingMapping.getDataValue("positionInPlaylist"),
          },
        );
      }
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

  // Execute bulk DB operations
  if (videosToUpsert.length > 0) {
    // Deduplicate by videoUrl: a playlist can contain the same video at multiple
    // positions. PostgreSQL's ON CONFLICT DO UPDATE cannot touch the same row
    // twice in a single statement, so we keep only the last occurrence per URL.
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
    // Sequential updates for drifter positions to avoid complexity,
    // but these are typicaly few compared to total items.
    await Promise.all(
      mappingsToUpdate.map((m) =>
        m.instance.update({ positionInPlaylist: m.position })
      ),
    );
  }

  return result;
}
/**
 * Discovers metadata files associated with a downloaded video
 * @param {string} mainFileName - The main video file name
 * @param {string} savePath - Directory where files are saved
 * @param {object} videoEntry - The video entry in the database
 * @returns {object} Object containing paths to discovered metadata files and sync status
 */

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

  // Track which files were expected vs found
  const syncStatus: FileSyncStatus = {
    videoFileFound: false,
    descriptionFileFound: !config.saveDescription,
    commentsFileFound: !config.saveComments,
    subTitleFileFound: !config.saveSubs,
    thumbNailFileFound: !config.saveThumbnail,
  };

  // If a file is being re-downloaded/updated, mainFileName will be null
  if (!mainFileName) {
    logger.debug("No main file name provided for metadata discovery");
    // Check if video is already downloaded, and if it has a download status as true
    if (videoEntry && videoEntry.downloadStatus) {
      mainFileName = videoEntry.fileName ?? null;
      logger.debug("Using main file name from database", { mainFileName });
    } else {
      logger.debug("No main file name found in database");
      return { metadata, syncStatus };
    }
  }

  try {
    const mainFileExt = path.extname(mainFileName!).toLowerCase();
    const mainFileBase = mainFileName!.replace(mainFileExt, "");
    logger.debug("Scanning savePath for extra metadata files", {
      savePath,
      mainFileBase,
    });

    // Define extension patterns for each file type
    const patterns = {
      video: [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".m4v"],
      description: [".description"],
      comments: [".info.json"],
      subtitle: [".vtt", ".srt"], // There can be languages too
      thumbnail: [".webp", ".jpg", ".jpeg", ".png"],
    };

    // Optimistically check for known file patterns first
    const checkFile = (baseName: string, extensions: string[]) => {
      for (const ext of extensions) {
        const filePath = path.join(savePath, baseName + ext);
        if (fs.existsSync(filePath)) {
          return baseName + ext;
        }
      }
      return null;
    };

    // Try to find each metadata file optimistically
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
      // Try common subtitle patterns: baseName.ext and baseName.lang.ext
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
        ...patterns.subtitle, // Direct patterns: baseName.vtt, baseName.srt
        ...commonLanguages.flatMap((lang) =>
          patterns.subtitle.map((ext) => `.${lang}${ext}`)
        ), // Language patterns: baseName.en.vtt, baseName.fr.srt, etc.
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

    // Check if the initially found file extension was for the video
    if (mainFileExt && patterns.video.includes(mainFileExt)) {
      // This way the likely hood of finding it in the first iteration is very high
      patterns.video = [
        mainFileExt,
        ...patterns.video.filter((ext) => ext !== mainFileExt),
      ];
    }
    // Find video file - check common extensions first, then fallback to directory scan
    const videoFile = checkFile(mainFileBase, patterns.video);
    if (videoFile) {
      metadata.fileName = videoFile;
      syncStatus.videoFileFound = true;
      logger.trace("Found video file", { file: videoFile });
    } else {
      // Fallback: scan directory for video file with unknown extension
      logger.trace(
        "Video file not found with common extensions, scanning directory",
      );
      const files = fs.readdirSync(savePath);

      // Filter out only the ones we need
      const filesOfInterest = files.filter((file) =>
        file.startsWith(mainFileBase)
      );

      // Look for the video file - any file starting with mainFileBase that isn't a known metadata file
      const knownMetadataExts = [
        ...patterns.description,
        ...patterns.comments,
        ...patterns.subtitle,
        ...patterns.thumbnail,
      ];

      for (const file of filesOfInterest) {
        // If it's not a known metadata extension, assume it's the video file
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
/**
 * Computes the save directory relative to the configured save location
 * @param {string} savePath - The configured save location
 * @returns {string} Relative save directory
 */
function computeSaveDirectory(savePath: string) {
  try {
    let saveDir = path.relative(
      path.resolve(config.saveLocation),
      path.resolve(savePath),
    );

    // Normalize: convert "." to empty string
    if (saveDir === path.sep || saveDir === ".") {
      saveDir = "";
    }

    // Remove leading separator
    if (saveDir.startsWith(path.sep)) {
      saveDir = saveDir.slice(1);
    }

    // Remove trailing separator
    if (saveDir.endsWith(path.sep)) {
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
/**
 * Handles the case where no items are found for a given video URL.
 * Emits a "listing-error" event with the error details and returns an error response object.
 *
 * @param {string} videoUrl - The URL of the video for which no items were found.
 * @returns {Object} An object containing the video URL, a default title, status as "failed",
 *                   and an error message indicating no items were found.
 */
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
/**
 * Handles errors that occur during the listing process for a video or playlist.
 *
 * @param {Error} error - The error object containing details about the failure.
 * @param {string} videoUrl - The URL of the video or playlist that failed to list.
 * @param {string} itemType - The type of item being listed, either "playlist" or "video".
 * @returns {Object} An object containing details about the failed listing, including the URL, title, status, and error message.
 */
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
/**
 * Handles completion of playlist listing process and emits completion events
 *
 * @param {string} videoUrl - URL of the playlist that was processed
 * @param {number} processedChunks - Number of chunks that were processed
 * @param {string} playlistTitle - Title of the playlist
 * @param {number} seekPlaylistListTo - Position in the playlist list to seek to
 * @param {boolean} isScheduledUpdate - Whether the listing was triggered by a scheduler
 * @returns {Object} Object containing url, title, status and processed chunk count
 */
function completePlaylistListing(
  videoUrl: string,
  processedChunks: number,
  playlistTitle: string,
  seekPlaylistListTo: number,
  isScheduledUpdate: boolean,
) {
  // Log completion
  logger.info(`Playlist listing completed`, {
    url: videoUrl,
    processedChunks,
    playlistTitle,
    seekPlaylistListTo,
  });

  // Emit completion event
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

  // Return completion status
  return {
    url: videoUrl,
    type: "Playlist",
    status: "completed",
    processedChunks,
    playlistTitle,
    seekPlaylistListTo,
  };
}
/**
 * Updates video metadata in database if changes detected
 *
 * @param {Object} existingVideo - Current video record from database
 * @param {Object} newData - New video data to compare against
 * @param {string} newData.videoId - Video ID
 * @param {number} newData.approximateSize - Approximate file size
 * @param {string} newData.title - Video title
 * @param {boolean} newData.isAvailable - Video availability status
 * @returns {Promise<void>} Resolves when update complete
 */

async function _updateVideoMetadata(
  existingVideo: VideoEntryRecord,
  newData: VideoEntrySnapshot,
): Promise<void> {
  logger.trace("Checking video metadata for updates", {
    oldData: JSON.stringify(existingVideo),
    newData: JSON.stringify(newData),
  });

  const differences = [];
  let requiresUpdate = false;

  // Check for differences
  if (existingVideo.videoId !== newData.videoId) {
    differences.push({
      field: "videoId",
      old: existingVideo.videoId,
      new: newData.videoId,
    });
    requiresUpdate = true;
  }

  if (+existingVideo.approximateSize !== +newData.approximateSize) {
    differences.push({
      field: "approximateSize",
      old: existingVideo.approximateSize,
      new: newData.approximateSize,
    });
    requiresUpdate = true;
  }

  if (existingVideo.title !== newData.title) {
    differences.push({
      field: "title",
      old: existingVideo.title,
      new: newData.title,
    });
    requiresUpdate = true;
  }

  if (existingVideo.isAvailable !== newData.isAvailable) {
    differences.push({
      field: "isAvailable",
      old: existingVideo.isAvailable,
      new: newData.isAvailable,
    });
    requiresUpdate = true;
  }

  // Perform update if needed
  if (requiresUpdate) {
    logger.warn("Video metadata changes detected", {
      differences: JSON.stringify(differences),
    });

    Object.assign(existingVideo, {
      videoId: newData.videoId,
      approximateSize: +newData.approximateSize,
      title: newData.title,
      isAvailable: newData.isAvailable,
    });

    await existingVideo.save();
    logger.debug("Video metadata updated successfully");
  } else {
    logger.trace("No video metadata updates needed");
  }
}
/**
 * Updates the monitoring type for a playlist in the database
 *
 * @param {Object} requestBody - Request parameters
 * @param {string} requestBody.url - Playlist URL to update
 * @param {string} requestBody.watch - New monitoring type value
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when monitoring type is updated
 * @throws {Error} If required parameters are missing or update fails
 */

/**
 * Adds a new playlist to the database with metadata from yt-dlp
 *
 * @param {string} playlistUrl - The URL of the playlist
 * @param {string} monitoringType - The type of monitoring to apply
 * @return {Promise<void>} Resolves when playlist is added to database
 * @throws {Error} If playlist creation fails or max listing processes reached
 */
async function addPlaylist(playlistUrl: string, monitoringType: string) {
  let playlistTitle = "";
  // Initialize the counter from DB on first call, then increment atomically.
  // We use a Promise to ensure concurrent callers wait for the same initialization
  // instead of racing to query the database multiple times.
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
  // Playlist are not something that exists on x.com but a post can have
  // multiple videos so we need to use cookies for those links,
  // The listed videos will all have the same link with a different id
  // which this code can't handle yet, you will get only one item in the
  // playlist generated from it (hopefully the first one) but downloading that
  // will make yt-dlp get the rest of the items in the post, check the folder.
  const siteArgs = buildSiteArgs(playlistUrl, config);
  if (siteArgs.length > 0) {
    processArgs.unshift(...siteArgs);
  }

  const fullCommandString = [
    "yt-dlp",
    ...processArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)), // quote args with spaces
  ].join(" ");
  logger.debug("Trying to get playlist title", {
    url: playlistUrl,
    fullCommand: fullCommandString,
  });
  // Spawn process to get playlist title
  const titleProcess = spawn("python3", [
    "-c",
    YT_DLP_PATCHED_CMD,
    ...processArgs,
  ]);

  return new Promise((resolve, reject) => {
    // Handle stdout
    titleProcess.stdout.setEncoding("utf8");
    titleProcess.stdout.on("data", (data) => {
      playlistTitle += data;
    });

    // Handle stderr
    titleProcess.stderr.setEncoding("utf8");
    titleProcess.stderr.on("data", (data) => {
      logger.error(`Error getting playlist title: ${data}`);
    });

    // Handle process errors
    titleProcess.on("error", (error) => {
      logger.error(`Title process error: ${error.message}`);
      reject(error);
    });

    // Handle process completion
    titleProcess.on("close", async (code) => {
      try {
        if (code !== 0) {
          logger.error(`Title process failed with code: ${code}`);
          throw new Error("Failed to get playlist title");
        }

        // Handle empty or NA title
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
          try {
            playlistTitle = await urlToTitle(playlistUrl);
          } catch (error) {
            logger.error(
              `Failed to get title from URL: ${(error as Error).message}`,
            );
            playlistTitle = playlistUrl;
          }
        }

        // Trim title to max length
        playlistTitle = await truncateText(
          playlistTitle,
          config.maxTitleLength,
        );
        logger.debug(`Creating playlist with title: ${playlistTitle}`, {
          url: playlistUrl,
          pid: titleProcess.pid,
          code: code,
          monitoringType: monitoringType,
          lastUpdatedByScheduler: Date.now(),
        });

        // Create playlist entry
        const [playlist, created] = await PlaylistMetadata.findOrCreate({
          where: { playlistUrl: playlistUrl },
          defaults: {
            title: playlistTitle.trim(),
            monitoringType: monitoringType,
            saveDirectory: playlistTitle.trim(),
            // Order in which playlists are displayed or Index
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
    });
  });
}

// Delete
/**
 * Handles deletion of playlists and their associated data
 *
 * @param {Object} requestBody - Body of the request containing parameters
 * @param {string} requestBody.playListUrl - URL of the playlist to delete (required)
 * @param {boolean} requestBody.deleteAllVideosInPlaylist - Whether to delete all video mappings
 * @param {boolean} requestBody.deletePlaylist - Whether to delete the playlist itself
 * @param {boolean} requestBody.cleanUp - Whether to clean up the playlist directory
 * @param {http.ServerResponse} response - HTTP response object
 * @returns {Promise<void>} Resolves when deletion is complete
 */

// Functions to run the server
/**
 * Generates CORS headers with content type
 *
 * @param {string} contentType - MIME type for Content-Type header
 * @param {Object} [options] - Additional options
 * @param {string[]} [options.allowedOrigins] - Allowed origins, defaults to CORS_ALLOWED_ORIGINS
 * @param {string[]} [options.allowedMethods] - Allowed HTTP methods
 * @param {number} [options.maxAge] - Cache max age in seconds
 * @returns {Object} Object containing CORS headers
 */
function generateCorsHeaders(
  contentType: string,
  {
    allowedOrigins = CORS_ALLOWED_ORIGINS,
    allowedMethods = CORS_ALLOWED_HEADERS,
    maxAge = config.defaultCORSMaxAge,
  } = {},
) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.join(", "),
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": maxAge,
    "Content-Type": contentType,
  };
}

/**
 * Recursively retrieves a list of files and their corresponding extensions from a given directory.
 *
 * @param {string} dir - The directory path to start retrieving files from.
 * @return {Array<{filePath: string, extension: string}>} An array of objects containing the file path and extension of each file found in the directory and its subdirectories.
 */
function getFiles(dir: string): Array<{ filePath: string; extension: string }> {
  const files = fs.readdirSync(dir);
  let fileList: Array<{ filePath: string; extension: string }> = [];

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const extension = path.extname(filePath);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      fileList = fileList.concat(getFiles(filePath));
    } else {
      fileList.push({ filePath, extension });
    }
  });

  return fileList;
}

/**
 * Generates a dictionary of static assets from a list of file objects.
 *
 * @param {Array<{filePath: string, extension: string}>} fileList - The list of file objects containing the file path and extension.
 * @return {Object<string, {file: Uint8Array, type: string}>} - The dictionary of static assets, where the key is the file path and the value is an object containing the file content and its type.
 */
function makeAssets(fileList: Array<{ filePath: string; extension: string }>) {
  const staticAssets: Record<string, { file: Uint8Array | string; type: string }> =
    {};
  fileList.forEach((element) => {
    staticAssets[element.filePath.replace("dist", config.urlBase)] = {
      file: fs.readFileSync(element.filePath),
      type: MIME_TYPES[element.extension],
    };
  });
  staticAssets[`${config.urlBase}/`] =
    staticAssets[`${config.urlBase}/index.html`];
  staticAssets[config.urlBase] = staticAssets[`${config.urlBase}/index.html`];
  staticAssets[`${config.urlBase}/.gz`] =
    staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}.gz`] =
    staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}/.br`] =
    staticAssets[`${config.urlBase}/index.html.br`];
  staticAssets[`${config.urlBase}.br`] =
    staticAssets[`${config.urlBase}/index.html.br`];
  staticAssets[`${config.urlBase}/ping`] = {
    file: "pong",
    type: MIME_TYPES[".txt"],
  };
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets: Record<string, StaticAsset> = makeAssets(filesList);
let serverOptions = {};
let serverObj = null;

if (config.nativeHttps) {
  try {
    serverOptions = {
      key: fs.readFileSync(config.ssl.key as string, "utf8"),
      cert: fs.readFileSync(config.ssl.cert as string, "utf8"),
      // If passphrase is not set, don't include it in options
      ...(config.ssl.passphrase && { passphrase: config.ssl.passphrase }),
    };
  } catch (error) {
    logger.error("Error reading SSL key and/or certificate files:", {
      error: (error as Error).message,
    });
    Deno.exit(1);
  }
  if (config.ssl.passphrase) {
    logger.info("SSL passphrase is set");
  }
  if (config.protocol === "http") {
    logger.warn(
      "Protocol is set to HTTP but nativeHttps is enabled. Overriding protocol to HTTPS.",
    );
    config.protocol = "https";
  }
  logger.info("Starting server in HTTPS mode");
  serverObj = https;
} else {
  if (config.protocol === "https") {
    logger.warn(
      "Protocol is set to HTTPS but nativeHttps is disabled. Overriding protocol to HTTP.",
    );
    config.protocol = "http";
  }
  logger.info("Starting server in HTTP mode");
  serverObj = http;
}

const server = (serverObj as any).createServer(
  serverOptions,
  async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url && req.url.startsWith(config.urlBase) && req.method === "GET") {
      try {
        const reqEncoding = req.headers["accept-encoding"] || "";
        logger.trace(`Request Received`, {
          url: req.url,
          method: req.method,
          encoding: reqEncoding,
        });
        if (
          await tryServeSignedFile(req, res, {
            redis,
            cacheMaxAge: config.cache.maxAge,
            mimeTypes: MIME_TYPES,
            generateCorsHeaders,
            pipelineAsync,
            htmlMimeType: MIME_TYPES[".html"],
          })
        ) {
          return;
        }

        if (
          serveStaticAsset(req, res, {
            staticAssets,
            generateCorsHeaders,
            htmlMimeType: MIME_TYPES[".html"],
          })
        ) {
          return;
        }
      } catch (error) {
        logger.error("Error in processing request", {
          url: req.url,
          method: req.method,
          error: error as Error,
        });
        res.writeHead(404, generateCorsHeaders(MIME_TYPES[".html"]));
        res.write("Not Found");
      }
      res.end();
    } else if (req.method === "OPTIONS") {
      // necessary for cors
      res.writeHead(204, generateCorsHeaders(MIME_TYPES[".json"]));
      res.end();
    } else if (req.method === "HEAD") {
      // necessary for health check
      res.writeHead(204, generateCorsHeaders(MIME_TYPES[".json"]));
      res.end();
    } else if (req.method === "POST") {
      if (dispatchRoute(req, res, apiRoutes)) {
        return;
      }

      logger.error("Requested Resource couldn't be found", {
        url: req.url,
        method: req.method,
      });
      res.writeHead(404, generateCorsHeaders(MIME_TYPES[".html"]));
      res.write("Not Found");
      res.end();
    } else {
      logger.error("Requested Resource couldn't be found", {
        url: req.url,
        method: req.method,
      });
      res.writeHead(404, generateCorsHeaders(MIME_TYPES[".html"]));
      res.write("Not Found");
      res.end();
    }
  },
);

const { io: _io, sock } = createSocketServer({
  server,
  corsAllowedOrigins: CORS_ALLOWED_ORIGINS,
  authenticateSocket,
  redis,
});

const apiRoutes = createApiRoutes({
  authenticateRequest,
  authenticateUser,
  isRegistrationAllowed,
  rateLimit,
  registerUser,
  processListingRequest: (data, res) =>
    processListingRequest(data as ListingRequestBody, res),
  processDownloadRequest: (data, res) =>
    processDownloadRequest(
      data as { urlList: string[]; playListUrl?: string },
      res,
    ),
  updatePlaylistMonitoring: (data, res) =>
    updatePlaylistMonitoring(data as UpdatePlaylistMonitoringRequest, res),
  getPlaylistsForDisplay: (data, res) =>
    getPlaylistsForDisplay(data as PlaylistDisplayRequest, res),
  processDeletePlaylistRequest: (data, res) =>
    processDeletePlaylistRequest(data as DeletePlaylistRequestBody, res),
  getSubListVideos: (data, res) => getSubListVideos(data as SubListRequest, res),
  processDeleteVideosRequest: (data, res) =>
    processDeleteVideosRequest(data as DeleteVideosRequestBody, res),
  makeSignedUrl: (data, res) => makeSignedUrl(data as SignedFileRequestBody, res),
  refreshSignedUrl: (data, res) =>
    refreshSignedUrl(data as RefreshSignedUrlRequestBody, res),
  makeSignedUrls: (data, res) =>
    makeSignedUrls(data as BulkSignedFilesRequestBody, res),
  processReindexAllRequest: (data, res) =>
    processReindexAllRequest(data as ReindexAllRequestBody, res),
});

const jobs = createJobs({
  cleanupStaleProcesses,
  downloadProcesses: downloadProcesses as Map<string, any>,
  listProcesses: listProcesses as Map<string, any>,
  listItemsConcurrently,
});

server.listen(config.port, async () => {
  if (config.hidePorts) {
    logger.info(
      `Server listening on ${config.protocol}://${config.host}${config.urlBase}`,
    );
  } else {
    logger.info(
      `Server listening on ${config.protocol}://${config.host}:${config.port}${config.urlBase}`,
    );
  }
  // I do not really know if calling these here is a good idea, but how else can I even do it?
  const start = Date.now();
  await sleep();
  const elapsed = Date.now() - start;
  logger.info("Sleep duration: " + elapsed / 1000 + " seconds");
  logger.debug(
    `Download Options: yt-dlp ${downloadOptions.join(" ")} --paths "${
      config.saveLocation.endsWith("/")
        ? config.saveLocation
        : config.saveLocation + "/"
    }` +
      `{playlist_dir}" "{url}"`,
  );
  logger.debug(
    "List Options: yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --dump-json --no-download {bodyUrl}",
  );
  startJobs(jobs);
});
