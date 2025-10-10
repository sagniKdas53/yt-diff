"use strict";
const { Sequelize, DataTypes, Op } = require("sequelize");
const { spawn } = require("child_process");
const color = require("cli-color");
// const CronJob = require("cron").CronJob;
const fs = require("fs");
const http = require("http");
const https = require("https");
const path_fs = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const he = require('he');
const { LRUCache } = require('lru-cache');
const { Server } = require("socket.io");

// Configuration object
const config = {
  protocol: process.env.PROTOCOL || "http",
  host: process.env.HOSTNAME || "localhost",
  port: +process.env.PORT || 8888,
  nativeHttps: process.env.USE_NATIVE_HTTPS === "true" || false,
  hidePorts: process.env.HIDE_PORTS === "true",
  defaultCORSMaxAge: 2592000, // 30 days
  urlBase: process.env.BASE_URL || "/ytdiff",
  ssl: {
    key: process.env.SSL_KEY || null,
    cert: process.env.SSL_CERT || null,
    passphrase: process.env.SSL_PASSPHRASE || null,
  },
  db: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USERNAME || "ytdiff",
    name: "vidlist",
    password: process.env.DB_PASSWORD_FILE
      ? fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim()
      : process.env.DB_PASSWORD && process.env.DB_PASSWORD.trim()
        ? process.env.DB_PASSWORD
        : new Error("DB_PASSWORD or DB_PASSWORD_FILE environment variable must be set"),
  },
  cache: {
    maxItems: +process.env.CACHE_MAX_ITEMS || 1000,
    maxAge: +process.env.CACHE_MAX_AGE || 30, // keep cache for 30 seconds just in testing
    reqPerIP: +process.env.MAX_REQUESTS_PER_IP || 10
  },
  queue: {
    maxListings: +process.env.MAX_LISTINGS || 2,
    maxDownloads: +process.env.MAX_DOWNLOADS || 2,
    cleanUpInterval: process.env.CLEANUP_INTERVAL || "*/1 * * * *", // every minute
    maxIdle: +process.env.PROCESS_MAX_AGE || 5 * 60 * 1000, // 5 minutes
  },
  registration: {
    allowed: process.env.ALLOW_REGISTRATION === "false" ? false : true,
    maxUsers: +(process.env.MAX_USERS || 15)
  },
  saveLocation: process.env.SAVE_PATH || "/home/sagnik/Videos/yt-dlp/",
  cookiesFile: process.env.COOKIES_FILE
    ? fs.existsSync(process.env.COOKIES_FILE)
      ? process.env.COOKIES_FILE : new Error(`Cookies file not found: ${process.env.COOKIES_FILE}`)
    : false,
  sleepTime: process.env.SLEEP ?? 3,
  chunkSize: +process.env.CHUNK_SIZE_DEFAULT || 10,
  scheduledUpdateStr: process.env.UPDATE_SCHEDULED || "*/30 * * * *",
  timeZone: process.env.TZ_PREFERRED || "Asia/Kolkata",
  saveSubs: process.env.SAVE_SUBTITLES !== "false",
  saveDescription: process.env.SAVE_DESCRIPTION !== "false",
  saveComments: process.env.SAVE_COMMENTS !== "false",
  saveThumbnail: process.env.SAVE_THUMBNAIL !== "false",
  restrictFilenames: process.env.RESTRICT_FILENAMES !== "false",
  maxFileNameLength: +process.env.MAX_FILENAME_LENGTH || NaN, // No truncation by default
  logLevel: (process.env.LOG_LEVELS || "trace").toLowerCase(),
  logDisableColors: process.env.NO_COLOR === "true",
  maxTitleLength: 255,
  saltRounds: 10,
  secretKey: process.env.SECRET_KEY_FILE
    ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
    : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
      ? process.env.SECRET_KEY.trim()
      : new Error("SECRET_KEY or SECRET_KEY_FILE environment variable must be set"),
  maxClients: 10,
  connectedClients: 0,
};

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
  "--embed-metadata",
  "--embed-chapters",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveDescription ? "--write-description" : "",
  config.saveComments ? "--write-comments" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  config.restrictFilenames ? "--restrict-filenames" : "",
].filter(Boolean);
// Check if file name length limit is set and valid
if (!isNaN(config.maxFileNameLength) && config.maxFileNameLength > 0) {
  downloadOptions.push(`--trim-filenames`);
  downloadOptions.push(`${config.maxFileNameLength}`);
}
// Regex needs to be separate
const playlistRegex = /(?:playlist|list=)\b/i;

// Static content and server configuration
const MIME_TYPES = {
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.gz': 'application/gzip',
  '.br': 'application/brotli',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const CORS_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  // `http://localhost:${config.port}`,
  // `${config.protocol}://${config.host}:${config.port}`,
  // "*"
];
const CORS_ALLOWED_HEADERS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "OPTIONS"
];

if (config.secretKey instanceof Error) {
  throw config.secretKey;
}
if (config.db.password instanceof Error) {
  throw config.db.password;
}
if (config.cookiesFile instanceof Error) {
  const error = config.cookiesFile;
  config.cookiesFile = false;
  throw error;
}
if (!fs.existsSync(config.saveLocation)) {
  logger.info("Save location doesn't exists", { saveLocation: config.saveLocation });
  try {
    logger.info("Creating save location", { saveLocation: config.saveLocation });
    fs.mkdirSync(config.saveLocation, { recursive: true });
  } catch (error) {
    logger.error("Failed to create save location", {
      saveLocation: config.saveLocation,
      error: error.message
    });
    throw new Error(`Failed to create save location: ${error.message}`);
  }
}

// Caching
// TODO: Replace with your own LRUCache implementation using  Map and CronJob
/**
 * Generates cache configuration options for an LRU cache.
 *
 * @param {number} size - The maximum total size of all cache items in bytes.
 * @return {object} The cache options object containing configuration parameters:
 *   - max: Maximum number of items to store in the cache.
 *   - ttl: Time-to-live for each item in milliseconds.
 *   - updateAgeOnGet: Whether to reset TTL on get() to keep active items longer.
 *   - updateAgeOnHas: Whether to reset TTL on has() to keep active items longer.
 *   - sizeCalculation: Function to calculate the size of a given value in bytes.
 *   - maxSize: Maximum total size of all cache items in bytes.
 *   - dispose: Function to clear sensitive data when an item is removed.
 */
const createSecurityCacheConfig = (size) => ({
  max: config.cache.maxItems, // Maximum number of items to store in the cache
  ttl: config.cache.maxAge * 1000, // Time-to-live for each item in milliseconds
  updateAgeOnGet: true, // Reset TTL on get() to keep active items longer
  updateAgeOnHas: true, // Reset TTL on has() to keep active items longer
  /**
   * Calculates the size of a given value in bytes.
   *
   * @param {any} value - The value to calculate the size of.
   * @param {string} key - The key associated with the value (not used in calculation).
   * @return {number} The size of the value in bytes.
   */
  sizeCalculation: (value, key) => {
    const valueString = JSON.stringify(value);
    logger.trace(`Calculating size of cache item with key: ${key}`,
      { key: key, size: valueString.length });
    return valueString.length; // Size in bytes
  },
  maxSize: size, // Maximum total size of all cache items in bytes
  /**
   * Clear sensitive data when an item is removed.
   *
   * @param {string} key - The key associated with the value to be disposed of.
   * @param {any} value - The value to be disposed of.
   * @param {string} reason - The reason for disposing of the value.
   */
  dispose: (value, key, reason) => {
    // Clear sensitive data when an item is removed
    logger.trace(`Disposing cache item with key: ${key}`, {
      key: key,
      value: JSON.stringify(value),
      reason: reason
    });
    value = null;
  },
});

const userCache = new LRUCache(createSecurityCacheConfig(1000));
const ipCache = new LRUCache(createSecurityCacheConfig(1000));

// Logging
const logLevels = ["trace", "debug", "verbose", "info", "warn", "error"];
const currentLogLevelIndex = logLevels.indexOf(config.logLevel);
const orange = color.xterm(208);
const honeyDew = color.xterm(194);
if (config.logDisableColors || !process.stdout.isTTY) {
  color.enabled = false;
}

/**
 * Formats a log entry in logfmt style.
 *
 * @param {string} level - The log level (e.g., 'info', 'error').
 * @param {string} message - The log message.
 * @param {Object} [fields={}] - Additional fields to include in the log entry.
 * @param {string|number|boolean|Error|null|undefined} [fields.*] - The value of the additional field. 
 *        Strings will be escaped, Errors will include message and stack trace, null and undefined will be logged as null.
 * @returns {string} The formatted log entry.
 */
const logfmt = (level, message, fields = {}) => {
  let logEntry = `level=${level} msg="${message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')}"`;
  logEntry += ` ts=${new Date().toISOString()}`;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      logEntry += ` ${key}="${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')}"`;
    } else if (value instanceof Error) {
      logEntry += ` ${key}="${value.message
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')}"`;
      if (value.stack) {
        logEntry += ` ${key}_stack="${value.stack
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\r?\n/g, '\\n')}"`;
      }
    } else if (value === null || value === undefined) {
      logEntry += ` ${key}=null`;
    } else {
      logEntry += ` ${key}=${value}`;
    }
  }
  return logEntry;
};
/**
 * Logger object with various logging levels.
 * 
 * @property {function(string, object=): void} trace - Logs a trace level message.
 * @property {function(string, object=): void} debug - Logs a debug level message.
 * @property {function(string, object=): void} verbose - Logs a verbose level message.
 * @property {function(string, object=): void} info - Logs an info level message.
 * @property {function(string, object=): void} warn - Logs a warn level message.
 * @property {function(string, object=): void} error - Logs an error level message.
 * 
 * @example
 * logger.trace('This is a trace message', { additional: 'info' });
 * logger.debug('This is a debug message', { additional: 'info' });
 * logger.verbose('This is a verbose message', { additional: 'info' });
 * logger.info('This is an info message', { additional: 'info' });
 * logger.warn('This is a warning message', { additional: 'info' });
 * logger.error('This is an error message', { additional: 'info' });
 */
const logger = {
  trace: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("trace")) {
      console.debug(honeyDew(logfmt('trace', message, fields)));
    }
  },
  debug: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("debug")) {
      console.debug(color.magentaBright(logfmt('debug', message, fields)));
    }
  },
  verbose: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("verbose")) {
      console.log(color.greenBright(logfmt('verbose', message, fields)));
    }
  },
  info: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("info")) {
      console.log(color.blueBright(logfmt('info', message, fields)));
    }
  },
  warn: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("warn")) {
      console.warn(orange(logfmt('warn', message, fields)));
    }
  },
  error: (message, fields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("error")) {
      console.error(color.redBright(logfmt('error', message, fields)));
    }
  }
};

logger.info("Logger initialized", { logLevel: config.logLevel });

/**
 * Safely emit socket.io events if socket server is available.
 * Wraps emit calls in try/catch to avoid crashing the process when socket is not ready.
 * @param {string} event - Event name
 * @param {any} payload - Event payload
 */
function safeEmit(event, payload) {
  try {
    if (typeof sock !== 'undefined' && sock && typeof sock.emit === 'function') {
      sock.emit(event, payload);
    }
  } catch (e) {
    logger.warn('safeEmit failed', { event, error: e && e.message });
  }
}

// Database
const sequelize = new Sequelize({
  host: config.db.host,
  dialect: "postgres",
  logging: false,
  username: config.db.user,
  password: config.db.password,
  database: config.db.name,
});
try {
  sequelize.authenticate().then(() => {
    logger.info("Connection to database has been established successfully",
      { host: config.db.host, database: config.db.name });
  });
} catch (error) {
  logger.error("Unable to connect to the database",
    { host: config.db.host, database: config.db.name, error: error });
  throw error;
}

/**
 * VideoMetadata - Stores core information about each video
 * Primary table for video information tracking
 */
