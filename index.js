"use strict";
const { Sequelize, DataTypes, Op } = require("sequelize");
const { spawn } = require("child_process");
const color = require("cli-color");
const CronJob = require("cron").CronJob;
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const he = require('he');
const { LRUCache } = require('lru-cache');
const { Server } = require("socket.io");
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

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
    maxItems: +process.env.CACHE_MAX_ITEMS || 100,
    maxAge: +process.env.CACHE_MAX_AGE || 3600, // keep cache for 1 hour
    reqPerIP: +process.env.MAX_REQUESTS_PER_IP || 10
  },
  queue: {
    maxListings: +process.env.MAX_LISTINGS || 2,
    maxDownloads: +process.env.MAX_DOWNLOADS || 2,
    cleanUpInterval: process.env.CLEANUP_INTERVAL || "*/10 * * * *", // every 10 minutes
    maxIdle: +process.env.PROCESS_MAX_AGE || 5 * 60 * 1000, // 5 minutes
  },
  registration: {
    allowed: process.env.ALLOW_REGISTRATION !== "false",
    maxUsers: +(process.env.MAX_USERS || 15)
  },
  saveLocation: process.env.SAVE_PATH || "/home/sagnik/Documents/syncthing/pi5/yt-dlp/",
  cookiesFile: process.env.COOKIES_FILE
    ? fs.existsSync(process.env.COOKIES_FILE)
      ? process.env.COOKIES_FILE : new Error(`Cookies file not found: ${process.env.COOKIES_FILE}`)
    : false,
  proxy_string: process.env.PROXY_STRING_FILE
    ? fs.readFileSync(process.env.PROXY_STRING_FILE, "utf8").trim().replace(/['"\n]+/g, '')
    : process.env.PROXY_STRING && process.env.PROXY_STRING.trim()
      ? `${process.env.PROXY_STRING.trim().replace(/['"\n]+/g, '')}` // make sure it's not quoted
      : "", // if both are not set, proxy will be empty i.e. direct connection
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
  "--progress",
  "--embed-metadata",
  "--embed-chapters",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveDescription ? "--write-description" : "",
  config.saveComments ? "--write-comments" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  config.restrictFilenames ? "--restrict-filenames" : "",
  "-P", "temp:/tmp",
  "-o", config.restrictFilenames ? "%(id)s.%(ext)s" : "%(title)s[%(id)s].%(ext)s",
  "--print", "before_dl:title:%(title)s [%(id)s]",
  "--print", config.restrictFilenames ? "post_process:\"fileName:%(id)s.%(ext)s\"" : "post_process:\"fileName:%(title)s[%(id)s].%(ext)s\"",
  "--progress-template", "download-title:%(info.id)s-%(progress.eta)s",
  ...(config.proxy_string ? ["--proxy", config.proxy_string] : []),
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
const createSecurityCacheConfig = (maxBytes, maxItems, ttl) => ({
  max: maxItems, // Maximum number of items to store in the cache
  ttl: ttl * 1000, // Time-to-live for each item in milliseconds
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
  maxSize: maxBytes, // Maximum total size of all cache items in bytes
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

const userCache = new LRUCache(createSecurityCacheConfig(1024, config.cache.maxItems, config.cache.maxAge)); // 1KB for users
const ipCache = new LRUCache(createSecurityCacheConfig(1024 * 10, config.cache.maxItems, config.cache.maxAge)); // 10KB for IPs
const signedUrlCache = new LRUCache(createSecurityCacheConfig(3 * 1024 * 1024, config.cache.maxItems, config.cache.maxAge)); // 3MB for signed URLs as each file is around < 128 bytes

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
  thumbNailFile: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Thumbnail generated by yt-dlp"
  },
  subTitleFile: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Subtitle generated by yt-dlp"
  },
  commentsFile: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Comments file generated by yt-dlp"
  },
  descriptionFile: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Description retrieved by yt-dlp, not sure yet if I will save the path or read the data and save it here."
  },
  isMetaDataSynced: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "This will serve as a marker for other processes to know if they need to sync metadata from downloaded files"
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
  },
  lastUpdatedByScheduler: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: "Timestamp of the last update made by the scheduler, default value is createdAt"
  },
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
        lastUpdatedByScheduler: new Date(0),
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
  cleanup: new CronJob(
    config.queue.cleanUpInterval,
    () => {
      logger.debug("Starting scheduled process cleanup");
      // Cleanup download processes
      const cleanedDownloads = cleanupStaleProcesses(
        downloadProcesses,
        {
          maxIdleTime: config.queue.maxIdle,
          forceKill: true
        },
        "download"
      );
      // Cleanup list processes
      const cleanedLists = cleanupStaleProcesses(
        listProcesses,
        {
          maxIdleTime: config.queue.maxIdle,
          forceKill: true
        },
        "list"
      );
      logger.info("Completed scheduled process cleanup", {
        cleanedDownloads,
        cleanedLists,
        nextRun: jobs.cleanup.nextDate().toLocaleString(
          {
            weekday: 'short', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
          }, { timeZone: config.timeZone })
      });
    },
    null,
    true,
    config.timeZone
  ),
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
  let hostname = "";
  try {
    hostname = (new URL(url)).hostname;
  } catch (e) {
    logger.warn(`Invalid videoUrl: ${videoUrl}`, { error: e.message });
  }
  // Non-exhaustive list of YouTube hostnames, can be expanded as needed
  // Also handles youtu.be short URLs
  // https://support.google.com/youtube/answer/6180214?hl=en
  const youtubeHostNames = ['youtube.com', 'www.youtube.com',
    'youtu.be', 'www.youtu.be',
    'm.youtube.com', 'www.m.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com'];
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
  let allow = true;
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
      logger.warn(`Authentication failed for user ${userName}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      logger.warn(`Authentication failed for user ${userName}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Generate token
    const token = generateAuthToken(user, expiryTime);
    logger.info(`Authentication successful for user ${userName}`);

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
/**
 * Create a time-limited, signed identifier for serving a file and write the result to the HTTP response.
 *
 * Validations and behavior:
 * - Expects a requestBody with at least `fileName` (string). `saveDirectory` is optional.
 * - Validates `fileName` is a non-empty string; responds with 400 if missing/invalid.
 * - Joins `config.saveLocation`, `saveDirectory` and `fileName` using path_fs.join, resolves the result,
 *   and verifies the resolved path is inside the configured save root (path traversal protection).
 *   If the resolved path is outside the save root, responds with 400.
 * - Checks if a valid (non-expired) signed URL already exists for this file path. If found, reuses it.
 * - On success, generates a UUID (via crypto.randomUUID()), computes an expiry timestamp (Date.now() + config.cache.maxAge * 1000),
 *   and stores an entry in `signedUrlCache` with key = UUID and value = { filePath, mimeType, expiry }.
 *   The cache entry is stored with a TTL equal to `config.cache.maxAge` (the code treats this value as seconds).
 * - Responds with 200 and a JSON body: { status: 'success', signedUrlId, expiry } where `expiry` is an epoch timestamp in milliseconds.
 *
 * Side effects:
 * - Writes HTTP headers and body to the provided `response` (uses response.writeHead and response.end).
 * - Emits warnings via `logger.warn` on invalid input or path traversal attempts.
 * - Mutates `signedUrlCache` by inserting the signed URL mapping.
 *
 * Notes:
 * - The function is async and resolves after writing to the response, but it handles error responses itself (no exceptions propagated).
 * - Default MIME type for the cached entry is "application/octet-stream".
 * - The implementation relies on external symbols: config, path_fs, signedUrlCache, logger, generateCorsHeaders, MIME_TYPES, crypto.
 *
 * @async
 * @param {Object} requestBody - Parsed request payload.
 * @param {string} [requestBody.saveDirectory] - Optional subdirectory (relative to config.saveLocation) containing the file.
 * @param {string} requestBody.fileName - Name of the file to serve; must be a non-empty string.
 * @param {import('http').ServerResponse} response - The Node.js HTTP response object used to send status and body.
 * @returns {Promise<void>} Resolves after sending the HTTP response. On success sends JSON with { status, signedUrlId, expiry }. On error sends a 400 JSON error.
 */
async function makeSignedUrl(requestBody, response) {
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
    const joined = path.join(config.saveLocation, saveDirectory || '', fileName);
    const resolved = path.resolve(joined);
    const saveRoot = path.resolve(config.saveLocation);
    if (!resolved.startsWith(saveRoot)) {
      logger.warn('serveFileByPath attempted path traversal', { saveDirectory, fileName, resolved });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'Invalid file path' }));
    }
    logger.debug(`Resolved Path ${resolved}`, {
      joined,
      resolved,
      saveRoot
    })
    if (fs.existsSync(resolved))
      absolutePath = resolved;
    else {
      response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'error', message: 'File could not be found' }));
    }
  } else {
    logger.warn('makeSignedUrl missing parameters', { requestBody });
    response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
    return response.end(JSON.stringify({ status: 'error', message: 'saveDirectory and fileName are required' }));
  }

  // Check if a valid signed URL already exists for this file path
  const now = Date.now();
  for (const [existingId, cacheEntry] of signedUrlCache.entries()) {
    if (cacheEntry.filePath === absolutePath && cacheEntry.expiry > now) {
      // Extend the expiry for the existing entry
      const newExpiry = Date.now() + config.cache.maxAge * 1000;
      cacheEntry.expiry = newExpiry;
      signedUrlCache.set(existingId, cacheEntry, config.cache.maxAge);

      logger.debug('Reusing existing signed URL with extended expiry', {
        signedUrlId: existingId,
        filePath: absolutePath,
        newExpiry
      });
      response.writeHead(200, generateCorsHeaders(MIME_TYPES['.json']));
      return response.end(JSON.stringify({ status: 'success', signedUrlId: existingId, expiry: newExpiry }));
    }
  }

  // No valid entry found, create a new one
  const signedUrlId = crypto.randomUUID();
  const expiry = Date.now() + config.cache.maxAge * 1000;
  signedUrlCache.set(signedUrlId, { filePath: absolutePath, mimeType: "application/octet-stream", expiry }, config.cache.maxAge);
  response.writeHead(200, generateCorsHeaders(MIME_TYPES['.json']));
  response.end(JSON.stringify({ status: 'success', signedUrlId: signedUrlId, expiry }));
}

