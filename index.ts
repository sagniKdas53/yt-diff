/// <reference lib="deno.ns" />
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Redis } from "ioredis";

import { type AppConfig, config, YT_DLP_PATCHED_CMD } from "./src/config.ts";
import { initializeDatabase } from "./src/db/models.ts";
import {
  type AppEventMap,
  type AppEventName,
  appEvents,
  isAppEventName,
} from "./src/events.ts";
import { createFileHandlers } from "./src/handlers/files.ts";
import { createPlaylistHandlers } from "./src/handlers/playlists/index.ts";
import {
  createPipelineHandlers,
  downloadOptions,
  playlistRegex,
  type ProcessLike,
  type SiteArgBuilder,
} from "./src/handlers/pipeline/index.ts";
import {
  isSiteIwaraDotTv,
  isSiteXDotCom,
  isSiteYouTube,
  normalizeUrl,
} from "./src/utils/url.ts";
import { createBotService } from "./src/bot/index.ts";
import {
  processDedupPlaylistsRequest,
  processDedupUnlistedRequest,
} from "./src/handlers/pipeline/dedup.ts";
import { createJobs, startJobs } from "./src/jobs/index.ts";
import { logger } from "./src/logger.ts";
import { createAuthMiddleware } from "./src/middleware/auth.ts";
import { createRateLimit } from "./src/middleware/rateLimit.ts";
import {
  BulkRefreshSignedUrlsRequestBodySchema,
  BulkSignedFilesRequestBodySchema,
  DedupRequestBodySchema,
  DeletePlaylistRequestBodySchema,
  DeleteVideosRequestBodySchema,
  DownloadRequestBodySchema,
  ListingRequestBodySchema,
  PlaylistDisplayRequestSchema,
  QueueStatusRequestBodySchema,
  RefreshSignedUrlRequestBodySchema,
  ReindexAllRequestBodySchema,
  SignedFileRequestBodySchema,
  SubListRequestSchema,
  UpdatePlaylistMonitoringRequestSchema,
  validateBody,
} from "./src/middleware/validator.ts";
import { createApiRoutes } from "./src/routes/api.ts";
import { dispatchRoute } from "./src/routes/http.ts";
import { getSignedFileMetadata } from "./src/routes/helpers/getSignedFileMetadata.ts";
import { tryServeNativeFile } from "./src/routes/helpers/serveNativeFile.ts";
import {
  serveStaticAsset,
  type StaticAsset,
} from "./src/routes/helpers/serveStaticAsset.ts";
import { createSocketServer } from "./src/socket/index.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readTextFileSync,
  statSync,
} from "./src/utils/fs.ts";
import { extname, join } from "./src/utils/path.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "./src/transport/http.ts";
import {
  handleNodeStyleRequest,
  proxyHttpRequest,
  proxyWebSocketRequest,
} from "./src/transport/denoHttp.ts";
import {
  CORS_ALLOWED_ORIGINS,
  generateCorsHeaders,
  MIME_TYPES,
  SIGNED_FILE_CSP,
} from "./src/utils/http.ts";

logger.info("Logger initialized", { logLevel: config.logLevel });
if (config.secretKey instanceof Error) {
  logger.error("Configuration error", { error: config.secretKey });
  throw config.secretKey;
}
if (config.db.password instanceof Error) {
  logger.error("Configuration error", { error: config.db.password });
  throw config.db.password;
}

const connectionGeneration = Date.now();

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
if (!existsSync(config.saveLocation)) {
  logger.info("Save location doesn't exists", {
    saveLocation: config.saveLocation,
  });
  try {
    logger.info("Creating save location", {
      saveLocation: config.saveLocation,
    });
    mkdirSync(config.saveLocation, { recursive: true });
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

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password ?? undefined,
});

redis.on("error", (err: Error) => {
  logger.error("Redis error", { error: err.message });
});

redis.on("connect", () => {
  logger.info("Connected to Redis");
});