const VideoMetadata = sequelize.define("video_metadata", {
  videoUrl: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true
  },
  videoId: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "YouTube/platform-specific video identifier"
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  approximateSize: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: "Estimated file size in bytes"
  },
  downloadStatus: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "Whether video has been downloaded"
  },
  isAvailable: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: "Whether video is still available on platform"
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Name of the file on disk, should have the extension. null if not downloaded."
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
});

/**
 * PlaylistMetadata - Stores information about playlists
 * Tracks playlist details and monitoring settings
 */
const PlaylistMetadata = sequelize.define("playlist_metadata", {
  playlistUrl: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  sortOrder: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "Order in which playlists are displayed"
  },
  monitoringType: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Type of monitoring applied to playlist"
  },
  saveDirectory: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Directory path for downloaded videos"
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
});

/**
 * PlaylistVideoMapping - Junction table for playlist-video relationships
 * Manages many-to-many relationships between playlists and videos
 * - A video can belong to multiple playlists
 * - Each video can have different positions in different playlists
 * - Enables efficient querying of playlist contents and video memberships
 */
const PlaylistVideoMapping = sequelize.define("playlist_video_mapping", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false
  },
  videoUrl: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: VideoMetadata,
      key: "videoUrl"
    },
    onUpdate: "CASCADE",
    onDelete: "CASCADE",
    comment: "Foreign key linking to VideoMetadata"
  },
  playlistUrl: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: PlaylistMetadata,
      key: "playlistUrl"
    },
    onUpdate: "CASCADE",
    onDelete: "CASCADE",
    comment: "Foreign key linking to PlaylistMetadata"
  },
  positionInPlaylist: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "Order of video within playlist"
  }
});

/**
 * UserAccount - Stores user authentication information
 * Manages user credentials and access control
 */
const UserAccount = sequelize.define("user_account", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Hashed password using bcrypt"
  },
  passwordSalt: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Salt used in password hashing"
  }
});

/**
 * Database Relationships
 * 
 * Videos to Playlists (Many-to-Many):
 * - Videos can belong to multiple playlists
 * - Playlists can contain multiple videos
 * - PlaylistVideoMapping manages the relationships
 * - Each mapping includes video position in playlist
 * 
 * Cascading Deletes:
 * - Deleting a video removes all its playlist mappings
 * - Deleting a playlist removes all its video mappings
 */

// Define relationships
PlaylistVideoMapping.belongsTo(VideoMetadata, {
  foreignKey: "videoUrl"
});

PlaylistVideoMapping.belongsTo(PlaylistMetadata, {
  foreignKey: "playlistUrl"
});

VideoMetadata.hasMany(PlaylistVideoMapping, {
  foreignKey: "videoUrl"
});

PlaylistMetadata.hasMany(PlaylistVideoMapping, {
  foreignKey: "playlistUrl"
});

sequelize
  .sync()
  .then(async () => {
    logger.info(
      "tables exist or are created successfully",
      { host: config.db.host, database: config.db.name, tables: [VideoMetadata.name, PlaylistMetadata.name, PlaylistVideoMapping.name] }
    );
    // Making the unlisted playlist
    const [unlistedPlaylist, created] = await PlaylistMetadata.findOrCreate({
      where: { playlistUrl: "None" },
      defaults: {
        title: "None",
        monitoringType: "N/A",
        saveDirectory: "",
        sortOrder: -1,
      },
    });
    if (created) {
      logger.info(
        "Unlisted playlist created successfully",
        { host: config.db.host, database: config.db.name, tables: [unlistedPlaylist.name] }
      );
    }
    // Replace the existing default user creation code with:
    const defaultUserCheck = await UserAccount.count();
    if (defaultUserCheck === 0) {
      logger.warn(
        "No users exist in the database. Please create a user account.",
        { setup_required: true }
      );
    } else {
      logger.info(
        "Users exist in database",
        { user_count: defaultUserCheck }
      );
    }
  })
  .catch((error) => {
    logger.error(`Unable to create table`, { error: error });
  });

// Scheduler
const jobs = {
  // TODO: 
  // 1. Implement scheduled updates to check playlists for new videos
  // 2. Add a job to replace the LRUCache implementation with one that uses Map and CronJob
  // 3. Add a job to clean up stale download/list processes periodically
};
// const jobs = {
//    update: new CronJob(
//      config.scheduledUpdateStr,
//      () => {
//        logger.info("Scheduled update", {
//          time: new Date().toLocaleString("en-US", { timeZone: config.timeZone }),
//          timeZone: config.timeZone,
//          nextRun: jobs.update.nextDate().toLocaleString("en-US", { timeZone: config.timeZone })
//        });
//
//      },
//      null,
//      true,
//      config.timeZone
//    ),
//   cleanup: new CronJob(
//     config.queue.cleanUpInterval,
//     () => {
//       logger.debug("Starting scheduled process cleanup");
//       // Cleanup download processes
//       const cleanedDownloads = cleanupStaleProcesses(
//         downloadProcesses,
//         {
//           maxIdleTime: config.queue.maxIdle,
//           forceKill: true
//         }
//       );
//       // Cleanup list processes
//       const cleanedLists = cleanupStaleProcesses(
//         listProcesses,
//         {
//           maxIdleTime: config.queue.maxIdle,
//           forceKill: true
//         }
//       );
//       logger.info("Completed scheduled process cleanup", {
//         cleanedDownloads,
//         cleanedLists,
//         nextRun: jobs.cleanup.nextDate().toLocaleString(
//           {
//             weekday: 'short', month: 'short', day: '2-digit',
//             hour: '2-digit', minute: '2-digit'
//           }, { timeZone: config.timeZone })
//       });
//     },
//     null,
//     true,
//     config.timeZone
//   ),
// };

// Utility functions
/**
 * Extracts and parses JSON data from a request stream
 *
 * @param {http.IncomingMessage} request - The HTTP request object
 * @returns {Promise<Object>} Parsed JSON data from request body
 * @throws {Object} Error with status code and message if request is too large or JSON is invalid
 */