/**
 * Generates signed URLs for a list of files.
 * 
 * @param {Object} requestBody - The request body containing the list of files.
 * @param {http.ServerResponse} response - The HTTP response object.
 */
async function makeSignedUrls(requestBody, response) {
  if (!requestBody || !requestBody.files || !Array.isArray(requestBody.files)) {
    logger.warn('makeSignedUrls missing or invalid parameters', { requestBody });
    response.writeHead(400, generateCorsHeaders(MIME_TYPES['.json']));
    return response.end(JSON.stringify({ status: 'error', message: 'files array is required' }));
  }

  const results = {};
  const now = Date.now();

  for (const file of requestBody.files) {
    const { saveDirectory, fileName } = file;
    if (!fileName || typeof fileName !== 'string') continue;

    // Construct the absolute path using configured saveLocation.
    const joined = path.join(config.saveLocation, saveDirectory || '', fileName);
    const resolved = path.resolve(joined);
    const saveRoot = path.resolve(config.saveLocation);

    if (!resolved.startsWith(saveRoot) || !fs.existsSync(resolved)) {
      results[fileName] = null;
      continue;
    }

    let signedUrlId = null;
    let expiry = null;

    // Check cache
    for (const [existingId, cacheEntry] of signedUrlCache.entries()) {
      if (cacheEntry.filePath === resolved && cacheEntry.expiry > now) {
        signedUrlId = existingId;
        expiry = now + config.cache.maxAge * 1000;
        cacheEntry.expiry = expiry;
        signedUrlCache.set(existingId, cacheEntry, config.cache.maxAge);
        break;
      }
    }

    // Create new if not found
    if (!signedUrlId) {
      signedUrlId = crypto.randomUUID();
      expiry = now + config.cache.maxAge * 1000;
      signedUrlCache.set(signedUrlId, { filePath: resolved, mimeType: "application/octet-stream", expiry }, config.cache.maxAge);
    }

    results[fileName] = signedUrlId;
  }

  response.writeHead(200, generateCorsHeaders(MIME_TYPES['.json']));
  response.end(JSON.stringify({ status: 'success', files: results }));
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
  } = {},
  processType
) {
  const now = Date.now();
  let cleanedCount = 0;

  logger.info(`Cleaning up processes older than ${maxIdleTime / 1000} seconds in ${processType} processes`);
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
    // Trim the saveDirectory just as a precaution
    const saveDirectoryTrimmed = saveDirectory.trim();
    // Prepare save path
    const savePath = path.join(config.saveLocation, saveDirectoryTrimmed);
    logger.debug(`Downloading to path: ${savePath}`);

    // Create directory if needed, good to have
    if (savePath !== config.saveLocation && !fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let progressPercent = null;
      let capturedTitle = null;
      let capturedFileName = null;
      // Prepare final parameters
      const processArgs = ["-P", "home:" + savePath, videoUrl];

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
              logger.debug(output, { pid: downloadProcess.pid });
            } else if (progressBlock > progressPercent) {
              progressPercent = progressBlock;
              logger.debug(output, { pid: downloadProcess.pid });
            }

            // Emit progress update to frontend
            // TODO: Check if this is needed, as when multiple downloads are running this does not work properly
            safeEmit("downloading-percent-update", { percentage: percent });
          }

          // Extract the title, no extension
          const itemTitle = /title:(.+)/m.exec(output);
          if (itemTitle?.[1] && !capturedFileName) {
            capturedTitle = itemTitle[1].trim()
            logger.debug(`Video Title from process ${capturedTitle}`, { pid: downloadProcess.pid });
          }

          // Get the final file name (only the video) from that we can get the rest
          const fileNameInDest = /fileName:(.+)"/m.exec(output);
          if (fileNameInDest?.[1]) {
            const finalFileName = fileNameInDest[1].trim();
            capturedFileName = path.basename(finalFileName);
            logger.debug(`Filename in destination: ${finalFileName}, basename: ${capturedFileName}, DB title: ${videoTitle}`,
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
            // ===== SUCCESS: Update video entry =====

            const unhelpfulTitle = (videoTitle === videoId || videoTitle === "NA");
            const fallbackTitle = capturedTitle || videoTitle;

            // Build initial updates object
            const updates = {
              downloadStatus: true,
              isAvailable: true,
              title: unhelpfulTitle ? fallbackTitle : videoTitle,
            };

            // Discover associated metadata files
            const { metadata, syncStatus } = discoverFiles(capturedFileName, savePath, videoEntry);

            // Add discovered metadata files to updates
            Object.assign(updates, metadata);

            // Determine if all expected metadata files were found
            const allExtraFilesFound = syncStatus.videoFileFound &&
              syncStatus.descriptionFileFound &&
              syncStatus.commentsFileFound &&
              syncStatus.subTitleFileFound &&
              syncStatus.thumbNailFileFound;

            updates.isMetaDataSynced = true;

            // Log metadata sync status
            if (allExtraFilesFound) {
              logger.info('All extra files found', {
                updates: JSON.stringify(updates)
              });
            } else {
              logger.info('Some of the expected files are not found', {
                updates: JSON.stringify(updates)
              });
            }

            logger.debug(`Updating video: ${JSON.stringify(updates)}`, {
              pid: downloadProcess.pid
            });

            await videoEntry.update(updates);

            // Notify frontend: send saveDirectory and fileName
            try {
              const fileName = updates.fileName;
              const thumbNailFile = updates.thumbNailFile;
              const subTitleFile = updates.subTitleFile;
              const descriptionFile = updates.descriptionFile;
              const isMetaDataSynced = updates.isMetaDataSynced;
              let saveDir = computeSaveDirectory(savePath);

              // Check if computed saveDir matches expected saveDirectory (if available)
              if (typeof saveDirectory !== 'undefined' && saveDir === saveDirectory.trim()) {
                logger.debug(`Computed saveDir matches expected saveDirectory`, {
                  saveDir,
                  saveDirectory
                });
              } else if (typeof saveDirectory !== 'undefined') {
                logger.debug(`Computed saveDir differs from expected saveDirectory`, {
                  saveDir,
                  saveDirectory
                });
              }

              safeEmit("download-done", {
                url: videoUrl,
                title: updates.title,
                fileName: fileName,
                saveDirectory: saveDir,
                isMetaDataSynced: isMetaDataSynced,
                thumbNailFile: thumbNailFile,
                subTitleFile: subTitleFile,
                descriptionFile: descriptionFile
              });
            } catch (e) {
              // Fallback to previous behavior if something goes wrong
              logger.error('Error computing save directory, using fallback', {
                error: e.message
              });
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
            // ===== FAILURE: Handle download failure =====

            logger.error('Download failed', {
              videoUrl,
              exitCode: code,
              pid: downloadProcess.pid
            });

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
          logger.error(`Error handling download completion: ${error.message}`, {
            pid: downloadProcess.pid
          });
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
/**
 * Updates the last activity timestamp of a process entry
 *
 * @param {string} processKey - Key of the process entry to update
 */
function updateProcessActivity(processKey) {
  const processEntry = downloadProcesses.get(processKey);
  if (processEntry) {
    processEntry.lastActivity = Date.now();
  }
}
// Helper function to cleanup process entry
/**
 * Removes a process entry from the download processes map
 * @param {string} processKey - Key of the process entry to remove
 * @param {number} pid - Process ID of the process to remove
 */
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
          safeEmit("listing-playlist-skipped-because-same-monitoring", {
            message: `Playlist ${playlistEntry.title} is already being monitored with type ${monitoringType}, skipping.`
          });
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
          safeEmit("listing-video-skipped-because-downloaded", {
            message: `Video ${videoEntry.title} is already downloaded, skipping.`
          });
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
/**
 * Lists a given array of items concurrently, controlling the number of concurrent listing operations using a semaphore.
 * 
 * @param {Array<Object>} items - Array of items to list, each containing properties:
 *   - url: URL of video or playlist
 *   - type: Type of item (video, playlist, undownloaded, undetermined)
 *   - currentMonitoringType: Current monitoring type of the item
 *   - reason: Reason for the item being added to the list
 * @param {number} chunkSize - Maximum number of concurrent listing operations
 * @param {boolean} shouldSleep - If true, the listing process will sleep between each chunk
 * @returns {Promise<boolean>} Resolves to true if all listings successful, false otherwise
 */
async function listItemsConcurrently(items, chunkSize, shouldSleep) {
  logger.trace(`Listing ${items.length} items concurrently (chunk size: ${chunkSize})`);

  // If no items to list, return
  if (items.length === 0) {
    logger.trace("No items to list");
    return true;
  }

  // Update the semaphore's max concurrent value
  ListingSemaphore.setMaxConcurrent(config.queue.maxListings);

  // Process all items with semaphore control
  // TODO: Fix the issue where if send playlists (since they take long time) 
  // the semaphore behavior is not consistent, sometimes it gets un-tracked
  const listingResults = await Promise.all(
    items.map(item => listWithSemaphore(item, chunkSize, shouldSleep))
  );

  // Check for any failures
  const allSuccessful = listingResults.every(result => result.status === 'success');

  // Log results
  try {
    listingResults.forEach(result => {
      if (result.status === 'completed') {
        logger.info(`Listed ${result.title} successfully`);
      } else {
        logger.error(`Failed to list ${result.title}: ${JSON.stringify(result)}`);
      }
    });
  } catch (error) {
    logger.error("Failed to log listing results", {
      error: error.message,
      stack: error.stack
    });
  }

  return allSuccessful;
}
/**
 * Lists a single item with semaphore control to prevent excessive concurrent listing operations.
 * 
 * @param {Object} item - Item to list containing properties:
 *   - url: URL of video or playlist
 *   - type: Type of item (video, playlist, undownloaded, undetermined)
 *   - monitoringType: Current monitoring type of the item
 * @param {number} chunkSize - Maximum number of concurrent listing operations
 * @param {boolean} shouldSleep - If true, the listing process will sleep between each chunk
 * @returns {Promise<Object>} Listing result containing:
 *   - url: Video URL
 *   - title: Video title
 *   - status: 'success' | 'failed'
 *   - error?: Error message if failed
 */
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
      spawnTimeStamp: null,
      status: "pending"
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    listProcesses.set(entryKey, listEntry);

    // Execute listing process
    const result = await executeListing(item, entryKey, chunkSize, shouldSleep);
    // Null out the spawned process as it's completed and we don't want to keep it in logs
    listEntry["spawnedProcess"] = null;
    logger.trace(`Listing completed`, {
      result: JSON.stringify(result),
      listEntry: JSON.stringify(listEntry)
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

    // Get initial chunk start and end indices
    const { startIndex, endIndex } = await determineInitialRange(itemType, currentMonitoringType, videoUrl, chunkSize);
    // Fetch video information for the initial chunk
    logger.debug(`Fetching information while listing`, {
      url: videoUrl,
      itemType,
      startIndex,
      endIndex,
      processedChunks,
      processKey
    });
    const responseItems = await fetchPlayListItems(videoUrl, startIndex, endIndex, processedChunks, processKey);

    logger.debug(`Got items from listing chunk`, {
      itemCount: responseItems.length,
      url: videoUrl,
      startIndex,
      endIndex,
      processedChunks
    });

    if (responseItems.length === 0) {
      return handleEmptyResponse(videoUrl);
    }

    // Handle single video vs playlist
    // Add an exception for x.com URLs as they despite having multiple items are not playlists
    const isPlaylist = responseItems.length > 1 || playlistRegex.test(videoUrl) || itemType === "playlist";

    if (isPlaylist && !isSiteXDotCom(videoUrl)) {
      itemType = "playlist";
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
          await existingPlaylist.update({
            monitoringType: currentMonitoringType,
            lastUpdatedByScheduler: Date.now()
          });
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
        seekPlaylistListTo,
        processKey
      });
    } else {
      itemType = "unlisted";
      // Single video handling, no processKey needed
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
 * Discovers metadata files associated with a downloaded video
 * @param {string} mainFileName - The main video file name
 * @param {string} savePath - Directory where files are saved
 * @param {object} videoEntry - The video entry in the database
 * @returns {object} Object containing paths to discovered metadata files and sync status
 */
function discoverFiles(mainFileName, savePath, videoEntry) {
  const metadata = {
    fileName: null,
    descriptionFile: null,
    commentsFile: null,
    subTitleFile: null,
    thumbNailFile: null
  };

  // Track which files were expected vs found
  const syncStatus = {
    videoFileFound: false,
    descriptionFileFound: !config.saveDescription,
    commentsFileFound: !config.saveComments,
    subTitleFileFound: !config.saveSubs,
    thumbNailFileFound: !config.saveThumbnail
  };

  // If a file is being re-downloaded/updated, mainFileName will be null
  if (!mainFileName) {
    logger.debug('No main file name provided for metadata discovery');
    // Check if video is already downloaded, and if it has a download status as true
    if (videoEntry && videoEntry.downloadStatus) {
      mainFileName = videoEntry.fileName;
      logger.debug('Using main file name from database', { mainFileName });
    } else {
      logger.debug('No main file name found in database');
      return { metadata, syncStatus };
    }
  }

  try {
    const mainFileExt = path.extname(mainFileName).toLowerCase();
    const mainFileBase = mainFileName.replace(mainFileExt, '');
    logger.debug('Scanning savePath for extra metadata files', { savePath, mainFileBase });

    // Define extension patterns for each file type
    const patterns = {
      video: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v'],
      description: ['.description'],
      comments: ['.info.json'],
      subtitle: ['.vtt', '.srt'], // There can be languages too
      thumbnail: ['.webp', '.jpg', '.jpeg', '.png']
    };

    // Optimistically check for known file patterns first
    const checkFile = (baseName, extensions) => {
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
        logger.trace('Found description file', { file: found });
      }
    }

    if (config.saveComments) {
      const found = checkFile(mainFileBase, patterns.comments);
      if (found) {
        metadata.commentsFile = found;
        syncStatus.commentsFileFound = true;
        logger.trace('Found comments file', { file: found });
      }
    }

    if (config.saveSubs) {
      // Try common subtitle patterns: baseName.ext and baseName.lang.ext
      const commonLanguages = ['en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ja', 'zh', 'ko'];
      const subtitlePatterns = [
        ...patterns.subtitle, // Direct patterns: baseName.vtt, baseName.srt
        ...commonLanguages.flatMap(lang =>
          patterns.subtitle.map(ext => `.${lang}${ext}`)
        ) // Language patterns: baseName.en.vtt, baseName.fr.srt, etc.
      ];

      const found = checkFile(mainFileBase, subtitlePatterns);
      if (found) {
        metadata.subTitleFile = found;
        syncStatus.subTitleFileFound = true;
        logger.trace('Found subtitles file', { file: found });
      }
    }

    if (config.saveThumbnail) {
      const found = checkFile(mainFileBase, patterns.thumbnail);
      if (found) {
        metadata.thumbNailFile = found;
        syncStatus.thumbNailFileFound = true;
        logger.trace('Found thumbnail file', { file: found });
      }
    }

    // Check if the initially found file extension was for the video
    if (mainFileExt && patterns.video.includes(mainFileExt)) {
      // This way the likely hood of finding it in the first iteration is very high
      patterns.video = [mainFileExt, ...patterns.video.filter(ext => ext !== mainFileExt)];
    }
    // Find video file - check common extensions first, then fallback to directory scan
    const videoFile = checkFile(mainFileBase, patterns.video);
    if (videoFile) {
      metadata.fileName = videoFile;
      syncStatus.videoFileFound = true;
      logger.trace('Found video file', { file: videoFile });
    } else {
      // Fallback: scan directory for video file with unknown extension
      logger.trace('Video file not found with common extensions, scanning directory');
      const files = fs.readdirSync(savePath);

      // Filter out only the ones we need
      const filesOfInterest = files.filter(file => file.startsWith(mainFileBase));

      // Look for the video file - any file starting with mainFileBase that isn't a known metadata file
      const knownMetadataExts = [
        ...patterns.description,
        ...patterns.comments,
        ...patterns.subtitle,
        ...patterns.thumbnail
      ];

      for (const file of filesOfInterest) {
        // If it's not a known metadata extension, assume it's the video file
        if (!knownMetadataExts.some(metaExt => file.endsWith(metaExt))) {
          metadata.fileName = file;
          syncStatus.videoFileFound = true;
          logger.trace('Found video file', { file });
          break;
        }
      }
    }

    return { metadata, syncStatus };

  } catch (error) {
    logger.debug('Could not read savePath for extra metadata files', {
      savePath,
      error: error.message
    });

    return {
      metadata,
      syncStatus: {
        videoFileFound: false,
        descriptionFileFound: false,
        commentsFileFound: false,
        subTitleFileFound: false,
        thumbNailFileFound: false
      }
    };
  }
}
/**
 * Computes the save directory relative to the configured save location
 * @param {string} savePath - The configured save location
 * @returns {string} Relative save directory
 */
function computeSaveDirectory(savePath) {
  try {
    let saveDir = path.relative(
      path.resolve(config.saveLocation),
      path.resolve(savePath)
    );

    // Normalize: convert "." to empty string
    if (saveDir === path.sep || saveDir === '.') {
      saveDir = '';
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
    logger.error('Error computing save directory', {
      fileName,
      saveLocation,
      error: error.message
    });
    return '';
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
 * @param {string} item.processKey - The key by which processes are tracked
 * @param {number} item.processedChunks - The number of chunks that have been processes
 * @returns {Promise<void>} Resolves when the playlist listing is complete.
 */
async function handlePlaylistListing(item) {
  const { videoUrl, responseItems, startIndex, chunkSize,
    shouldSleep, isScheduledUpdate, playlistTitle, seekPlaylistListTo, processKey } = item;
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
    logger.debug(`Fetching next chunk of video information`, {
      url: videoUrl,
      startIndex: nextStartIndex,
      endIndex: nextEndIndex,
      processedChunks,
      processKey
    });
    const nextItems = await fetchPlayListItems(videoUrl, nextStartIndex, nextEndIndex, processedChunks, processKey);
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
    // TODO: Add logic to check if the video still available, 
    // if not then update accordingly
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
 * @param {string} processKey - Unique key for the process
 * @returns {Promise<string[]>} Array of video information strings
 * @throws {Error} If process spawn fails or max processes reached
 */
async function fetchPlayListItems(videoUrl, startIndex, endIndex, processedChunks, processKey) {
  logger.trace("Fetching items from the given inputs", {
    url: videoUrl,
    start: startIndex,
    end: endIndex,
    processKey
  });

  return new Promise((resolve, reject) => {
    // Configure process arguments
    const processArgs = [
      ...(config.proxy_string ? ["--proxy", config.proxy_string] : []),
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
    const processEntry = listProcesses.get(processKey);
    /*
    processEntry: {
      url: videoUrl,
      type: itemType,
      monitoringType: monitoringType,
      lastActivity: Date.now(),
      spawnTimeStamp: Date.now(),
      status: "pending"
    }
    */
    if (processEntry) {
      processEntry.spawnedProcess = listProcess;
      processEntry.status = "running";
      processEntry.spawnTimeStamp = Date.now();
      processEntry.lastActivity = Date.now();
      listProcesses.set(processKey, processEntry);
    } else {
      logger.error(`Process entry not found: ${processKey}`);
      return reject(new Error(`Process entry not found: ${processKey}`));
    }

    let responseData = "";

    // Handle stdout
    listProcess.stdout.setEncoding("utf8");
    listProcess.stdout.on("data", data => {
      responseData += data;
      updateProcessActivity(processKey);
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
      const processEntryInt = listProcesses.get(processKey);
      if (processEntryInt) {
        processEntryInt.status = "errored";
        processEntryInt.lastActivity = Date.now();
        listProcesses.set(processKey, processEntryInt);
      } else {
        logger.error(`Process entry not found: ${processKey}`);
        return reject(new Error(`Process entry not found: ${processKey}`));
      }
    });

    // Handle process completion
    listProcess.on("close", code => {
      const processEntryInt = listProcesses.get(processKey);

      if (code !== 0) {
        logger.error("List process failed", {
          code: code,
          pid: listProcess.pid
        });

        if (processEntryInt) {
          processEntryInt.status = "failed";
          processEntryInt.lastActivity = Date.now();
          listProcesses.set(processKey, processEntryInt);
        } else {
          logger.error(`Process entry not found: ${processKey}`);
          return reject(new Error(`Process entry not found: ${processKey}`));
        }
      } else {
        if (processEntryInt) {
          processEntryInt.status = "completed";
          processEntryInt.lastActivity = Date.now();
          listProcesses.set(processKey, processEntryInt);
        } else {
          logger.error(`Process entry not found: ${processKey}`);
          return reject(new Error(`Process entry not found: ${processKey}`));
        }
      }
      logger.debug(`Listing done for chunk ${processedChunks}`, {
        pid: listProcess.pid,
        code: code,
      });

      // Return filtered results
      const items = responseData
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0);
      // Items will always be an array, so no checks needed here
      return resolve(items);
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
    logger.debug("All videos already exist in database", { existingVideos: JSON.stringify(existingVideos), existingIndexes: JSON.stringify(existingIndexes) });
    for (let i = 0; i < existingVideos.length; i++) {
      if (existingVideos[i]) {
        result.count++;
        result.title = existingVideos[i].title;
        result.alreadyExisted = true;
      }
    }
    logger.debug("Returning result", { result: JSON.stringify(result) });
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
  logger.debug("Processed video information", { result: JSON.stringify(result) });
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
    newData: JSON.stringify(newData)
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
    ...(config.proxy_string ? ["--proxy", config.proxy_string] : []),
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
          monitoringType: monitoringType,
          lastUpdatedByScheduler: Date.now()
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
            lastUpdatedByScheduler: Date.now()
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
async function processDeletePlaylistRequest(requestBody, response) {
  try {
    logger.debug("Received playlist delete request", { "requestBody": JSON.stringify(requestBody) });

    const playListUrl = requestBody.playListUrl || "";
    const deleteAllVideosInPlaylist = requestBody.deleteAllVideosInPlaylist || false;
    const deletePlaylist = requestBody.deletePlaylist || false;
    const cleanUp = requestBody.cleanUp || false;

    // Test
    //response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    //return response.end(JSON.stringify({ "status": "test", "message": playListUrl }));

    if (!playListUrl) {
      logger.error("Need a playListUrl", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "Need a playListUrl" }));
    }
    if (playListUrl === "None") {
      logger.error("Cannot delete the default playlist", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "Cannot delete the default playlist" }));
    }

    const playlist = await PlaylistMetadata.findByPk(playListUrl);
    if (!playlist) {
      logger.error("Playlist not found", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(404, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "Playlist not found" }));
    }

    const transaction = await sequelize.transaction();
    try {
      let message = "";

      // Delete all video mappings if requested
      if (deleteAllVideosInPlaylist) {
        await PlaylistVideoMapping.destroy({ where: { playlistUrl: playListUrl }, transaction });
        message = `Removed all video references from playlist ${playlist.title}`;
      }

      // Delete the playlist itself if requested
      if (deletePlaylist) {
        // Save sortOrder of deleted playlist
        const deletedSortOrder = playlist.sortOrder;
        // Delete playlist
        await playlist.destroy({ transaction });
        message += message ? " and deleted playlist" : `Deleted playlist ${playlist.title}`;

        // Update sortOrder for all playlists that came after the deleted one
        await PlaylistMetadata.decrement(
          'sortOrder',
          {
            by: 1,
            where: {
              sortOrder: { [sequelize.Sequelize.Op.gt]: deletedSortOrder }
            },
            transaction
          }
        );
        logger.debug("Updated sortOrder for playlists after deleted playlist", { deletedSortOrder });
      }

      // If neither action was requested, just return a message
      if (!deleteAllVideosInPlaylist && !deletePlaylist) {
        await transaction.commit();
        response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
        return response.end(JSON.stringify({
          "message": `No deletion performed for playlist ${playlist.title}`,
          "cleanUp": false,
          "deletePlaylist": false,
          "deleteAllVideosInPlaylist": false
        }));
      }

      // Clean up directory if requested (after transaction commits)
      if (cleanUp) {
        try {
          const playListDir = path.join(config.saveLocation, playlist.saveDirectory);
          logger.debug("Cleaning up playlist directory", { saveDirectory: playlist.saveDirectory, absolutePath: playListDir });
          fs.rmSync(playListDir, { recursive: true, force: true });
          logger.debug("Playlist directory cleaned up", { saveDirectory: playlist.saveDirectory });
          message += " and cleaned up playlist directory";
        } catch (error) {
          logger.error("Failed to clean up playlist directory", {
            saveDirectory: playlist.saveDirectory,
            error: error.message
          });
          message += " but failed to clean up playlist directory";
        }
      }

      // Commit transaction
      await transaction.commit();
      response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        "message": message,
        "cleanUp": cleanUp,
        "deletePlaylist": deletePlaylist,
        "deleteAllVideosInPlaylist": deleteAllVideosInPlaylist
      }));

    } catch (error) {
      await transaction.rollback();
      logger.error(`Playlist deletion failed with error ${error.message}`, {
        playListUrl, deleteAllVideosInPlaylist, deletePlaylist, cleanUp
      });
      response.writeHead(500, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": error.message }));
    }
  } catch (error) {
    response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({ "status": "error", "message": error.message }));
  }
}

/**
 * Handles deletion of specific videos from a playlist
 *
 * @param {Object} requestBody - Body of the request containing parameters
 * @param {string} requestBody.playListUrl - URL of the playlist (required)
 * @param {string[]} requestBody.videoUrls - Array of video URLs to delete (required)
 * @param {boolean} requestBody.cleanUp - Whether to delete downloaded files
 * @param {boolean} requestBody.deleteVideoMappings - Whether to remove playlist-video mappings
 * @param {boolean} requestBody.deleteVideosInDB - Whether to delete videos from VideoMetadata table
 * @param {http.ServerResponse} response - HTTP response object
 * @returns {Promise<void>} Resolves when deletion is complete
 */
async function processDeleteVideosRequest(requestBody, response) {
  try {
    logger.debug("Received video delete request", { "requestBody": JSON.stringify(requestBody) });

    const playListUrl = requestBody.playListUrl || "";
    const videoUrls = requestBody.videoUrls || [];
    const cleanUp = requestBody.cleanUp || false;
    const deleteVideoMappings = requestBody.deleteVideoMappings || false;
    const deleteVideosInDB = requestBody.deleteVideosInDB || false;

    // Test
    //response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    //return response.end(JSON.stringify({ "status": "test", "message": videoUrls }));

    if (!playListUrl) {
      logger.error("Need a playListUrl", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "Need a playListUrl" }));
    }

    if (!Array.isArray(videoUrls)) {
      logger.error("videoUrls must be an array", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "videoUrls must be an array" }));
    }

    if (videoUrls.length === 0) {
      logger.error("videoUrls array cannot be empty", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "videoUrls array cannot be empty" }));
    }

    const playlist = await PlaylistMetadata.findByPk(playListUrl);
    if (!playlist) {
      logger.error("Playlist not found", { "requestBody": JSON.stringify(requestBody) });
      response.writeHead(404, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": "Playlist not found" }));
    }

    const transaction = await sequelize.transaction();
    try {
      const deleted = [];
      const failed = [];

      for (const videoUrl of videoUrls) {
        try {
          const video = await VideoMetadata.findByPk(videoUrl);

          if (!video) {
            logger.warn("Video not found", { videoUrl });
            failed.push({ videoUrl, reason: "Video not found" });
            continue;
          }

          let allFilesRemoved = true;

          // Clean up downloaded files if requested
          if (cleanUp && video.downloadStatus) {
            const filesToRemove = {
              "fileName": video.fileName,
              "thumbNailFile": video.thumbNailFile,
              "subTitleFile": video.subTitleFile,
              "commentsFile": video.commentsFile,
              "descriptionFile": video.descriptionFile
            };

            logger.debug("Removing files for video", { videoUrl, filesToRemove: JSON.stringify(filesToRemove) });

            for (const [key, value] of Object.entries(filesToRemove)) {
              if (value) {
                try {
                  const filePath = path.join(config.saveLocation, playlist.saveDirectory, value);
                  logger.debug("Removing file", { videoUrl, key, value, filePath });
                  fs.unlinkSync(filePath);
                  logger.debug("Removed file", { videoUrl, key, value, filePath });
                  filesToRemove[key] = null;
                } catch (error) {
                  logger.error("Failed to remove file", { videoUrl, key, value, error: error.message });
                  allFilesRemoved = false;
                }
              }
            }

            // Update video metadata if files were cleaned up
            if (allFilesRemoved) {
              video.downloadStatus = false;
              video.fileName = null;
              video.thumbNailFile = null;
              video.subTitleFile = null;
              video.commentsFile = null;
              video.descriptionFile = null;
            }
          }

          // Delete the video from DB if requested
          if (deleteVideosInDB) {
            await video.destroy({ transaction });
            // Mappings will be cascade deleted
          } else {
            // Save updated video metadata
            await video.save({ transaction });

            // Remove mapping if requested and all files were cleaned up (or cleanup wasn't requested)
            if (deleteVideoMappings && (!cleanUp || allFilesRemoved)) {
              await PlaylistVideoMapping.destroy({
                where: { videoUrl, playlistUrl: playListUrl },
                transaction
              });
            }
          }

          if (allFilesRemoved || !cleanUp) {
            deleted.push(videoUrl);
          } else {
            failed.push({ videoUrl, reason: "Some files could not be removed" });
          }

        } catch (error) {
          logger.error("Failed to process video", { videoUrl, error: error.message });
          failed.push({ videoUrl, reason: error.message });
        }
      }

      await transaction.commit();

      response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        "message": `Processed ${deleted.length} video(s) from playlist ${playlist.title}`,
        "deleted": deleted,
        "failed": failed,
        "cleanUp": cleanUp,
        "deleteVideoMappings": deleteVideoMappings,
        "deleteVideosInDB": deleteVideosInDB
      }));

    } catch (error) {
      await transaction.rollback();
      logger.error(`Video deletion failed with error ${error.message}`, {
        playListUrl, videoUrls, cleanUp, deleteVideoMappings, deleteVideosInDB
      });
      response.writeHead(500, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({ "status": "error", "message": error.message }));
    }
  } catch (error) {
    response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
    return response.end(JSON.stringify({ "status": "error", "message": error.message }));
  }
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
    const sortBy = sortColumn === 3 ? "lastUpdatedByScheduler" : "createdAt";

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
    if (searchQuery && searchQuery.length > 0) {
      if (searchQuery.startsWith("url:")) {
        if (searchQuery.slice(4).length > 0) {
          queryOptions.where.playlistUrl = {
            [Op.iLike]: `%${searchQuery.slice(4)}%`
          };
        } else {
          logger.debug("No url provided", { searchQuery })
        }
      } else {
        queryOptions.where.title = {
          [Op.iLike]: `%${searchQuery}%`
        };
      }
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
async function getSubListVideos(requestBody, response) {
  try {
    // Extract and validate parameters
    const playlistUrl = requestBody.url ?? "None";
    const startIndex = Math.max(0, +(requestBody.start ?? 0));
    const endIndex = +(requestBody.stop ?? config.chunkSize);
    const searchQuery = requestBody.query ?? "";
    const sortByDownloaded = requestBody.sortDownloaded ?? false;

    // Determine sort order - Explanation:
    // If sorting by download status, we sort by VideoMetadata.downloadStatus DESC
    // (downloaded videos first, with the most recently downloaded videos first).
    // Otherwise, we sort by positionInPlaylist ASC in whatever order they were added.
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
    const videoMetadataWhere = {};

    if (searchQuery && searchQuery.length > 0) {
      if (searchQuery.startsWith("url:")) {
        const urlSearch = searchQuery.slice(4);
        if (urlSearch.length > 0) {
          videoMetadataWhere.videoUrl = {
            [Op.iLike]: `%${urlSearch}%`
          };
        } else {
          logger.debug("No url provided for sublist query, despite using url: prefix", { searchQuery });
        }
      } else {
        videoMetadataWhere.title = {
          [Op.iLike]: `%${searchQuery}%`
        };
      }
    }

    const queryOptions = {
      attributes: ["positionInPlaylist", "playlistUrl"],
      include: [{
        model: VideoMetadata,
        attributes: [
          "title",
          "videoId",
          "videoUrl",
          "downloadStatus",
          "isAvailable",
          "fileName",
          "thumbNailFile",
          "subTitleFile",
          "descriptionFile",
          "isMetaDataSynced",
        ],
        where: videoMetadataWhere,
        // Use Inner Join (strict) if searching, otherwise Left Join (loose)
        required: (searchQuery && searchQuery.length > 0)
      }],
      where: {
        playlistUrl: playlistUrl
      },
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
        fileName: vm.fileName,
        thumbNailFile: vm.thumbNailFile,
        subTitleFile: vm.subTitleFile,
        descriptionFile: vm.descriptionFile,
        isMetaDataSynced: vm.isMetaDataSynced
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
        url: req.url,
        method: req.method,
        encoding: reqEncoding,
      });
      // Check if the request is for a file from the signedUrlCache
      const urlParams = new URLSearchParams(req.url.split("?")[1]);
      if (urlParams.has("fileId")) {
        const fileId = urlParams.get("fileId");
        // If fileId is present, try to serve from signedUrlCache
        if (signedUrlCache.has(fileId)) {
          const signedEntry = signedUrlCache.get(fileId);
          // Serve the file from the signed URL cache
          logger.info("Serving file from signed URL cache", { url: req.url });
          // Check if the entry has expired
          if (Date.now() > signedEntry.expiry) {
            logger.warn("Signed URL has expired", { url: req.url });
            signedUrlCache.delete(fileId);
            res.writeHead(403, generateCorsHeaders(MIME_TYPES[".html"]));
            res.write("Signed URL has expired");
            return res.end();
          } else {
            // Improved streaming for large files: Range support, pipeline, backpressure
            logger.trace("Serving signed file", { fileId, filePath: signedEntry.filePath });
            (async () => {
              try {
                const stats = await fs.promises.stat(signedEntry.filePath);
                const total = stats.size;

                const originalName = path.basename(signedEntry.filePath || '');
                // Remove potentially dangerous characters
                const safeName = originalName.replace(/[\r\n"]/g, '');
                // ASCII fallback for older clients
                const fallbackName = safeName.replace(/[^\x20-\x7E]/g, '_');
                const encodedName = encodeURIComponent(safeName);

                const contentType = signedEntry.mimeType || MIME_TYPES[path.extname(safeName)] || 'application/octet-stream';
                // Common headers (CORS + content-type + disposition + accept-ranges)
                const cors = generateCorsHeaders(contentType);
                Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
                res.setHeader('Content-Type', contentType);
                res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
                res.setHeader('Accept-Ranges', 'bytes');

                // Parse Range header
                const range = req.headers.range;
                let start = 0;
                let end = total - 1;
                let statusCode = 200;
                if (range) {
                  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
                  if (m) {
                    if (m[1]) start = parseInt(m[1], 10);
                    if (m[2]) end = parseInt(m[2], 10);
                    // Validate
                    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end > total - 1) {
                      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
                      return res.end();
                    }
                    statusCode = 206;
                    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
                  }
                }

                const chunkSize = end - start + 1;
                res.setHeader('Content-Length', String(chunkSize));
                res.writeHead(statusCode);

                const readStream = fs.createReadStream(signedEntry.filePath, {
                  start,
                  end,
                  // Larger buffer for fewer syscall's on big files (tune as needed)
                  highWaterMark: 1024 * 1024,
                });

                const onClose = () => {
                  // Destroy the stream if client disconnects
                  try { readStream.destroy(); } catch (e) { }
                };
                req.on('close', onClose);
                req.on('aborted', onClose);

                try {
                  // Use pipeline to forward errors and handle backpressure
                  await pipelineAsync(readStream, res);
                  logger.trace("Finished streaming signed file", { fileId });
                } catch (err) {
                  logger.error("Error during streaming signed file", { error: err && err.message, fileId });
                  if (!res.headersSent) {
                    res.writeHead(500, generateCorsHeaders(MIME_TYPES['.html']));
                  }
                  try { res.end('Error reading file'); } catch (e) { }
                } finally {
                  req.removeListener('close', onClose);
                  req.removeListener('aborted', onClose);
                  // Note: keep signedUrlCache entry to allow multiple downloads within expiry
                }
              } catch (err) {
                logger.error("Error getting file stats", { error: err.message, fileId });
                if (!res.headersSent) {
                  res.writeHead(500, generateCorsHeaders(MIME_TYPES['.html']));
                }
                res.end("Error reading file");
              }
            })();
            return;
            // If you want to just return the file path instead of streaming
            // (not recommended for large files or production use)
            // res.writeHead(200, generateCorsHeaders(signedEntry.mimeType));
            // res.write(signedEntry.filePath);
            // return res.end();
          }
        }
      }
      // Check if the GET request is for a static asset
      if (!staticAssets[get]) {
        logger.error("Requested Resource couldn't be found", {
          url: req.url,
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
        url: req.url,
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
  } else if (req.url === config.urlBase + "/delplay" && req.method === "POST") {
    authenticateRequest(req, res, processDeletePlaylistRequest);
  } else if (req.url === config.urlBase + "/getsub" && req.method === "POST") {
    authenticateRequest(req, res, getSubListVideos);
  } else if (req.url === config.urlBase + "/delsub" && req.method === "POST") {
    authenticateRequest(req, res, processDeleteVideosRequest);
  } else if (req.url === config.urlBase + "/getfile" && req.method === "POST") {
    authenticateRequest(req, res, makeSignedUrl);
  } else if (req.url === config.urlBase + "/getfiles" && req.method === "POST") {
    authenticateRequest(req, res, makeSignedUrls);
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
      url: req.url,
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
  logger.debug(
    `Download Options: yt-dlp ${downloadOptions.join(" ")} --paths "${config.saveLocation.endsWith("/") ? config.saveLocation : config.saveLocation + "/"}` +
    `{playlist_dir}" "{url}"`
  );
  logger.debug(
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