/**
 * Safely emit socket.io events if socket server is available, then fan the same
 * event out to the in-process bus.
 *
 * Wraps emit calls in try/catch to avoid crashing the process when socket is not ready.
 * The bus fan-out sits outside that catch so a socket failure cannot starve
 * server-side consumers, and it swallows handler errors itself.
 *
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

  // Events the bus does not model (socket-only UI chatter) are ignored.
  if (isAppEventName(event)) {
    appEvents.emit(event, payload as AppEventMap[AppEventName]);
  }
}

interface ManagedProcess {
  pid: number;
  readonly killed: boolean;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): boolean;
}

function spawnPythonProcess(args: string[]): ManagedProcess {
  const child = new Deno.Command("python3", {
    args: ["-c", YT_DLP_PATCHED_CMD, ...args],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let wasKilled = false;

  return {
    pid: child.pid,
    get killed() {
      return wasKilled;
    },
    stdout: child.stdout,
    stderr: child.stderr,
    status: child.status,
    kill(signal: Deno.Signal = "SIGTERM") {
      try {
        wasKilled = true;
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function* streamTextChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        yield decoder.decode(value, { stream: true });
      }
    }
    const trailing = decoder.decode();
    if (trailing) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamLines(stream: ReadableStream<Uint8Array>) {
  let buffered = "";
  for await (const chunk of streamTextChunks(stream)) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffered.indexOf("\n");
    }
  }

  const trailing = buffered.trim();
  if (trailing.length > 0) {
    yield trailing;
  }
}

// Retained so bootstrap can wait for the schema (and the BotSubmission table)
// before starting anything that writes to it.
const dbReady = initializeDatabase();
dbReady.catch(() => {
  // initializeDatabase already logs; this only stops an unhandled rejection
  // while the promise is awaited later in bootstrapRuntime.
});

// Utility functions
/**
 * Pauses execution for specified duration
 *
 * @param {number} [seconds=config.sleepTime] - Duration to sleep in seconds
 * @returns {Promise<void>} Resolves after sleep completes
 */
async function sleep(seconds = Number(config.sleepTime)) {
  logger.trace(`Sleeping for ${seconds} seconds`);

  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const duration = (Date.now() - start) / 1000;

  logger.trace(`Sleep completed after ${duration} seconds`);
}
// Site specific argument builders