async function parseRequestJson(request) {
  return new Promise((resolve, reject) => {
    let requestBody = "";
    const maxRequestSize = 1e6; // 1MB limit

    request.on("data", chunk => {
      requestBody += chunk;

      // Check request size
      if (requestBody.length > maxRequestSize) {
        logger.warn("Request exceeded size limit", {
          ip: request.socket.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method
        });

        request.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });

    request.on("end", () => {
      if (requestBody.length === 0) {
        logger.warn("Empty request body", {
          ip: request.socket.remoteAddress,
          url: request.url,
          method: request.method
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
          error: error.message
        });

        reject({ status: 400, message: "Invalid JSON" });
      }
    });
    request.on("error", (err) => {
      reject({ status: 500, message: "Request stream error", error: err.message });
    });
  });
}
/**
   * Fixes common URL formatting issues for various platforms
   * 
   * @param {string} url - URL to process
   * @returns {string} Fixed URL
   */
function normalizeUrl(url) {
  if (url.includes("youtube")) {
    // Add /videos to YouTube channel URLs if missing
    if (!/\/videos\/?$/.test(url) && url.includes("/@")) {
      url = url.replace(/\/$/, "") + "/videos";
    }
    logger.debug(`Normalized YouTube URL: ${url}`);
  }

  if (url.includes("pornhub") && url.includes("/model/")) {
    // Add /videos to PornHub model URLs if missing
    if (!/\/videos\/?$/.test(url)) {
      url = url.replace(/\/$/, "") + "/videos";
    }
    logger.debug(`Normalized PornHub URL: ${url}`);
  }

  return url;
}
/**
   * Generates a title from a URL by extracting meaningful path segments
   * 
   * @param {string} url - URL to convert to title
   * @returns {Promise<string>} Generated title
   */
async function urlToTitle(url) {
  try {
    // Extract path segments and join them
    const pathSegments = new URL(url).pathname.split("/");
    const unwantedSegments = new Set(['videos', 'channel', 'user', 'playlist']);

    const titleSegments = pathSegments.filter(segment =>
      segment && !unwantedSegments.has(segment.toLowerCase())
    );

    return titleSegments.join("_") || url;

  } catch (error) {
    logger.error("Failed to generate title from URL", {
      url,
      error: error.message
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
async function sleep(seconds = config.sleepTime) {
  logger.trace(`Sleeping for ${seconds} seconds`);

  const start = Date.now();
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
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
async function truncateText(text, maxLength) {
  if (!text || typeof text !== 'string') {
    logger.warn("Invalid text provided for truncation", {
      text,
      type: typeof text
    });
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  const truncated = text.slice(0, maxLength);
  logger.debug(`Truncated text from ${text.length} to ${truncated.length} characters`);
  return truncated;
}
/**
 * Checks if the given video URL belongs to x.com or any of its subdomains.
 *
 * @param {string} videoUrl - The URL of the video to check.
 * @returns {boolean} True if the URL's hostname is x.com or a subdomain of x.com, false otherwise.
 */
function isSiteXDotCom(videoUrl) {
  let hostname = "";
  try {
    hostname = (new URL(videoUrl)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${videoUrl}`, { error: e.message });
  }
  // Only match x.com or its subdomains (e.g. foo.x.com)
  const allowedXHost = 'x.com';
  const isAllowedXCom = hostname === allowedXHost || hostname.endsWith('.' + allowedXHost);
  return isAllowedXCom;
}

//Authentication functions
/**
 * Hashes a password using bcrypt with configurable salt rounds
 *
 * @param {string} plaintextPassword - The password to hash
 * @returns {Promise<[string, string]>} Promise resolving to [salt, hashedPassword]
 * @throws {Error} If hashing fails
 */
async function hashPassword(plaintextPassword) {
  try {
    const salt = await bcrypt.genSalt(config.saltRounds);
    const hashedPassword = await bcrypt.hash(plaintextPassword, salt);
    return [salt, hashedPassword];
  } catch (error) {
    logger.error('Password hashing failed', { error: error.message });
    throw new Error('Failed to secure password');
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
function generateAuthToken(user, expiryDuration) {
  return jwt.sign(
    {
      id: user.id,
      lastPasswordChangeTime: user.updatedAt
    },
    config.secretKey,
    { expiresIn: expiryDuration }
  );
}
/**
 * Handles user registration with password validation and duplicate checks
 *
 * @param {Object} request - HTTP request object
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when registration completes
 */
async function registerUser(request, response) {
  try {
    // Check if registration is enabled
    if (!config.registration.allowed) {
      response.writeHead(403, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Registration is currently disabled"
      }));
    }

    // Check user limit
    const userCount = await UserAccount.count();
    if (userCount >= config.registration.maxUsers) {
      response.writeHead(403, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Maximum number of users reached"
      }));
    }
    let requestData = {};
    try {
      requestData = await parseRequestJson(request);
    } catch (error) {
      logger.error("Failed to parse request JSON", { error: error.message });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: `${error.message || "Invalid request"}`
      }));
    }
    const { userName, password } = requestData;

    // Validate password length (bcrypt limit is 72 bytes)
    if (Buffer.byteLength(password, 'utf8') > 72) {
      logger.error("Password too long", {
        userName,
        passwordLength: Buffer.byteLength(password, 'utf8')
      });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Password exceeds maximum length"
      }));
    }

    // Check for existing user
    const existingUser = await UserAccount.findOne({
      where: { username: userName }
    });

    if (existingUser) {
      response.writeHead(409, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Username already exists"
      }));
    }

    // Create new user
    const [salt, hashedPassword] = await hashPassword(password);
    await UserAccount.create({
      username: userName,
      passwordSalt: salt,
      passwordHash: hashedPassword
    });

    response.writeHead(201, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: 'success',
      message: "User registered successfully"
    }));

  } catch (error) {
    logger.error("Registration failed", { error: error.message });
    response.writeHead(500, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: 'error',
      message: "Registration failed"
    }));
  }
}
/**
 * Checks if user registration is allowed based on current settings
 * 
 * @param {*} request Request object to read any parameters
 * @param {*} response Response object to send result
 * @returns {Promise<void>} Resolves with registration status
 */
async function isRegistrationAllowed(request, response) {
  var allow = true;
  if (!config.registration.allowed) {
    allow = false;
  }
  let requestData = {};
  try {
    requestData = await parseRequestJson(request);
  } catch (err) {
    logger.error("Failed to parse request JSON", { error: err.message });
    response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      status: 'error',
      message: `${err.message || "Invalid request"}`
    }));
  }
  const { sendStats } = requestData || { sendStats: false };
  const userCount = await UserAccount.count();
  if (userCount >= config.registration.maxUsers) {
    allow = false;
  }
  if (sendStats === true) {
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      registrationAllowed: allow,
      currentUsers: userCount,
      maxUsers: config.registration.maxUsers
    }));
  } else {
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      registrationAllowed: allow
    }));
  }
}
/**
 * Middleware to verify JWT tokens and check user authentication
 *
 * @param {Object} request - HTTP request object
 * @param {Object} response - HTTP response object
 * @param {Function} next - Next middleware function
 * @returns {Promise<void>} Resolves when verification completes
 */
async function authenticateRequest(request, response, next) {
  try {
    // Try to get token from Authorization header (Bearer) first, fall back to body
    const authHeader = request.headers && (request.headers.authorization || request.headers.Authorization);
    let headerToken = null;
    if (authHeader && typeof authHeader === 'string') {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
        headerToken = parts[1];
      } else {
        // If header contains token without scheme, use it directly
        headerToken = authHeader;
      }
    }

    const token = headerToken;

    if (!token) {
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ status: 'error', message: "Token required" }));
    }

    // Verify token
    const decodedToken = jwt.verify(token, config.secretKey);

    // Check cache first
    let user = userCache.get(decodedToken.id);

    if (!user) {
      logger.debug(`Fetching user data for ID ${decodedToken.id}`);
      user = await UserAccount.findByPk(decodedToken.id);
      if (user) {
        userCache.set(decodedToken.id, user);
      }
    }

    if (!user) {
      logger.error("User not found");
      response.writeHead(404, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "User not found"
      }));
    }

    // Verify password hasn't changed
    const lastPasswordUpdate = user.updatedAt.toISOString();
    if (lastPasswordUpdate !== decodedToken.lastPasswordChangeTime) {
      logger.error("Token invalid - password changed");
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Token expired"
      }));
    }

    let requestData = {};
    try {
      requestData = await parseRequestJson(request);
    } catch (error) {
      logger.error("Failed to parse request JSON", { error: error.message });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: `${error.message || "Invalid request"}`
      }));
    }
    // Continue to next middleware
    next(requestData, response);

  } catch (error) {
    logger.error("Token verification failed", { error: error.message });

    const statusCode = error.name === "TokenExpiredError" ? 401 : 500;
    const message = error.name === "TokenExpiredError" ? "Token expired" : "Authentication failed";

    if (error.name === "TokenExpiredError") {
      if (typeof sock !== 'undefined' && sock && typeof sock.emit === 'function') {
        try {
          sock.emit("token-expired", { error: error.message });
        } catch (e) {
          logger.warn('Failed to emit token-expired on sock', { error: e.message });
        }
      }
    }

    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      status: 'error',
      message: he.escape(message)
    }));
  }
}
/**
 * Verifies socket.io connection authentication
 *
 * @param {Object} socket - Socket.io socket object
 * @param {Object} socket.handshake - Connection handshake data
 * @returns {Promise<boolean>} Resolves to true if authentication valid
 */
async function authenticateSocket(socket) {
  try {
    const token = socket.handshake.auth.token;
    const decodedToken = jwt.verify(token, config.secretKey);

    // Check cache first
    let user = userCache.get(decodedToken.id);

    if (!user) {
      logger.debug(`Fetching user data for ID ${decodedToken.id}`);
      user = await UserAccount.findByPk(decodedToken.id);
      if (user) {
        userCache.set(decodedToken.id, user);
      }
    }

    if (!user) {
      logger.error("Socket auth failed - user not found");
      return false;
    }

    // Verify password hasn't changed
    const lastPasswordUpdate = user.updatedAt.toISOString();
    if (lastPasswordUpdate !== decodedToken.lastPasswordChangeTime) {
      logger.error("Socket auth failed - password changed");
      return false;
    }

    return true;

  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      logger.error("Invalid token format");
    } else if (error.name === "TokenExpiredError") {
      logger.error("Token expired");
    } else {
      logger.error("Socket authentication failed", { error: error.message });
    }
    return false;
  }
}
/**
 * Rate limiting middleware for API endpoints
 *
 * @param {Object} request - HTTP request object
 * @param {Object} response - HTTP response object
 * @param {Function} currentHandler - Current route handler
 * @param {Function} nextHandler - Next middleware function
 * @param {number} maxRequestsPerWindow - Maximum requests allowed per time window
 * @param {number} windowSeconds - Time window in seconds
 * @returns {Promise<void>} Resolves when rate limiting check completes
 */
async function rateLimit(
  request,
  response,
  currentHandler,
  nextHandler,
  maxRequestsPerWindow,
  windowSeconds
) {
  const clientIp = request.socket.remoteAddress;
  logger.trace(`Rate limit check for IP ${clientIp}`);

  // Check current request count
  const currentRequests = ipCache.get(clientIp) || 0;

  if (currentRequests >= maxRequestsPerWindow) {
    logger.debug(`Rate limit exceeded for ${clientIp}`);
    response.writeHead(429, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      status: 'error',
      message: "Too many requests"
    }));
  }

  // Update request count
  ipCache.set(
    clientIp,
    currentRequests + 1,
    windowSeconds
  );

  logger.debug(`Request count for ${clientIp}: ${currentRequests + 1}`);

  // Continue to handler
  currentHandler(request, response, nextHandler);
}
/**
 * Handles user authentication and token generation
 *
 * @param {Object} request - HTTP request object
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when authentication completes
 */
async function authenticateUser(request, response) {
  try {
    let requestData = {};
    try {
      requestData = await parseRequestJson(request);
    } catch (error) {
      logger.error("Failed to parse request JSON", { error: error.message });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: `${error.message || "Invalid request"}`
      }));
    }

    // Extract and validate fields
    if (!requestData.userName || !requestData.password) {
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "userName and password are required"
      }));
    }

    // Destructure with defaults
    const {
      userName,
      password,
      expiry_time: expiryTime = "31d"
    } = requestData;

    // Validate password length
    if (Buffer.byteLength(password, 'utf8') > 72) {
      logger.error("Password too long", {
        userName,
        passwordLength: Buffer.byteLength(password, 'utf8')
      });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Password exceeds maximum length"
      }));
    }

    // Find user
    const user = await UserAccount.findOne({
      where: { username: userName }
    });

    if (!user) {
      logger.verbose(`Authentication failed for user ${userName}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      logger.verbose(`Authentication failed for user ${userName}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Generate token
    const token = generateAuthToken(user, expiryTime);
    logger.verbose(`Authentication successful for user ${userName}`);

    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({
      status: 'success',
      token: he.escape(token)
    }));

  } catch (error) {
    logger.error("Authentication failed", { error: error.message });
    response.writeHead(500, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: 'error',
      message: "Authentication failed"
    }));
  }
}

// Download functions
// Download process tracking
const downloadProcesses = new Map(); // Map to track download processes

/**
 * Streams a file to the response given an absolute path.
 * Expects to be called either as authenticateRequest(req, res, serveFileByPath)
 * where the first arg will be parsed requestData, or directly as serveFileByPath(requestBody, res).
 *
 * Request body shape: { saveDirectory: string, fileName: string }
 * 
 * Returns 400 if path is not absolute or invalid
 * Returns 404 if file not found
 * Returns 429 if another file transfer is active
 * Streams file with appropriate Content-Type header if found and valid
 * 
 * @param {Object} requestBody - Parsed JSON body from request
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when file transfer completes or fails
 */
async function serveFileByPath(requestBody, response) {
  // Guard for single concurrent file stream: if another /getfile is active, reject with 429
  // We use a simple in-memory flag because file streaming is short-lived and this service
  // is single-process. This prevents multiple heavy file streams at once.
  // TODO: Sometimes steams hang and never close, causing the flag to remain set.
  // Implement a timeout or more robust tracking to clear stale active states.
  if (serveFileByPath._active) {
    logger.warn('serveFileByPath rejected due to active transfer', { fileName: (requestBody && requestBody.fileName) });
    response.writeHead(429, generateCorsHeaders(MIME_TYPES['.json']));
    return response.end(JSON.stringify({ status: 'error', message: 'Too many requests: only one file transfer allowed at a time' }));
  }
  // Ensure flag cleared on finish or error
  const clearActive = () => { try { serveFileByPath._active = false; } catch (e) { /* ignore */ } };
  try {
    // If called via authenticateRequest, requestBody will be the parsed JSON object
    let absolutePath = null;
    if (requestBody && (requestBody.saveDirectory || requestBody.fileName)) {
      const saveDirectory = requestBody.saveDirectory || "";
      const fileName = requestBody.fileName;
      if (!fileName || typeof fileName !== 'string') {
        logger.warn('serveFileByPath invalid fileName', { saveDirectory, fileName });
        response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
        return response.end(JSON.stringify({ status: 'error', message: 'fileName is required' }));
      }

      // Construct the absolute path using configured saveLocation. Use path_fs.join and
      // then verify that the resolved path is within config.saveLocation to avoid traversal.
      const joined = path_fs.join(config.saveLocation, saveDirectory || '', fileName);
      const resolved = path_fs.resolve(joined);
      const saveRoot = path_fs.resolve(config.saveLocation);
      if (!resolved.startsWith(saveRoot)) {
        logger.warn('serveFileByPath attempted path traversal', { saveDirectory, fileName, resolved });
        response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
        return response.end(JSON.stringify({ status: 'error', message: 'Invalid file path' }));
      }
      absolutePath = resolved;
    }

    // Entry log
    logger.info('serveFileByPath called', { remote: response && response.socket && response.socket.remoteAddress, absolutePath });

    if (!absolutePath || typeof absolutePath !== 'string') {
      logger.warn('serveFileByPath invalid absolutePath', { absolutePath });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'absolutePath could not be resolved from input' }));
    }

    // Security: ensure it's an absolute path
    if (!absolutePath || !path_fs.isAbsolute(absolutePath)) {
      logger.warn('serveFileByPath rejected non-absolute path', { absolutePath });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'absolutePath must be an absolute path' }));
    }

    // Check file existence and type
    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch (err) {
      logger.warn('serveFileByPath file not found', { absolutePath, error: err.message });
      response.writeHead(404, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'File not found' }));
    }

    if (!stats.isFile()) {
      logger.warn('serveFileByPath path is not a file', { absolutePath });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'Path is not a file' }));
    }

    // Determine content type from extension fallback to application/octet-stream
    const ext = path_fs.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const headers = generateCorsHeaders(contentType);
    // Optionally set content length when available
    try {
      if (typeof stats.size === 'number') headers['Content-Length'] = stats.size;
    } catch (e) {
      logger.debug('Could not set Content-Length', { error: e && e.message });
    }

    // If you want the browser to download the file instead of displaying it,
    // headers['Content-Disposition'] = `attachment; filename="${path_fs.basename(absolutePath)}"`;

    logger.info('serveFileByPath streaming file', { absolutePath, contentType, size: stats.size });

    // Double-check active state right before starting the stream to avoid reserving the slot
    if (serveFileByPath._active) {
      logger.warn('serveFileByPath rejected due to active transfer at stream start', { absolutePath });
      response.writeHead(429, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'Too many requests: only one file transfer allowed at a time' }));
    }
    // Mark active now that the file is validated and we're about to stream
    serveFileByPath._active = true;

    response.writeHead(200, headers);

    const stream = fs.createReadStream(absolutePath);
    stream.on('open', () => {
      logger.debug('serveFileByPath stream opened', { path: absolutePath });
    });
    stream.on('end', () => {
      logger.debug('serveFileByPath stream ended', { path: absolutePath });
      clearActive();
    });
    stream.on('close', () => {
      // 'close' can be emitted after client disconnects
      logger.debug('serveFileByPath stream closed', { path: absolutePath });
      clearActive();
    });
    stream.on('error', (err) => {
      logger.error('Error streaming file', { error: err.message, path: absolutePath });
      clearActive();
      // If headers already sent, just destroy. Otherwise return 500 response.
      try {
        if (!response.headersSent) {
          response.writeHead(500, generateCorsHeaders(MIME_TYPES['.json']));
          response.end(JSON.stringify({ status: 'error', message: 'Error reading file' }));
        } else {
          response.destroy();
        }
      } catch (e) {
        logger.error('serveFileByPath stream error handling failed', { error: e && e.message });
      }
    });

    // If client aborts connection, clear the active flag
    response.on('close', () => {
      logger.debug('Response closed by client during file transfer', { path: absolutePath });
      try { stream.destroy(); } catch (e) { /* ignore */ }
      clearActive();
    });

    stream.pipe(response);

  } catch (error) {
    logger.error('serveFileByPath failed', { error: error.message });
    clearActive();
    response.writeHead(500, generateCorsHeaders(MIME_TYPES['.json']));
    response.end(JSON.stringify({ status: 'error', message: 'Internal server error' }));
  }
}
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
  queue: [],

  async acquire() {
    return new Promise(resolve => {
      if (this.currentConcurrent < this.maxConcurrent) {
        this.currentConcurrent++;
        logger.debug(`Semaphore acquired, current concurrent: ${this.currentConcurrent}`);
        resolve();
      } else {
        logger.debug(`Semaphore full, queuing request`);
        this.queue.push(resolve);
      }
    });
  },

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      logger.debug(`Semaphore released, current concurrent: ${this.currentConcurrent}`);
      next();
    } else {
      logger.debug(`Semaphore released`);
      this.currentConcurrent--;
    }
  },

  setMaxConcurrent(max) {
    this.maxConcurrent = max;
    // Check if we can start any queued tasks
    while (this.currentConcurrent < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      this.currentConcurrent++;
      next();
    }
  }
};
/**
   * Converts a process map to a serializable state object
   *
   * @param {Map<string, {status: string}>} processMap - Map of process entries
   * @returns {Object} Object containing process states by ID
   */
function getProcessStates(processMap) {
  const states = {};

  for (const [processId, process] of processMap.entries()) {
    logger.debug(`Processing state for ${processId}`, {
      status: process.status
    });

    states[processId] = {
      status: process.status,
      type: process.spawnType,
      lastActive: process.lastActivity
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
  processMap,
  {
    maxIdleTime = config.queue.maxIdle,
    forceKill = false
  } = {}
) {
  const now = Date.now();
  let cleanedCount = 0;

  logger.info(`Cleaning up processes older than ${maxIdleTime / 1000} seconds`);
  logger.trace('Current process states:', {
    states: getProcessStates(processMap)
  });

  // Iterate through processes
  for (const [processId, process] of processMap.entries()) {
    const { status, lastActivity, spawnTimeStamp, spawnedProcess } = process;

    logger.debug(`Checking process ${processId}`, {
      status,
      lastActivity,
      age: now - spawnTimeStamp
    });

    // Handle completed processes
    if (status === 'completed' || status === 'failed') {
      processMap.delete(processId);
      cleanedCount++;
      continue;
    }

    // Handle stale processes
    if (status === 'running' && (now - spawnTimeStamp > maxIdleTime)) {
      logger.warn(`Found stale process: ${processId}`, {
        idleTime: (now - spawnTimeStamp) / 1000,
        lastActivity: new Date(lastActivity).toISOString()
      });

      if (spawnedProcess?.kill && forceKill) {
        try {
          // Try SIGKILL first
          const killed = spawnedProcess.kill('SIGKILL');
          if (killed) {
            logger.info(`Killed stale process ${processId}`);
          } else {
            // Fall back to SIGTERM
            const terminated = spawnedProcess.kill('SIGTERM');
            logger.info(`Terminated stale process ${processId}`);

            if (!terminated) {
              throw new Error('Failed to terminate process');
            }
          }
        } catch (error) {
          logger.error(`Failed to kill process ${processId}`, {
            error: error.message
          });
        }
      }

      processMap.delete(processId);
      cleanedCount++;
    }
  }

  logger.info(`Cleaned up ${cleanedCount} processes`);
  logger.trace('Updated process states:', {
    states: getProcessStates(processMap)
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
async function processDownloadRequest(requestBody, response) {
  try {
    // Initialize download tracking
    const videosToDownload = [];
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
        where: { videoUrl: videoUrl }
      });

      if (!videoEntry) {
        logger.error(`Video not found in database`, { url: videoUrl });
        response.writeHead(404, generateCorsHeaders(MIME_TYPES[".json"]));
        return response.end(JSON.stringify({
          error: `Video with URL ${videoUrl} is not indexed`
        }));
      }

      // Get save directory from playlist if available
      let saveDirectory = "";
      try {
        const playlist = await PlaylistMetadata.findOne({
          where: { playlistUrl: playlistUrl }
        });
        saveDirectory = playlist?.saveDirectory ?? "";
      } catch (error) {
        logger.error(`Error getting playlist save directory`, {
          error: error.message,
          playlistUrl
        });
      }

      // Add to download queue
      videosToDownload.push({
        url: videoUrl,
        title: videoEntry.title,
        saveDirectory: saveDirectory,
        videoId: videoEntry.videoId
      });
      uniqueUrls.add(videoUrl);
    }

    // Start downloads
    downloadItemsConcurrently(videosToDownload, config.queue.maxDownloads);
    logger.debug(`Download processes started`, { itemCount: videosToDownload.length });

    // Send success response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "success",
      message: "Downloads initiated",
      items: videosToDownload
    }));

  } catch (error) {
    logger.error(`Download processing failed`, {
      error: error.message,
      stack: error.stack
    });

    const statusCode = error.status || 500;
    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "error",
      message: he.escape(error.message)
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
async function downloadItemsConcurrently(items, maxConcurrent = 2) {
  logger.trace(`Downloading ${items.length} videos concurrently (max ${maxConcurrent} concurrent)`);

  // Update the semaphore's max concurrent value
  DownloadSemaphore.setMaxConcurrent(maxConcurrent);

  // Filter out URLs already being downloaded
  const uniqueItems = items.filter(item => {
    const videoUrl = item.url;
    const existingDownload = Array.from(downloadProcesses.values())
      .find(process => process.url === videoUrl &&
        ['running', 'pending'].includes(process.status));

    return !existingDownload;
  });

  logger.trace(`Filtered ${uniqueItems.length} unique items for download`);

  // Process all items with semaphore control
  const downloadResults = await Promise.all(
    uniqueItems.map(item => downloadWithSemaphore(item))
  );

  // Check for any failures
  const allSuccessful = downloadResults.every(result => result.status === 'success');

  // Log results
  downloadResults.forEach(result => {
    if (result.status === 'success') {
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
async function downloadWithSemaphore(downloadItem) {
  logger.trace(`Starting download with semaphore: ${JSON.stringify(downloadItem)}`);

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
      status: "pending"
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
async function executeDownload(downloadItem, processKey) {
  const { url: videoUrl, title: videoTitle,
    saveDirectory: saveDirectory, videoId: videoId } = downloadItem;

  try {
    // Prepare save path
    const savePath = path_fs.join(config.saveLocation, saveDirectory.trim());
    logger.debug(`Downloading to path: ${savePath}`);

    // Create directory if needed, good to have
    if (savePath !== config.saveLocation && !fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let progressPercent = null;
      let actualFileName = null;
      // Prepare final parameters
      const processArgs = ["--paths", savePath, videoUrl];

      // Notify frontend of download start
      safeEmit("download-started", { percentage: 101 });

      // Check and add cookies file for x.com if configured
      if (config.cookiesFile && isSiteXDotCom(videoUrl)) {
        logger.debug(`Using cookies file: ${config.cookiesFile}`);
        // Add cookies file to process args
        processArgs.unshift(`--cookies`, config.cookiesFile);
      }

      logger.debug(`Starting download for ${videoUrl}`, {
        url: videoTitle,
        savePath,
        fullCommand: `yt-dlp ${downloadOptions.join(' ')} ${processArgs.join(' ')}`,
      });
      // Spawn download process, by assembling full args
      const downloadProcess = spawn("yt-dlp", downloadOptions.concat(processArgs));

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
      downloadProcess.stdout.on("data", data => {
        try {
          const output = data.toString().trim();

          // Track download progress
          const percentMatch = /(\d{1,3}\.\d)/.exec(output);
          if (percentMatch) {
            const percent = parseFloat(percentMatch[0]);
            const progressBlock = Math.floor(percent / 10);

            if (progressBlock === 0 && progressPercent === null) {
              progressPercent = 0;
              logger.trace(output, { pid: downloadProcess.pid });
            } else if (progressBlock > progressPercent) {
              progressPercent = progressBlock;
              logger.trace(output, { pid: downloadProcess.pid });
            }

            // Emit progress update to frontend
            // TODO: Check if this is needed, as when multiple downloads are running this does not work properly
            safeEmit("downloading-percent-update", { percentage: percent });
          }

          // Extract filename from destination line (keep extension)
          const fileNameDestMatch = /Destination: (.+)/m.exec(output);
          if (fileNameDestMatch?.[1] && !actualFileName) {
            const fullDest = fileNameDestMatch[1].trim();
            actualFileName = path_fs.basename(fullDest);
            logger.debug(`Filename in destination: ${fullDest}, basename: ${actualFileName}, DB title: ${videoTitle}`,
              { pid: downloadProcess.pid });
          }

          // Check for merger, as this is usually the final filename (keep extension)
          const mergerFileNameMatch = /\[Merger\] Merging formats into "(.+)"/m.exec(output);
          if (mergerFileNameMatch?.[1]) {
            const fullMerger = mergerFileNameMatch[1].trim();
            actualFileName = path_fs.basename(fullMerger);
            logger.debug(`Filename in merger: ${fullMerger}, basename: ${actualFileName}, DB title: ${videoTitle}`,
              { pid: downloadProcess.pid });
          }
          // Update activity timestamp
          updateProcessActivity(processKey);

        } catch (error) {
          if (!(error instanceof TypeError)) {
            safeEmit("error", { message: error.message });
          }
        }
      });

      // Handle stderr
      downloadProcess.stderr.setEncoding("utf8");
      downloadProcess.stderr.on("data", error => {
        logger.error(`Download error: ${error}`, { pid: downloadProcess.pid });
        updateProcessActivity(processKey);
      });

      // Handle process errors
      downloadProcess.on("error", error => {
        logger.error(`Download process error: ${error.message}`, { pid: downloadProcess.pid });
        updateProcessActivity(processKey);
        reject(error);
      });

      // Handle process completion
      downloadProcess.on("close", async code => {
        try {
          const videoEntry = await VideoMetadata.findOne({
            where: { videoUrl: videoUrl }
          });

          if (code === 0) {
            // Update video entry on success
            const updates = {
              downloadStatus: true,
              isAvailable: true,
              title: (videoTitle === videoId || videoTitle === "NA")
                ? (actualFileName || videoTitle)
                : videoTitle,
              // Determine final filename with extension
              fileName: (function () {
                if (actualFileName) {
                  return path_fs.basename(actualFileName || "");
                }
                // Fallback: try to find a file in savePath that matches videoTitle prefix
                try {
                  const files = fs.readdirSync(savePath);
                  const match = files.find(f => f.indexOf(videoTitle) === 0 || f.indexOf(videoId) !== -1);
                  if (match) return path_fs.basename(match);
                } catch (e) {
                  logger.debug('Could not read savePath for fallback filename', { savePath, error: e && e.message });
                }
                // As last resort, join savePath and videoTitle (no extension)
                return path_fs.basename(videoTitle);
              })(),
            };

            logger.debug(`Updating video: ${JSON.stringify(updates)}`,
              { pid: downloadProcess.pid });

            await videoEntry.update(updates);

            // Notify frontend: send saveDirectory and fileName
            try {
              const fileName = updates.fileName;
              // Compute the save directory relative to configured saveLocation.
              // Normalize '.' (same directory) to empty string so callers receive "" when
              // the file is directly in the save root.
              let saveDir = path_fs.relative(
                path_fs.resolve(config.saveLocation),
                path_fs.dirname(updates.fileName || config.saveLocation)
              );
              // TODO: Check if these many adjustments are needed, or if path_fs.relative is sufficient
              if (saveDir.equals(saveDirectory.trim())) {
                logger.debug(`Computed saveDir matches expected saveDirectory`, { saveDir, saveDirectory });
              } else {
                logger.debug(`Computed saveDir differs from expected saveDirectory`, {
                  saveDir, saveDirectory
                });
                if (saveDir === path_fs.sep || saveDir === '.') saveDir = '';
                if (saveDir.startsWith(path_fs.sep)) {
                  saveDir = saveDir.slice(1);
                }
                if (saveDir.endsWith(path_fs.sep)) {
                  saveDir = saveDir.slice(0, -1);
                }
              }
              safeEmit("download-done", {
                url: videoUrl,
                title: updates.title,
                fileName: fileName,
                saveDirectory: saveDir
              });
            } catch (e) {
              // Fallback to previous behavior if something goes wrong
              safeEmit("download-done", {
                url: videoUrl,
                title: updates.title,
                fileName: updates.fileName,
                saveDirectory: ""
              });
            }

            // Cleanup process entry
            cleanupProcess(processKey, downloadProcess.pid);

            resolve({
              url: videoUrl,
              title: updates.title,
              status: 'success'
            });

          } else {
            // Handle download failure
            safeEmit("download-failed", {
              title: videoEntry.title,
              url: videoUrl
            });

            resolve({
              url: videoUrl,
              title: videoTitle,
              status: 'failed'
            });
          }

        } catch (error) {
          logger.error(`Error handling download completion: ${error.message}`,
            { pid: downloadProcess.pid });
          reject(error);
        }
      });
    });

  } catch (error) {
    logger.error(`Download error: ${error.message}`);
    return {
      url: videoUrl,
      title: videoTitle,
      status: 'failed',
      error: error.message
    };
  }
}
// Helper function to update process activity timestamp
function updateProcessActivity(processKey) {
  const processEntry = downloadProcesses.get(processKey);
  if (processEntry) {
    processEntry.lastActivity = Date.now();
  }
}
// Helper function to cleanup process entry
function cleanupProcess(processKey, pid) {
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
const ListingSemaphore = {
  maxConcurrent: config.queue.maxListings,
  currentConcurrent: 0,
  queue: [],

  async acquire() {
    return new Promise(resolve => {
      if (this.currentConcurrent < this.maxConcurrent) {
        this.currentConcurrent++;
        logger.debug(`Listing semaphore acquired, current concurrent: ${this.currentConcurrent}`);
        resolve();
      } else {
        logger.debug(`Listing semaphore full, queuing request`);
        this.queue.push(resolve);
      }
    });
  },

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      logger.debug(`Listing semaphore released, current concurrent: ${this.currentConcurrent}`);
      next();
    } else {
      logger.debug(`Listing semaphore released`);
      this.currentConcurrent--;
    }
  },

  setMaxConcurrent(max) {
    this.maxConcurrent = max;
    while (this.currentConcurrent < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      this.currentConcurrent++;
      next();
    }
  }
};
async function processListingRequest(requestBody, response) {
  try {
    // Validate required parameters
    if (!requestBody.urlList) {
      throw new Error("URL list is required");
    }

    // Extract and normalize parameters
    const chunkSize = Math.max(config.chunkSize, +(requestBody.chunkSize ?? config.chunkSize));
    const shouldSleep = requestBody.sleep ?? false;
    const monitoringType = requestBody.monitoringType ?? "N/A";
    const itemsToList = [];
    const uniqueUrls = new Set();

    logger.trace("Processing URL list", {
      urlCount: requestBody.urlList.length,
      chunkSize,
      shouldSleep,
      monitoringType
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
        where: { playlistUrl: normalizedUrl }
      });

      if (playlistEntry) {
        logger.debug(`Playlist found in database`, { url: normalizedUrl });
        if (playlistEntry.monitoringType === monitoringType) {
          logger.debug(`Playlist monitoring hasn't changed so skipping`, { url: normalizedUrl });
          continue; // Skip as it's already monitored
        } else if (playlistEntry.monitoringType !== monitoringType) {
          // If the monitoring type change is Full the reindex the entire playlist,
          // if it is changed to Fast then update from the last index known
          logger.debug(`Playlist monitoring has changed`, { url: normalizedUrl });
          itemsToList.push({
            url: normalizedUrl,
            type: "playlist",
            previousMonitoringType: playlistEntry.monitoringType,
            currentMonitoringType: monitoringType,
            reason: `Monitoring type changed`
          });
        }
      }

      // Look up URL in database as an unlisted video
      const videoEntry = await VideoMetadata.findOne({
        where: { videoUrl: normalizedUrl }
      });
      if (videoEntry) {
        logger.debug(`Video found in database`, { url: normalizedUrl });
        if (videoEntry.downloadStatus) {
          logger.debug(`Video already downloaded`, { url: normalizedUrl });
          continue; // Skip as it's already downloaded
        } else {
          logger.debug(`Video not downloaded yet, updating status`, { url: normalizedUrl });
          itemsToList.push({
            url: normalizedUrl,
            type: "undownloaded",
            currentMonitoringType: "N/A",
            reason: `Video not downloaded yet`
          });
        }
      }

      // If URL is not found in either table, add to list for processing
      if (!playlistEntry && !videoEntry) {
        logger.debug(`URL not found in database, adding to list`, { url: normalizedUrl });
        itemsToList.push({
          url: normalizedUrl,
          type: "undetermined",
          currentMonitoringType: monitoringType,
          reason: `URL not found in database`
        });
      }

      // Add to unique URLs set
      uniqueUrls.add(normalizedUrl);
    }

    // Start listing processes
    listItemsConcurrently(itemsToList, chunkSize, shouldSleep);
    logger.debug(`Listing processes started`, { itemCount: itemsToList.length });

    // Send success response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "success",
      message: "Listing initiated",
      items: itemsToList
    }));
  } catch (error) {
    logger.error("Failed to process URL list", {
      error: error.message,
      stack: error.stack
    });
  }
}
async function listItemsConcurrently(items, chunkSize, shouldSleep) {
  logger.trace(`Listing ${items.length} items concurrently (chunk size: ${chunkSize})`);

  // Update the semaphore's max concurrent value
  ListingSemaphore.setMaxConcurrent(config.queue.maxListings);

  // Process all items with semaphore control
  // TODO: Fix the issue where if two items are added then we are getting
  // Maximum listing processes reached error and the listing is not done
  const listingResults = await Promise.all(
    items.map(item => listWithSemaphore(item, chunkSize, shouldSleep))
  );

  // Check for any failures
  const allSuccessful = listingResults.every(result => result.status === 'success');

  // Log results
  listingResults.forEach(result => {
    if (result.status === 'completed') {
      logger.info(`Listed ${result.title} successfully`);
    } else {
      logger.error(`Failed to list ${result.title}: ${JSON.stringify(result)}`);
    }
  });

  return allSuccessful;
}
async function listWithSemaphore(item, chunkSize, shouldSleep) {
  logger.trace(`Starting listing with semaphore: ${JSON.stringify(item)}`);

  // Check process limit before acquiring semaphore
  if (listProcesses.size >= config.queue.maxListings) {
    logger.info("Maximum listing processes reached", { url: item.url });
    return {
      url: item.url,
      title: "Video",
      status: "failed",
      error: "Maximum listing processes reached"
    };
  }

  // Acquire semaphore before starting listing
  await ListingSemaphore.acquire();

  try {
    const { url: videoUrl, type: itemType, monitoringType } = item;

    // Create pending listing entry
    const listEntry = {
      url: videoUrl,
      type: itemType,
      monitoringType: monitoringType,
      lastActivity: Date.now(),
      spawnTimeStamp: Date.now(),
      status: "pending"
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    listProcesses.set(entryKey, listEntry);

    // Execute listing 
    const result = await executeListing(item, entryKey, chunkSize, shouldSleep);

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
// TODO: Use the processKey to track the listing process in the listProcesses map
// so that stalled processes can be cleaned up by the cleanup cron job
/**
 * Executes the listing process for a given item
 *
 * @param {Object} item - The item to list
 * @param {string} processKey - The key to track the listing process
 * @param {number} chunkSize - The size of each chunk to process
 * @param {boolean} shouldSleep - Whether to introduce a delay between processing chunks
 * @param {boolean} isScheduledUpdate - Indicates if the listing is part of a scheduled update
 * @returns {Promise<Object>} The result of the listing process
 */
async function executeListing(item, processKey, chunkSize, shouldSleep, isScheduledUpdate = false) {
  const { url: videoUrl, currentMonitoringType } = item;
  let itemType = item.type;
  let processedChunks = 0;
  let playlistTitle = "";
  let seekPlaylistListTo = 0;

  try {
    // Send initial status
    safeEmit("listing-started", {
      url: videoUrl,
      type: itemType,
      status: "started"
    });

    // Get initial chunk
    const { startIndex, endIndex } = await determineInitialRange(itemType, currentMonitoringType, videoUrl, chunkSize);
    const responseItems = await fetchVideoInformation(videoUrl, startIndex, endIndex);

    if (responseItems.length === 0) {
      return handleEmptyResponse(videoUrl);
    }

    // Handle single video vs playlist
    const isPlaylist = responseItems.length > 1 || playlistRegex.test(videoUrl) || itemType === "playlist";

    if (isPlaylist) {
      // Check if the playlist already exists
      const existingPlaylist = await PlaylistMetadata.findOne({
        where: { playlistUrl: videoUrl }
      });
      if (existingPlaylist) {
        logger.debug(`Playlist already exists in database`, { url: videoUrl });
        if (existingPlaylist.monitoringType === currentMonitoringType) {
          logger.debug(`Playlist monitoring hasn't changed so skipping`, { url: videoUrl });
          return handleEmptyResponse(videoUrl);
        } else if (existingPlaylist.monitoringType !== currentMonitoringType) {
          logger.debug(`Playlist monitoring has changed`, { url: videoUrl });
          // Update the monitoring type in the database
          await existingPlaylist.update({ monitoringType: currentMonitoringType });
          logger.debug(`Playlist monitoring type updated`, { url: videoUrl });
        }
        playlistTitle = existingPlaylist.title;
      } else {
        // If the playlist doesn't exist, add it to the database
        logger.debug(`Playlist not found in database, adding to database`, { url: videoUrl });
        const newPlaylist = await addPlaylist(videoUrl, currentMonitoringType);
        playlistTitle = newPlaylist.title;
        seekPlaylistListTo = newPlaylist.sortOrder;
      }
      return await handlePlaylistListing({
        videoUrl,
        responseItems,
        startIndex,
        chunkSize,
        shouldSleep,
        isScheduledUpdate,
        processedChunks,
        playlistTitle,
        seekPlaylistListTo
      });
    } else {
      return await handleSingleVideoListing({
        videoUrl,
        responseItems,
        itemType,
        startIndex,
        isScheduledUpdate
      });
    }

  } catch (error) {
    return handleListingError(error, videoUrl, itemType);
  }
}

// Helper functions for executeListing()
/**
 * Determines the initial range of indices for processing items in a playlist.
 *
 * @param {string} itemType - The type of item being processed (e.g., "playlist").
 * @param {string} monitoringType - The monitoring mode, either "Full" for full re-indexing or "Fast" for incremental updates.
 * @param {string} playlistUrl - The URL of the playlist being monitored.
 * @param {number} chunkSize - The size of the chunk to process in each iteration.
 * @returns {Promise<{startIndex: number, endIndex: number}>} An object containing the start and end indices for processing.
 */
async function determineInitialRange(itemType, monitoringType, playlistUrl, chunkSize) {
  let startIndex = 1;
  let endIndex = chunkSize;
  if (itemType === "playlist") {
    if (monitoringType === "Full") {
      // Start from beginning for full reindex
      startIndex = 1;
    } else if (monitoringType === "Fast") {
      // Get last known position for incremental update
      const lastVideo = await PlaylistVideoMapping.findOne({
        where: { playlistUrl },
        order: [["positionInPlaylist", "DESC"]],
        limit: 1
      });
      if (lastVideo) {
        startIndex = lastVideo.positionInPlaylist + 1;
        endIndex = startIndex + chunkSize;
      }
    }
  }
  return { startIndex, endIndex };
}
/**
 * Handles the case where no items are found for a given video URL.
 * Emits a "listing-error" event with the error details and returns an error response object.
 *
 * @param {string} videoUrl - The URL of the video for which no items were found.
 * @returns {Object} An object containing the video URL, a default title, status as "failed",
 *                   and an error message indicating no items were found.
 */
function handleEmptyResponse(videoUrl) {
  safeEmit("listing-error", {
    url: videoUrl,
    error: "No items found"
  });

  return {
    url: videoUrl,
    title: "Video",
    status: "failed",
    error: "No items found"
  };
}
/**
 * Handles the listing of a playlist by processing video information in chunks.
 *
 * @async
 * @function handlePlaylistListing
 * @param {Object} item - The item containing playlist details.
 * @param {string} item.videoUrl - The URL of the video or playlist to process.
 * @param {Array} item.responseItems - The initial set of video information to process.
 * @param {number} item.startIndex - The starting index for processing video information.
 * @param {number} item.chunkSize - The size of each chunk to process.
 * @param {boolean} item.shouldSleep - Whether to introduce a delay between processing chunks.
 * @param {boolean} item.isScheduledUpdate - Indicates if the processing is part of a scheduled update.
 * @param {string} item.playlistTitle - The title of the playlist being processed.
 * @param {number} item.seekPlaylistListTo - The position in the playlist list to seek to after processing.
 * @returns {Promise<void>} Resolves when the playlist listing is complete.
 */
async function handlePlaylistListing(item) {
  const { videoUrl, responseItems, startIndex, chunkSize,
    shouldSleep, isScheduledUpdate, playlistTitle, seekPlaylistListTo } = item;
  let processedChunks = item.processedChunks || 0;
  // Process initial chunk
  const initialResult = await processVideoInformation(responseItems, videoUrl, startIndex, isScheduledUpdate);
  processedChunks++;
  if (initialResult.count < chunkSize) {
    return completePlaylistListing(videoUrl, processedChunks, playlistTitle, seekPlaylistListTo);
  }
  // This is the first chunk, so we need to emit the event
  safeEmit("listing-playlist-chunk-complete", {
    url: videoUrl,
    type: "playlist-chunk",
    status: "chunk-completed",
    processedChunks,
    playlistTitle,
    seekPlaylistListTo
  });
  // Process remaining chunks
  while (true) {
    if (shouldSleep) await sleep();
    const nextStartIndex = startIndex + (processedChunks * chunkSize);
    const nextEndIndex = nextStartIndex + chunkSize;
    const nextItems = await fetchVideoInformation(videoUrl, nextStartIndex, nextEndIndex);
    if (nextItems.length === 0) break;
    const result = await processVideoInformation(nextItems, videoUrl, nextStartIndex, isScheduledUpdate);
    processedChunks++;
    if (result.count < chunkSize) {
      return completePlaylistListing(videoUrl, processedChunks, playlistTitle, seekPlaylistListTo);
    }
    safeEmit("listing-playlist-chunk-complete", {
      url: videoUrl,
      type: "playlist-chunk",
      status: "chunk-completed",
      processedChunks,
      playlistTitle,
      seekPlaylistListTo
    });
  }
  return completePlaylistListing(videoUrl, processedChunks, playlistTitle, seekPlaylistListTo);
}
/**
 * Handles the processing of a single video listing item.
 *
 * @async
 * @function handleSingleVideoListing
 * @param {Object} item - The video listing item to process.
 * @param {string} item.videoUrl - The URL of the video.
 * @param {Array} item.responseItems - The response items containing video information.
 * @param {string} item.itemType - The type of the item (e.g., "undownloaded").
 * @param {number} item.startIndex - The starting index for the video in the playlist.
 * @param {boolean} item.isScheduledUpdate - Indicates if this is a scheduled update.
 * @returns {Promise<Object|undefined>} A promise that resolves to an object containing the video URL, title, status, and processed chunks if successful, or undefined if no processing is needed.
 */
async function handleSingleVideoListing(item) {
  const { videoUrl, responseItems, itemType, startIndex, isScheduledUpdate } = item;
  const playlistUrl = "None";
  if (itemType === "undownloaded") {
    // TODO: Add logic to check if the video still available, if not then update accordingly
    // return await updateExistingVideo(videoUrl);
    return {
      url: videoUrl,
      title: "Video",
      status: "unchanged",
      processedChunks: 0
    }
  }
  // Add new video to "None" playlist
  const lastVideo = await PlaylistVideoMapping.findOne({
    where: { playlistUrl },
    order: [["positionInPlaylist", "DESC"]],
    attributes: ["positionInPlaylist"],
    limit: 1
  });
  const newStartIndex = lastVideo ? lastVideo.positionInPlaylist + 1 : startIndex;
  const result = await processVideoInformation(responseItems, playlistUrl, newStartIndex, isScheduledUpdate);
  if (result.count === 1) {
    safeEmit("listing-single-item-complete", {
      url: videoUrl,
      type: itemType,
      title: result.title,
      status: "completed",
      processedChunks: 1,
      seekSubListTo: newStartIndex
    });
    return {
      url: videoUrl,
      title: result.title,
      status: "completed",
      processedChunks: 1
    };
  }
}
/**
 * Handles errors that occur during the listing process for a video or playlist.
 *
 * @param {Error} error - The error object containing details about the failure.
 * @param {string} videoUrl - The URL of the video or playlist that failed to list.
 * @param {string} itemType - The type of item being listed, either "playlist" or "video".
 * @returns {Object} An object containing details about the failed listing, including the URL, title, status, and error message.
 */
function handleListingError(error, videoUrl, itemType) {
  logger.error("Listing failed", {
    url: videoUrl,
    error: error.message,
    stack: error.stack
  });
  safeEmit("listing-error", {
    url: videoUrl,
    error: error.message
  });
  return {
    url: videoUrl,
    title: itemType === "playlist" ? "Playlist" : "Video",
    status: "failed",
    error: error.message
  };
}
/**
 * Handles completion of playlist listing process and emits completion events
 * 
 * @param {string} videoUrl - URL of the playlist that was processed
 * @param {number} processedChunks - Number of chunks that were processed
 * @param {string} playlistTitle - Title of the playlist
 * @param {number} seekPlaylistListTo - Position in the playlist list to seek to
 * @returns {Object} Object containing url, title, status and processed chunk count
 */
function completePlaylistListing(videoUrl, processedChunks, playlistTitle, seekPlaylistListTo) {
  // Log completion
  logger.info(`Playlist listing completed`, {
    url: videoUrl,
    processedChunks,
    playlistTitle,
    seekPlaylistListTo
  });

  // Emit completion event
  safeEmit("listing-playlist-complete", {
    url: videoUrl,
    type: "playlist",
    status: "completed",
    processedChunks,
    playlistTitle,
    seekPlaylistListTo
  });

  // Return completion status
  return {
    url: videoUrl,
    type: "Playlist",
    status: "completed",
    processedChunks,
    playlistTitle,
    seekPlaylistListTo
  };
}
/**
 * Spawns yt-dlp process to fetch playlist/video information
 *
 * @param {string} videoUrl - URL to fetch information from
 * @param {number} startIndex - Starting index in playlist
 * @param {number} endIndex - Ending index in playlist
 * @returns {Promise<string[]>} Array of video information strings
 * @throws {Error} If process spawn fails or max processes reached
 */
async function fetchVideoInformation(videoUrl, startIndex, endIndex) {
  logger.trace("Fetching video information", {
    url: videoUrl,
    start: startIndex,
    end: endIndex
  });

  return new Promise((resolve, reject) => {
    // Configure process arguments
    const processArgs = [
      "--playlist-start", startIndex.toString(),
      "--playlist-end", endIndex.toString(),
      "--flat-playlist",
      "--print",
      "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s",
      videoUrl
    ];

    // This is a test, will probably be better to filter
    // for site and then apply cookies on a per site basis
    // but for now just check for x.com links as that's the real pain in the ass
    if (config.cookiesFile && isSiteXDotCom(videoUrl)) {
      logger.debug(`Using cookies file: ${config.cookiesFile}`);
      processArgs.unshift(`--cookies`, config.cookiesFile);
    }

    // Quote arguments with spaces
    const fullCommandString = [
      "yt-dlp",
      ...processArgs.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)) // quote args with spaces
    ].join(" ");
    logger.debug(`Starting listing for ${videoUrl}`, {
      url: videoUrl,
      fullCommand: fullCommandString
    });
    // Spawn process
    const listProcess = spawn("yt-dlp", processArgs);

    // Track process
    const processEntry = {
      spawnType: "list",
      spawnedProcess: listProcess,
      lastActivity: Date.now(),
      spawnStatus: "running"
    };
    listProcesses.set(listProcess.pid.toString(), processEntry);

    let responseData = "";

    // Handle stdout
    listProcess.stdout.setEncoding("utf8");
    listProcess.stdout.on("data", data => {
      responseData += data;
      updateProcessActivity(listProcess.pid.toString());
    });

    // Handle stderr
    listProcess.stderr.setEncoding("utf8");
    listProcess.stderr.on("data", data => {
      logger.error("List process error", {
        error: data,
        pid: listProcess.pid
      });
      updateProcessActivity(listProcess.pid.toString());
    });

    // Handle process error
    listProcess.on("error", error => {
      logger.error("Failed to spawn list process", {
        error: error.message,
        pid: listProcess.pid
      });

      const processCache = listProcesses.get(listProcess.pid.toString());
      if (processCache) {
        processCache.spawnStatus = "failed";
      }
    });

    // Handle process completion
    listProcess.on("close", code => {
      const processCache = listProcesses.get(listProcess.pid.toString());

      if (code !== 0) {
        logger.error("List process failed", {
          code: code,
          pid: listProcess.pid
        });

        if (processCache) {
          processCache.spawnStatus = "failed";
        }
      }

      // Cleanup process entry
      const removed = listProcesses.delete(listProcess.pid.toString());
      logger.debug("List process completed", {
        pid: listProcess.pid,
        code: code,
        removed: removed
      });

      // Return filtered results
      resolve(responseData.split("\n").filter(line => line.length > 0));
    });
  });
}
/**
 * Processes video information and updates database records
 *
 * @param {string[]} responseItems - Array of video information strings
 * @param {string} playlistUrl - URL of playlist being processed
 * @param {number} startIndex - Starting index for processing
 * @param {boolean} isUpdate - Whether this is an update operation
 * @returns {Promise<Object>} Processing results including counts and status
 */
async function processVideoInformation(responseItems, playlistUrl, startIndex, isUpdate) {
  logger.trace("Processing video information", {
    playlistUrl,
    startIndex,
    isUpdate,
    itemCount: responseItems.length
  });

  const result = {
    count: 0,
    title: "",
    responseUrl: playlistUrl,
    startIndex: startIndex,
  };

  // Get last processed index for updates
  let lastProcessedIndex = 0;
  if (isUpdate) {
    logger.debug("Processing update for playlist", { playlistUrl });
    // Get last processed index from database
    const lastItem = await PlaylistVideoMapping.findOne({
      where: { playlistUrl: playlistUrl },
      order: [["positionInPlaylist", "DESC"]],
      attributes: ["positionInPlaylist"],
      limit: 1
    });

    lastProcessedIndex = lastItem ? lastItem.positionInPlaylist + 1 : 1;
    logger.debug("Found last processed index", { index: lastProcessedIndex });
  }

  // Check for existing items
  const existingItems = await Promise.all([
    // Check VideoMetadata table
    Promise.all(responseItems.map(async item => {
      const videoUrl = item.split("\t")[2];
      return await VideoMetadata.findOne({
        where: { videoUrl: videoUrl }
      });
    })),
    // Check PlaylistVideoMapping table
    Promise.all(responseItems.map(async item => {
      const videoUrl = item.split("\t")[2];
      return await PlaylistVideoMapping.findOne({
        where: {
          videoUrl: videoUrl,
          playlistUrl: playlistUrl
        }
      });
    }))
  ]);

  const [existingVideos, existingIndexes] = existingItems;
  const allExist = existingVideos.every(v => v) && existingIndexes.every(i => i);

  if (allExist) {
    logger.debug("All videos already exist in database");
    result.count = existingIndexes.length;
    return result;
  }

  // Process items
  await Promise.all(responseItems.map(async (item, index) => {
    try {
      const [title, videoId, videoUrl, approxSize] = item.split("\t");

      // Prepare video data
      const videoData = {
        videoId: videoId.trim(),
        title: await truncateText(
          title === "NA" ? videoId.trim() : title,
          config.maxTitleLength
        ),
        approximateSize: approxSize === "NA" ? -1 : parseInt(approxSize),
        downloadStatus: false,
        isAvailable: !["[Deleted video]", "[Private video]", "[Unavailable video]"].includes(title)
      };

      // Update or create video record
      if (!existingVideos[index]) {
        await VideoMetadata.create({
          videoUrl: videoUrl,
          ...videoData
        });
      } else {
        await updateVideoMetadata(existingVideos[index], videoData);
      }

      // Create index record if needed
      if (!existingIndexes[index]) {
        await PlaylistVideoMapping.create({
          videoUrl: videoUrl,
          playlistUrl: playlistUrl,
          positionInPlaylist: startIndex + index + lastProcessedIndex
        });
      }

      result.count++;
      result.title = videoData.title;
      logger.debug("Processed video item", {
        videoUrl: videoUrl,
        title: videoData.title,
        playlistUrl: playlistUrl,
        index: startIndex + index + lastProcessedIndex
      });

    } catch (error) {
      logger.error("Failed to process video item", {
        error: error.message,
        item: item
      });
    }
  }));

  return result;
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
async function updateVideoMetadata(existingVideo, newData) {
  logger.trace("Checking video metadata for updates", {
    videoId: existingVideo.videoId,
    newData: newData
  });

  const differences = [];
  let requiresUpdate = false;

  // Check for differences
  if (existingVideo.videoId !== newData.videoId) {
    differences.push({
      field: 'videoId',
      old: existingVideo.videoId,
      new: newData.videoId
    });
    requiresUpdate = true;
  }

  if (+existingVideo.approximateSize !== +newData.approximateSize) {
    differences.push({
      field: 'approximateSize',
      old: existingVideo.approximateSize,
      new: newData.approximateSize
    });
    requiresUpdate = true;
  }

  if (existingVideo.title !== newData.title) {
    differences.push({
      field: 'title',
      old: existingVideo.title,
      new: newData.title
    });
    requiresUpdate = true;
  }

  if (existingVideo.isAvailable !== newData.isAvailable) {
    differences.push({
      field: 'isAvailable',
      old: existingVideo.isAvailable,
      new: newData.isAvailable
    });
    requiresUpdate = true;
  }

  // Perform update if needed
  if (requiresUpdate) {
    logger.warn("Video metadata changes detected", { differences });

    Object.assign(existingVideo, {
      videoId: newData.videoId,
      approximateSize: +newData.approximateSize,
      title: newData.title,
      isAvailable: newData.isAvailable
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
async function updatePlaylistMonitoring(requestBody, response) {
  try {
    // Validate required parameters
    if (!requestBody.url || !requestBody.watch) {
      throw new Error("URL and monitoring type are required");
    }

    const playlistUrl = requestBody.url;
    const monitoringType = requestBody.watch;

    logger.trace("Updating playlist monitoring type", {
      playlistUrl,
      monitoringType
    });

    // Find playlist in database
    const playlist = await PlaylistMetadata.findOne({
      where: { playlistUrl: playlistUrl }
    });

    if (!playlist) {
      throw new Error("Playlist not found");
    }

    // Update monitoring type
    await playlist.update(
      { monitoringType: monitoringType },
      { silent: true }
    );

    logger.debug("Successfully updated monitoring type", {
      playlistUrl,
      oldType: playlist.monitoringType,
      newType: monitoringType
    });

    // Send success response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "success",
      message: "Monitoring type updated successfully"
    }));

  } catch (error) {
    // Log error details
    logger.error("Failed to update monitoring type", {
      error: error.message,
      stack: error.stack
    });

    // Send error response
    const statusCode = error.status || 500;
    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      status: "error",
      message: he.escape(error.message)
    }));
  }
}
/**
 * Adds a new playlist to the database with metadata from yt-dlp
 *
 * @param {string} playlistUrl - The URL of the playlist
 * @param {string} monitoringType - The type of monitoring to apply
 * @return {Promise<void>} Resolves when playlist is added to database
 * @throws {Error} If playlist creation fails or max listing processes reached
 */
async function addPlaylist(playlistUrl, monitoringType) {
  let playlistTitle = "";
  let nextPlaylistIndex = 0;

  // Get the last playlist index
  const lastPlaylist = await PlaylistMetadata.findOne({
    order: [["sortOrder", "DESC"]],
    attributes: ["sortOrder"],
    limit: 1
  });

  if (lastPlaylist !== null) {
    nextPlaylistIndex = lastPlaylist.sortOrder + 1;
  }

  // Check if we've hit the process limit
  if (listProcesses.size >= config.queue.maxListings) {
    logger.info("Maximum listing processes reached", { url: playlistUrl });
    throw new Error("Maximum listing processes reached");
  }

  const processArgs = [
    "--playlist-end", "1",
    "--flat-playlist",
    "--print", "%(playlist_title)s",
    playlistUrl
  ];
  // Playlist are not something that exists on x.com but a post can have 
  // multiple videos so we need to use cookies for those links,
  // The listed videos will all have the same link with a different id
  // which this code can't handle yet, you will get only one item in the
  // playlist generated from it (hopefully the first one) but downloading that
  // will make yt-dlp get the rest of the items in the post, check the folder.
  if (config.cookiesFile && isSiteXDotCom(playlistUrl)) {
    logger.debug(`Using cookies file: ${config.cookiesFile}`);
    processArgs.unshift("--cookies", config.cookiesFile);
  }
  const fullCommandString = [
    "yt-dlp",
    ...processArgs.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)) // quote args with spaces
  ].join(" ");
  logger.debug("Trying to get playlist title", {
    url: playlistUrl,
    fullCommand: fullCommandString
  });
  // Spawn process to get playlist title
  const titleProcess = spawn("yt-dlp", processArgs);

  return new Promise((resolve, reject) => {
    // Handle stdout
    titleProcess.stdout.setEncoding("utf8");
    titleProcess.stdout.on("data", data => {
      playlistTitle += data;
    });

    // Handle stderr
    titleProcess.stderr.setEncoding("utf8");
    titleProcess.stderr.on("data", data => {
      logger.error(`Error getting playlist title: ${data}`);
    });

    // Handle process errors
    titleProcess.on("error", error => {
      logger.error(`Title process error: ${error.message}`);
      reject(error);
    });

    // Handle process completion
    titleProcess.on("close", async code => {
      try {
        if (code !== 0) {
          logger.error(`Title process failed with code: ${code}`);
          throw new Error("Failed to get playlist title");
        }

        // Handle empty or NA title
        if (!playlistTitle || playlistTitle.toString().trim() === "NA") {
          try {
            playlistTitle = await urlToTitle(playlistUrl);
          } catch (error) {
            logger.error(`Failed to get title from URL: ${error.message}`);
            playlistTitle = playlistUrl;
          }
        }

        // Trim title to max length
        playlistTitle = await truncateText(playlistTitle, config.maxTitleLength);
        logger.debug(`Creating playlist with title: ${playlistTitle}`, {
          url: playlistUrl,
          pid: titleProcess.pid,
          code: code,
          monitoringType: monitoringType
        });

        // Create playlist entry
        const [playlist, created] = await PlaylistMetadata.findOrCreate({
          where: { playlistUrl: playlistUrl },
          defaults: {
            title: playlistTitle.trim(),
            monitoringType: monitoringType,
            saveDirectory: playlistTitle.trim(),
            // Order in which playlists are displayed or Index
            sortOrder: nextPlaylistIndex
          }
        });

        if (!created) {
          logger.warn("Playlist already exists", { url: playlistUrl });
        }

        resolve(playlist);

      } catch (error) {
        logger.error("Failed to create playlist", {
          url: playlistUrl,
          error: error.message
        });
        reject(error);
      }
    });
  });
}

// List function that send data to frontend
/**
 * Retrieves paginated playlist data with sorting and filtering options for frontend display
 *
 * @param {Object} requestBody - The request parameters
 * @param {number} [requestBody.start=0] - Starting index for pagination
 * @param {number} [requestBody.stop=config.chunkSize] - End index for pagination
 * @param {number} [requestBody.sort=1] - Sort column (1: sortOrder, 3: updatedAt)  
 * @param {number} [requestBody.order=1] - Sort order (1: ASC, 2: DESC)
 * @param {string} [requestBody.query=""] - Search query to filter playlists by title
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when playlist data is sent to frontend
 * @throws {Error} If database query fails
 */
async function getPlaylistsForDisplay(requestBody, response) {
  try {
    // Extract and validate parameters
    const startIndex = requestBody.start !== undefined ? +requestBody.start : 0;
    const pageSize = requestBody.stop !== undefined ? +requestBody.stop - startIndex : config.chunkSize;
    const sortColumn = requestBody.sort !== undefined ? +requestBody.sort : 1;
    const sortOrder = requestBody.order !== undefined ? +requestBody.order : 1;
    const searchQuery = requestBody.query !== undefined ? requestBody.query : "";

    // Determine sort settings
    const sortDirection = sortOrder === 2 ? "DESC" : "ASC";
    const sortBy = sortColumn === 3 ? "updatedAt" : "sortOrder";

    logger.trace(
      `Fetching playlists for display`, {
      startIndex,
      pageSize,
      sortBy,
      sortDirection,
      searchQuery
    }
    );

    // Build base query
    const queryOptions = {
      where: {
        sortOrder: {
          [Op.gte]: 0 // Filter out system playlists
        }
      },
      limit: pageSize,
      offset: startIndex,
      order: [[sortBy, sortDirection]]
    };

    // Add search filter if query provided
    if (searchQuery) {
      queryOptions.where.title = {
        [Op.iLike]: `%${searchQuery}%`
      };
    }

    // Execute query and send response
    const results = await PlaylistMetadata.findAndCountAll(queryOptions);

    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify(results));

  } catch (error) {
    logger.error("Failed to fetch playlists", {
      error: error.message,
      stack: error.stack
    });

    const statusCode = error.status || 500;
    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      error: he.escape(error.message)
    }));
  }
}
/**
 * Retrieves paginated video list data for a specific playlist with filtering and sorting options
 *
 * @param {Object} requestBody - Request parameters
 * @param {string} [requestBody.url="None"] - Playlist URL to fetch videos from
 * @param {number} [requestBody.start=0] - Starting index for pagination
 * @param {number} [requestBody.stop=config.chunkSize] - End index for pagination
 * @param {string} [requestBody.query=""] - Search query to filter videos by title
 * @param {boolean} [requestBody.sortDownloaded=false] - Whether to sort by download status
 * @param {Object} response - HTTP response object
 * @returns {Promise<void>} Resolves when video data is sent to frontend
 * @throws {Error} If database query fails
 */
async function getPlaylistVideos(requestBody, response) {
  try {
    // Extract and validate parameters
    const playlistUrl = requestBody.url ?? "None";
    const startIndex = Math.max(0, +(requestBody.start ?? 0));
    const endIndex = +(requestBody.stop ?? config.chunkSize);
    const searchQuery = requestBody.query ?? "";
    const sortByDownloaded = requestBody.sortDownloaded ?? false;

    // Determine sort order
    const sortOrder = sortByDownloaded
      ? [VideoMetadata, "downloadStatus", "DESC"]
      : ["positionInPlaylist", "ASC"];

    logger.trace("Fetching playlist videos", {
      startIndex,
      endIndex,
      searchQuery,
      sortBy: sortByDownloaded ? "downloadStatus" : "positionInPlaylist",
      sortDirection: sortByDownloaded ? "DESC" : "ASC",
      playlistUrl
    });

    // Build base query options
    const queryOptions = {
      attributes: ["positionInPlaylist", "playlistUrl"],
      include: [{
        attributes: [
          "title",
          "videoId",
          "videoUrl",
          "downloadStatus",
          "isAvailable",
          "fileName",
        ],
        model: VideoMetadata,
        ...(searchQuery && {
          where: {
            title: { [Op.iLike]: `%${searchQuery}%` }
          }
        })
      }],
      where: { playlistUrl: playlistUrl },
      limit: endIndex - startIndex,
      offset: startIndex,
      order: [sortOrder]
    };

    // Execute query
    const results = await PlaylistVideoMapping.findAndCountAll(queryOptions);

    // Fetch playlist save directory
    let playlistSaveDir = "";
    try {
      const playlist = await PlaylistMetadata.findOne({ where: { playlistUrl } });
      playlistSaveDir = playlist?.saveDirectory ?? "";
    } catch (err) {
      logger.warn('Could not fetch playlist saveDirectory', { playlistUrl, error: err.message });
    }

    const safeRows = results.rows.map((row) => {
      const vm = row.video_metadatum || {};
      let fileName = null;
      try {
        if (vm.fileName && typeof vm.fileName === 'string') {
          fileName = vm.fileName;
        }
      } catch (e) {
        fileName = null;
      }
      // Build a sanitized video_metadatum to return to client
      const safeVideoMeta = {
        title: vm.title,
        videoId: vm.videoId,
        videoUrl: vm.videoUrl,
        downloadStatus: vm.downloadStatus,
        isAvailable: vm.isAvailable,
        fileName: fileName
      };

      return {
        positionInPlaylist: row.positionInPlaylist,
        playlistUrl: row.playlistUrl,
        video_metadatum: safeVideoMeta
      };
    });

    const safeResult = { count: results.count, rows: safeRows, saveDirectory: playlistSaveDir };

    // Send response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify(safeResult));

  } catch (error) {
    logger.error("Failed to fetch playlist videos", {
      error: error.message,
      stack: error.stack
    });

    const statusCode = error.status || 500;
    response.writeHead(statusCode, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify({
      error: he.escape(error.message)
    }));
  }
}