const siteArgBuilders: SiteArgBuilder[] = [
  // x.com
  // Priority: X_COOKIES_FILE → COOKIES_FILE (global fallback)
  (url, config) => {
    if (isSiteXDotCom(url)) {
      const cookiesFile = Deno.env.get("X_COOKIES_FILE") || config.cookiesFile;
      if (cookiesFile && typeof cookiesFile === "string") {
        logger.debug(`Using cookies file for x.com: ${cookiesFile}`);
        return ["--cookies", cookiesFile];
      }
    }
    return [];
  },
  // youtube.com — needed for private playlists (Watch Later, Liked Videos)
  // that the YouTube Data API cannot access
  // Priority: YOUTUBE_COOKIES_FILE → COOKIES_FILE (global fallback)
  (url, config) => {
    if (isSiteYouTube(url)) {
      const cookiesFile = Deno.env.get("YOUTUBE_COOKIES_FILE") ||
        config.cookiesFile;
      if (cookiesFile && typeof cookiesFile === "string") {
        logger.debug(`Using cookies file for YouTube: ${cookiesFile}`);
        return ["--cookies", cookiesFile];
      }
    }
    return [];
  },
  // iwara.tv
  (url, config) => {
    if (isSiteIwaraDotTv(url)) {
      const args = [];
      //["--impersonate", "Chrome-133"];
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

export function buildSiteArgs(url: string, config: AppConfig): string[] {
  const args = siteArgBuilders.flatMap((builder) => builder(url, config));
  // Skip proxy for iwara.tv — Cloudflare blocks VPN/datacenter IPs,
  // causing 503 tunnel failures. Iwara works fine via direct connection.
  // I have figured out how to bypass CF alltogether but this proxy only works
  // for iwara and x.com, so special dispensation for these for now.
  if (config.proxy_string && (isSiteIwaraDotTv(url) || isSiteXDotCom(url))) {
    args.push("--proxy", config.proxy_string as string);
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
    { expiresIn: expiryDuration as jwt.SignOptions["expiresIn"] },
  );
}
function emitTokenExpired(payload: { error: string }) {
  sock.emit("token-expired", payload);
}

const {
  authenticateRequest,
  authenticateSocket,
  authenticateUser,
  isRegistrationAllowed,
  refreshAuthToken,
  registerUser,
} = createAuthMiddleware({
  redis,
  generateAuthToken,
  hashPassword,
  emitTokenExpired,
});

const rateLimit = createRateLimit({
  redis,
});

const {
  createSignedUrlForPath,
  makeSignedUrl,
  makeSignedUrls,
  refreshSignedUrl,
  refreshSignedUrls,
} = createFileHandlers({
  redis,
});

const {
  cleanupStaleProcesses,
  downloadProcesses,
  listProcesses,
  listItemsConcurrently,
  processDownloadRequest,
  processListingRequest,
  resolveAndEnqueue,
  getQueueSnapshot,
  resetPendingPlaylistSortCounter,
  getListingQueueDepth,
} = createPipelineHandlers({
  safeEmit,
  buildSiteArgs,
  spawnPythonProcess,
  streamTextChunks,
  streamLines,
});

function terminateChildProcesses() {
  logger.info("Cleaning up active subprocesses before shutdown...");
  for (const proc of downloadProcesses.values()) {
    if (proc.spawnedProcess && typeof proc.spawnedProcess.kill === "function") {
      try {
        proc.spawnedProcess.kill("SIGKILL");
      } catch (_e) {
        // ignore
      }
    }
  }
  for (const proc of listProcesses.values()) {
    if (proc.spawnedProcess && typeof proc.spawnedProcess.kill === "function") {
      try {
        proc.spawnedProcess.kill("SIGKILL");
      } catch (_e) {
        // ignore
      }
    }
  }
}

/**
 * Stops the bot, then kills child processes, then exits.
 *
 * The bot is stopped first so long-polling is torn down before its in-flight
 * downloads are killed; the exit is capped by a timer so a hung adapter cannot
 * prevent shutdown.
 */
function shutdown() {
  const exit = () => {
    terminateChildProcesses();
    Deno.exit(0);
  };
  const failsafe = setTimeout(exit, 5000);
  botService.stop()
    .catch((error: unknown) => {
      logger.warn("Bot did not stop cleanly", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    })
    .finally(() => {
      clearTimeout(failsafe);
      exit();
    });
}

try {
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
} catch (error) {
  logger.warn("Failed to register signal listeners (non-POSIX platform?)", {
    error: (error as Error).message,
  });
}

const {
  updatePlaylistMonitoring,
  processDeletePlaylistRequest,
  processReindexAllRequest,
  processDeleteVideosRequest,
  getPlaylistsForDisplay,
  getSubListVideos,
} = createPlaylistHandlers({
  listItemsConcurrently,
  resetPendingPlaylistSortCounter,
  safeEmit,
});
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

function processQueueStatusRequest(
  _data: unknown,
  res: HttpResponseLike,
) {
  res.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
  res.end(
    JSON.stringify({
      status: "success",
      generation: connectionGeneration,
      queue: getQueueSnapshot(),
    }),
  );
}

// Functions to run the server

/**
 * Recursively retrieves a list of files and their corresponding extensions from a given directory.
 *
 * @param {string} dir - The directory path to start retrieving files from.
 * @return {Array<{filePath: string, extension: string}>} An array of objects containing the file path and extension of each file found in the directory and its subdirectories.
 */
function getFiles(dir: string): Array<{ filePath: string; extension: string }> {
  const files = readdirSync(dir);
  let fileList: Array<{ filePath: string; extension: string }> = [];

  files.forEach((file) => {
    const filePath = join(dir, file);
    const extension = extname(filePath);
    const stat = statSync(filePath);

    if (stat.isDirectory) {
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
  // Use Object.create(null) to create a prototype-free dictionary, preventing
  // any possibility of prototype pollution through bracket notation keys.
  const staticAssets: Record<
    string,
    { file: Uint8Array | string; type: string }
  > = Object.create(null) as Record<
    string,
    { file: Uint8Array | string; type: string }
  >;
  const fallbackMime = "application/octet-stream";
  fileList.forEach((element) => {
    const mimeType = Object.hasOwn(MIME_TYPES, element.extension)
      ? MIME_TYPES[element.extension]
      : fallbackMime;
    staticAssets[element.filePath.replace("dist", config.urlBase)] = {
      file: readFileSync(element.filePath),
      type: mimeType,
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
const socketPathPrefix = `${config.urlBase}/socket.io`;
let tlsOptions: { cert: string; key: string } | undefined;

if (config.nativeHttps) {
  try {
    tlsOptions = {
      key: readTextFileSync(config.ssl.key as string),
      cert: readTextFileSync(config.ssl.cert as string),
    };
  } catch (error) {
    logger.error("Error reading SSL key and/or certificate files:", {
      error: (error as Error).message,
    });
    Deno.exit(1);
  }
  if (config.ssl.passphrase) {
    logger.warn(
      "SSL passphrase is configured, but Deno native TLS expects an unencrypted PEM private key.",
    );
  }
  if (config.protocol === "http") {
    logger.warn(
      "Protocol is set to HTTP but nativeHttps is enabled. Overriding protocol to HTTPS.",
    );
    config.protocol = "https";
  }
  logger.info("Starting server in HTTPS mode");
} else {
  if (config.protocol === "https") {
    logger.warn(
      "Protocol is set to HTTPS but nativeHttps is disabled. Overriding protocol to HTTP.",
    );
    config.protocol = "http";
  }
  logger.info("Starting server in HTTP mode");
}

const { io: _io, sock } = createSocketServer({
  server: 0,
  corsAllowedOrigins: CORS_ALLOWED_ORIGINS,
  authenticateSocket,
  redis,
  connectionGeneration,
});

const socketSidecarPort = await new Promise<number>((resolve, reject) => {
  const socketServer = _io.httpServer as {
    address?: () => { port?: number } | string | null;
    listening?: boolean;
    once: (event: string, listener: (...args: unknown[]) => void) => void;
  };

  const resolvePort = () => {
    const address = socketServer.address?.();
    if (
      address && typeof address === "object" && typeof address.port === "number"
    ) {
      resolve(address.port);
      return;
    }
    reject(new Error("Failed to resolve Socket.IO sidecar port"));
  };

  if (socketServer.listening) {
    resolvePort();
    return;
  }

  socketServer.once("listening", resolvePort);
  socketServer.once("error", (error: unknown) => {
    reject(error instanceof Error ? error : new Error(String(error)));
  });
});

const socketSidecarOrigin = `http://127.0.0.1:${socketSidecarPort}`;

const apiRoutes = createApiRoutes({
  authenticateRequest,
  authenticateUser,
  isRegistrationAllowed,
  rateLimit,
  refreshAuthToken,
  registerUser,
  processListingRequest: validateBody(
    ListingRequestBodySchema,
    processListingRequest,
  ),
  processDownloadRequest: validateBody(
    DownloadRequestBodySchema,
    processDownloadRequest,
  ),
  updatePlaylistMonitoring: validateBody(
    UpdatePlaylistMonitoringRequestSchema,
    updatePlaylistMonitoring,
  ),
  getPlaylistsForDisplay: validateBody(
    PlaylistDisplayRequestSchema,
    getPlaylistsForDisplay,
  ),
  processDeletePlaylistRequest: validateBody(
    DeletePlaylistRequestBodySchema,
    processDeletePlaylistRequest,
  ),
  getSubListVideos: validateBody(SubListRequestSchema, getSubListVideos),
  processDeleteVideosRequest: validateBody(
    DeleteVideosRequestBodySchema,
    processDeleteVideosRequest,
  ),
  makeSignedUrl: validateBody(
    SignedFileRequestBodySchema,
    makeSignedUrl,
  ),
  refreshSignedUrl: validateBody(
    RefreshSignedUrlRequestBodySchema,
    refreshSignedUrl,
  ),
  refreshSignedUrls: validateBody(
    BulkRefreshSignedUrlsRequestBodySchema,
    refreshSignedUrls,
  ),
  makeSignedUrls: validateBody(
    BulkSignedFilesRequestBodySchema,
    makeSignedUrls,
  ),
  processReindexAllRequest: validateBody(
    ReindexAllRequestBodySchema,
    processReindexAllRequest,
  ),
  processDedupUnlistedRequest: validateBody(
    DedupRequestBodySchema,
    processDedupUnlistedRequest,
  ),
  processDedupPlaylistsRequest: validateBody(
    DedupRequestBodySchema,
    processDedupPlaylistsRequest,
  ),
  processQueueStatusRequest: validateBody(
    QueueStatusRequestBodySchema,
    processQueueStatusRequest,
  ),
});

const jobs = createJobs({
  cleanupStaleProcesses: cleanupStaleProcesses,
  downloadProcesses: downloadProcesses as Map<string, ProcessLike>,
  listProcesses: listProcesses as Map<string, ProcessLike>,
  listItemsConcurrently,
});

/**
 * Calls the HTTP-shaped `updatePlaylistMonitoring` from a non-HTTP caller.
 *
 * The handler writes its outcome to a response object rather than returning it,
 * so this captures the status code and turns a non-2xx into a thrown error.
 * Extracting a transport-agnostic core would be a cleaner seam, but that is a
 * larger refactor than /watch justifies today.
 */
function setPlaylistMonitoring(
  url: string,
  monitoringType: string,
): Promise<void> {
  let statusCode = 500;
  let body = "";

  const capture: HttpResponseLike = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      statusCode = code;
      return undefined;
    },
    write: (chunk: string | Uint8Array) => {
      body += typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk);
      return undefined;
    },
    end: (chunk?: string | Uint8Array) => {
      if (chunk) {
        body += typeof chunk === "string"
          ? chunk
          : new TextDecoder().decode(chunk);
      }
      return undefined;
    },
  };

  return updatePlaylistMonitoring({ url, watch: monitoringType }, capture).then(
    () => {
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(
          body || `updatePlaylistMonitoring failed (${statusCode})`,
        );
      }
    },
  );
}

const botService = createBotService({
  events: appEvents,
  listItemsConcurrently,
  resolveAndEnqueue,
  getQueueSnapshot,
  getListingQueueDepth,
  setPlaylistMonitoring,
  createSignedUrlForPath,
  normalizeUrl,
  // Mirrors executeListing's own classification, including the x.com
  // single-item exception.
  isPlaylistUrl: (url: string) =>
    playlistRegex.test(url) && !isSiteXDotCom(url),
});

function handleRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
) {
  if (req.url && req.url.startsWith(config.urlBase) && req.method === "GET") {
    try {
      const reqEncoding = req.headers["accept-encoding"] || "";
      logger.trace(`Request Received`, {
        url: req.url,
        method: req.method,
        encoding: reqEncoding,
      });
      // File streaming is now handled natively in the Deno.serve callback.
      // This section now only handles other GET requests like static assets.

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
    res.writeHead(204, generateCorsHeaders(MIME_TYPES[".json"]));
    res.end();
  } else if (req.method === "HEAD") {
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
}

async function bootstrapRuntime() {
  logger.info(`Server listening on ${config.publicOrigin}${config.urlBase}`);
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

  // The bot writes BotSubmission rows immediately on its first message, so the
  // schema must exist before any adapter is listening.
  try {
    await dbReady;
    await botService.start();
  } catch (error) {
    logger.error("Chat bot could not be started", {
      error: (error as Error).message,
    });
  }
}

Deno.serve(
  {
    port: config.port,
    ...(tlsOptions ?? {}),
    onListen: () => {
      void bootstrapRuntime();
    },
  },
  async (request, info) => {
    const url = new URL(request.url);
    const isSocketRoute = url.pathname === socketPathPrefix ||
      url.pathname.startsWith(`${socketPathPrefix}/`);

    if (isSocketRoute) {
      const upgradeHeader = request.headers.get("upgrade");
      if (upgradeHeader?.toLowerCase() === "websocket") {
        return proxyWebSocketRequest(request, socketSidecarOrigin);
      }
      return await proxyHttpRequest(request, socketSidecarOrigin);
    }

    // High-performance native file streaming
    const metadata = await getSignedFileMetadata(
      request,
      redis,
      config.cache.maxAge,
    );
    if (metadata) {
      const nativeResponse = await tryServeNativeFile(
        request,
        metadata,
        // The file-serving path is the one that genuinely needs multi-origin
        // support (cross-origin video playback and signed links), and it is one
        // of the few places with the Request in scope. Binding the origin here
        // avoids threading it through the other call sites.
        (contentType: string) =>
          generateCorsHeaders(contentType, {
            requestOrigin: request.headers.get("origin"),
            // This path serves bytes fetched from a remote site, not anything
            // this app authored, so it gets the lockdown policy instead of the
            // app's own.
            csp: SIGNED_FILE_CSP,
          }),
      );
      if (nativeResponse) {
        return nativeResponse;
      }
    }

    return await handleNodeStyleRequest(request, info, handleRequest);
  },
);