// Functions to run the server
// TODO: Update these as well
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
  contentType,
  {
    allowedOrigins = CORS_ALLOWED_ORIGINS,
    allowedMethods = CORS_ALLOWED_HEADERS,
    maxAge = config.defaultCORSMaxAge
  } = {}
) {
  return {
    'Access-Control-Allow-Origin': allowedOrigins.join(', '),
    'Access-Control-Allow-Methods': allowedMethods.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': maxAge,
    'Content-Type': contentType
  };
}

/**
 * Recursively retrieves a list of files and their corresponding extensions from a given directory.
 *
 * @param {string} dir - The directory path to start retrieving files from.
 * @return {Array<{filePath: string, extension: string}>} An array of objects containing the file path and extension of each file found in the directory and its subdirectories.
 */
function getFiles(dir) {
  const files = fs.readdirSync(dir);
  let fileList = [];

  files.forEach((file) => {
    const filePath = path_fs.join(dir, file);
    const extension = path_fs.extname(filePath);
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
 * @return {Object<string, {file: Buffer, type: string}>} - The dictionary of static assets, where the key is the file path and the value is an object containing the file content and its type.
 */
function makeAssets(fileList) {
  const staticAssets = {};
  fileList.forEach((element) => {
    staticAssets[element.filePath.replace("dist", config.urlBase)] = {
      file: fs.readFileSync(element.filePath),
      type: MIME_TYPES[element.extension],
    };
  });
  staticAssets[`${config.urlBase}/`] = staticAssets[`${config.urlBase}/index.html`];
  staticAssets[config.urlBase] = staticAssets[`${config.urlBase}/index.html`];
  staticAssets[`${config.urlBase}/.gz`] = staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}.gz`] = staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}/.br`] = staticAssets[`${config.urlBase}/index.html.br`];
  staticAssets[`${config.urlBase}.br`] = staticAssets[`${config.urlBase}/index.html.br`];
  staticAssets[`${config.urlBase}/ping`] = { file: "pong", type: MIME_TYPES[".txt"] };
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets = makeAssets(filesList);
let serverOptions = {};
let serverObj = null;

if (config.nativeHttps) {
  try {
    serverOptions = {
      key: fs.readFileSync(config.ssl.key, "utf8"),
      cert: fs.readFileSync(config.ssl.cert, "utf8"),
      // If passphrase is not set, don't include it in options
      ...(config.ssl.passphrase && { passphrase: config.ssl.passphrase })
    };
  } catch (error) {
    logger.error("Error reading SSL key and/or certificate files:", error);
    process.exit(1);
  }
  if (config.ssl.passphrase) {
    logger.info("SSL passphrase is set");
  }
  if (config.protocol === "http") {
    logger.warn("Protocol is set to HTTP but nativeHttps is enabled. Overriding protocol to HTTPS.");
    config.protocol = "https";
  }
  logger.info("Starting server in HTTPS mode");
  serverObj = https;
} else {
  if (config.protocol === "https") {
    logger.warn("Protocol is set to HTTPS but nativeHttps is disabled. Overriding protocol to HTTP.");
    config.protocol = "http";
  }
  logger.info("Starting server in HTTP mode");
  serverObj = http;
}

const server = serverObj.createServer(serverOptions, (req, res) => {
  if (req.url.startsWith(config.urlBase) && req.method === "GET") {
    try {
      const get = req.url;
      const reqEncoding = req.headers["accept-encoding"] || "";
      logger.trace(`Request Received`, {
        path: req.url,
        method: req.method,
        encoding: reqEncoding,
      });
      // Check if the requested file exists in the static assets
      if (!staticAssets[get]) {
        logger.error("Requested Resource couldn't be found", {
          path: req.url,
          method: req.method,
          encoding: reqEncoding,
        });
        res.writeHead(404, generateCorsHeaders(MIME_TYPES[".html"]));
        res.write("Not Found");
        return res.end();
      }
      const resHeaders = generateCorsHeaders(staticAssets[get].type);
      if (reqEncoding.includes("br") && staticAssets[get + ".br"]) {
        resHeaders["Content-Encoding"] = "br";
        res.writeHead(200, resHeaders);
        res.write(staticAssets[get + ".br"].file);
        return res.end();
      } else if (reqEncoding.includes("gzip") && staticAssets[get + ".gz"]) {
        resHeaders["Content-Encoding"] = "gzip";
        res.writeHead(200, resHeaders);
        res.write(staticAssets[get + ".gz"].file);
        return res.end();
      } else {
        res.writeHead(200, resHeaders);
        res.write(staticAssets[get].file);
      }
    } catch (error) {
      logger.error("Error in processing request", {
        path: req.url,
        method: req.method,
        error: error,
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
  } else if (req.url === config.urlBase + "/list" && req.method === "POST") {
    authenticateRequest(req, res, processListingRequest);
  } else if (req.url === config.urlBase + "/download" && req.method === "POST") {
    authenticateRequest(req, res, processDownloadRequest);
  } else if (req.url === config.urlBase + "/watch" && req.method === "POST") {
    authenticateRequest(req, res, updatePlaylistMonitoring);
  } else if (req.url === config.urlBase + "/getplay" && req.method === "POST") {
    authenticateRequest(req, res, getPlaylistsForDisplay);
  } else if (req.url === config.urlBase + "/getsub" && req.method === "POST") {
    authenticateRequest(req, res, getPlaylistVideos);
  } else if (req.url === config.urlBase + "/getfile" && req.method === "POST") {
    authenticateRequest(req, res, serveFileByPath);
  } else if (req.url === config.urlBase + "/register" && req.method === "POST") {
    rateLimit(req, res, registerUser, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  } else if (req.url === config.urlBase + "/login" && req.method === "POST") {
    rateLimit(req, res, authenticateUser, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  } else if (req.url === config.urlBase + "/isregallowed" && req.method === "POST") {
    rateLimit(req, res, isRegistrationAllowed, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  } else {
    logger.error("Requested Resource couldn't be found", {
      path: req.url,
      method: req.method
    });
    res.writeHead(404, generateCorsHeaders(MIME_TYPES[".html"]));
    res.write("Not Found");
    res.end();
  }
});

const io = new Server(server, {
  path: config.urlBase + "/socket.io/",
  cors: {
    // cors will only happen on these so it's best to keep it limited
    origin: CORS_ALLOWED_ORIGINS,
  },
});

io.use((socket, next) => {
  authenticateSocket(socket).then((result) => {
    if (result) {
      logger.debug("Valid socket", {
        id: socket.id,
        ip: socket.handshake.address,
      });
      next();
    }
    else {
      logger.error("Invalid socket", {
        id: socket.id,
        ip: socket.handshake.address
      });
      next(new Error("Invalid socket"));
    }
  }).catch((err) => {
    logger.error("Error in verifying socket", {
      id: socket.id,
      ip: socket.handshake.address,
      error: err
    });
    next(new Error(err.message));
  });
});

const sock = io.on("connection", (socket) => {
  if (config.connectedClients >= config.maxClients) {
    logger.info("Rejecting client", {
      id: socket.id,
      ip: socket.handshake.address,
      reason: "Server full",
    });
    socket.emit("connection-error", "Server full");
    // Disconnect the client
    socket.disconnect(true);
    return;
  }

  // Increment the count of connected clients
  socket.emit("init", { message: "Connected", id: socket.id });
  socket.on("acknowledge", ({ data, id }) => {
    logger.info(`Acknowledged from client id ${id}`, {
      id: id,
      ip: socket.handshake.address,
      data: data
    });
    config.connectedClients++;
  });

  socket.on("disconnect", () => {
    // Decrement the count of connected clients when a client disconnects
    logger.info(`Disconnected from client id ${socket.id}`, {
      id: socket.id,
      ip: socket.handshake.address,
    });
    config.connectedClients--;
  });
  return socket;
});

server.listen(config.port, async () => {
  if (config.hidePorts) {
    logger.info(`Server listening on ${config.protocol}://${config.host}${config.urlBase}`);
  } else {
    logger.info(`Server listening on ${config.protocol}://${config.host}:${config.port}${config.urlBase}`);
  }
  // I do not really know if calling these here is a good idea, but how else can I even do it?
  const start = Date.now();
  await sleep(config.sleepTime);
  const elapsed = Date.now() - start;
  logger.info("Sleep duration: " + elapsed / 1000 + " seconds");
  logger.verbose(
    `Download Options: yt-dlp ${downloadOptions.join(" ")} --paths "${config.saveLocation.endsWith("/") ? config.saveLocation : config.saveLocation + "/"}` +
    `{playlist_dir}" "{url}"`
  );
  logger.verbose(
    "List Options: yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
    `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {bodyUrl}`
  );
  for (const [name, job] of Object.entries(jobs)) {
    job.start();
    logger.info(`Started ${name} job`, {
      schedule: job.cronTime.source,
      nextRun: job.nextDate().toLocaleString(
        {
          weekday: 'short', month: 'short', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        },
        { timeZone: config.timeZone })
    });
  }
});
