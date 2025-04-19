"use strict";
const { Sequelize, DataTypes, Op } = require("sequelize");
const { spawn } = require("child_process");
const color = require("cli-color");
const CronJob = require("cron").CronJob;
const fs = require("fs");
const http = require("http");
const path_fs = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const generator = require('generate-password');
const he = require('he');
const { LRUCache } = require('lru-cache');
const { Server } = require("socket.io");

// Configuration object
const config = {
  protocol: process.env.PROTOCOL || "http",
  host: process.env.HOSTNAME || "localhost",
  port: +process.env.PORT || 8888,
  nativeHttps: process.env.USE_NATIVE_HTTPS === "true",
  hidePorts: process.env.HIDE_PORTS === "true",
  urlBase: process.env.BASE_URL || "/ytdiff",
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
    cleanUpInterval: +process.env.CLEANUP_INTERVAL_MS || 1 * 60 * 1000, // 1 minutes
    maxIdle: +process.env.PROCESS_MAX_AGE || 5 * 60 * 1000, // 5 minutes
  },
  saveLocation: process.env.SAVE_PATH || "/home/sagnik/Videos/yt-dlp/",
  sleepTime: process.env.SLEEP ?? 3,
  chunkSize: +process.env.CHUNK_SIZE_DEFAULT || 10,
  scheduledUpdateStr: process.env.UPDATE_SCHEDULED || "*/30 * * * *",
  timeZone: process.env.TZ_PREFERRED || "Asia/Kolkata",
  saveSubs: process.env.SAVE_SUBTITLES !== "false",
  saveDescription: process.env.SAVE_DESCRIPTION !== "false",
  saveComments: process.env.SAVE_COMMENTS !== "false",
  saveThumbnail: process.env.SAVE_THUMBNAIL !== "false",
  logLevel: (process.env.LOG_LEVELS || "trace").toLowerCase(),
  maxTitleLength: 255,
  saltRounds: 10,
  secretKey: process.env.SECRET_KEY_FILE
    ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
    : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
      ? process.env.SECRET_KEY.trim()
      : new Error("SECRET_KEY or SECRET_KEY_FILE environment variable must be set"),
  maxClients: 10,
  connectedClients: 0,
  types: {
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
  },
  registration: {
    allowed: process.env.ALLOW_REGISTRATION === "true",
    maxUsers: +(process.env.MAX_USERS || 10)
  },
};

/**
 * An array of download options for a YouTube downloader.
 * The options are conditionally included based on the configuration settings.
 * 
 * Options included:
 * - "--embed-metadata": Always included to embed metadata in the downloaded file.
 * - "--write-subs": Included if `config.saveSubs` is true, to write subtitles.
 * - "--write-auto-subs": Included if `config.saveSubs` is true, to write automatic subtitles.
 * - "--write-description": Included if `config.saveDescription` is true, to write the video description.
 * - "--write-comments": Included if `config.saveComments` is true, to write the video comments.
 * - "--write-thumbnail": Included if `config.saveThumbnail` is true, to write the video thumbnail.
 * - "--paths": Always included to specify the download paths.
 * 
 * The array is filtered to remove any empty strings.
 */
const downloadOptions = [
  "--embed-metadata",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveDescription ? "--write-description" : "",
  config.saveComments ? "--write-comments" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  "--paths",
].filter(Boolean);
// Regex needs to be separate
const playlistRegex = /(?:playlist|list=)\b/i;

if (config.secretKey instanceof Error) {
  throw config.secretKey;
}
if (config.db.password instanceof Error) {
  throw config.db.password;
}

// Caching
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
  // Start with log level and message
  let logEntry = `level=${level} msg="${message}"`;

  // Add timestamp in ISO format
  logEntry += ` ts=${new Date().toISOString()}`;

  // Add all other fields
  for (const [key, value] of Object.entries(fields)) {
    // Properly format different value types
    if (typeof value === 'string') {
      // Escape quotes in strings
      logEntry += ` ${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    } else if (value instanceof Error) {
      // Extract error details
      logEntry += ` ${key}="${value.message.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      if (value.stack) {
        logEntry += ` ${key}_stack="${value.stack.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
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

// video_url is the primary key of any video
const video_list = sequelize.define("video_list", {
  video_url: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  // this id is video id and is generated from the url but is necessary for easier processing
  video_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  approximate_size: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  downloaded: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  available: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

// playlist_url is the primary key of any playlist
const playlist_list = sequelize.define("playlist_list", {
  playlist_url: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // this is the order in which the playlists are added not the videos
  playlist_index: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  monitoring_type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  save_dir: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

/*  video_url is the foreign keys from video_list,
    playlist_url is foreign key from playlist_list
    id is the primary key

    The plan here is to make a way such that a video can have a video associated with
    multiple playlist_url and index_in_playlist for that given playlist_url

    This is a junction table
*/
const video_indexer = sequelize.define("video_indexer", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false,
  },
  // linked to the primary key of the video_list table
  video_url: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: video_list,
      key: "video_url",
    },
    onUpdate: "CASCADE",
    onDelete: "CASCADE",
  },
  // linked to the primary key of the playlist_list
  playlist_url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  /*
    index_in_playlist exists to provide order to the relation of  video primary key with a playlist primary key.
    if index_in_playlist were added to the video_list table there would be a ton of duplicates of the
    video in the table each having different playlist url and indexes, this table seems like a good compromise
    */
  index_in_playlist: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
});

const users = sequelize.define("users", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false,
  },
  user_name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  salt: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

// Define the relationships
video_indexer.belongsTo(video_list, {
  foreignKey: "video_url",
});
video_list.hasMany(video_indexer, {
  foreignKey: "video_url",
});

sequelize
  .sync()
  .then(async () => {
    logger.info(
      "tables exist or are created successfully",
      { host: config.db.host, database: config.db.name, tables: [video_list.name, playlist_list.name, video_indexer.name] }
    );
    // Making the unlisted playlist
    const [unlistedPlaylist, created] = await playlist_list.findOrCreate({
      where: { playlist_url: "None" },
      defaults: {
        title: "None",
        monitoring_type: "N/A",
        save_dir: "",
        playlist_index: -1,
      },
    });
    if (created) {
      logger.info(
        "Unlisted playlist created successfully",
        { host: config.db.host, database: config.db.name, tables: [unlistedPlaylist.name] }
      );
    }
    // Replace the existing default user creation code with:
    const defaultUserCheck = await users.count();
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
const job = new CronJob(
  config.scheduledUpdateStr,
  // TODO: Fix and enable the scheduled updater
  // scheduledUpdater,
  () => {
    logger.info("Scheduled update",
      {
        time: new Date().toLocaleString("en-US", { timeZone: config.timeZone }),
        timeZone: config.timeZone,
        nextRun: job.nextDate().toLocaleString("en-US", { timeZone: config.timeZone })
      }
    );
  },
  null,
  true,
  config.timeZone
);

// Make sure the save location exists
if (!fs.existsSync(config.saveLocation)) {
  logger.info("Ensuring save location exists", { saveLocation: config.saveLocation });
  fs.mkdirSync(config.saveLocation, { recursive: true });
}

// Utility functions
/**
 * Extracts JSON data from a request object.
 *
 * @param {Object} req - The request object.
 * @return {Promise<Object>} A promise that resolves with the parsed JSON data or rejects with an error object.
 */
async function extractJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", function (data) {
      body += data;
      if (body.length > 1e6) {
        logger.warn("Request recieved was too large", {
          ip: req.connection.remoteAddress,
          url: req.url,
          size: body.length,
          method: req.method
        });
        req.connection.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });
    req.on("end", function () {
      try {
        const parsedBody = JSON.parse(body);
        resolve(parsedBody);
      } catch (error) {
        logger.error("Invalid JSON", {
          ip: req.connection.remoteAddress,
          url: req.url,
          size: body.length,
          method: req.method,
          error: error
        });
        reject({ status: 400, message: "Invalid JSON" });
      }
    });
  });
}
/**
 * Slices a string to a specified length if it exceeds the limit, otherwise returns the original string.
 *
 * @param {string} str - The input string to be sliced.
 * @param {number} len - The maximum length of the sliced string.
 * @return {Promise<string>} - The sliced string or the original string if it is within the limit.
 */
function stringSlicer(str, len) {
  if (str.length > len) {
    return str.slice(0, len);
  }
  return str;
}
/**
 * Converts a URL to a title by extracting the pathname, filtering out unnecessary parts, and joining the remaining parts.
 *
 * @param {string} bodyUrl - The URL to extract the title from.
 * @return {string} The extracted title from the URL.
 */
async function urlToTitle(bodyUrl) {
  try {
    return new URL(bodyUrl).pathname
      .split("/")
      //.filter((item) => !not_needed.includes(item))
      .join("");
  } catch (error) {
    logger.error("Error in urlToTitle", { error: error.message });
    return bodyUrl;
  }
}
/**
 * Fixes common errors in the given body URL related to YouTube and Pornhub links.
 *
 * @param {string} bodyUrl - The URL to check and modify.
 * @return {string} The modified URL after fixing common errors.
 */
function fixCommonErrors(bodyUrl) {
  if (bodyUrl.includes("youtube")) {
    if (!/\/videos\/?$/.test(bodyUrl) && bodyUrl.includes("/@")) {
      bodyUrl = bodyUrl.replace(/\/$/, "") + "/videos";
    }
    logger.debug(`${bodyUrl} is a youtube link`, { url: bodyUrl });
  }
  if (bodyUrl.includes("pornhub") && bodyUrl.includes("/model/")) {
    if (!/\/videos\/?$/.test(bodyUrl)) {
      bodyUrl = bodyUrl.replace(/\/$/, "") + "/videos";
    }
    logger.debug(`${bodyUrl} is a hub channel`, { url: bodyUrl });
  }
  // TODO: Add checks for other sites
  return bodyUrl;
}
/**
 * Asynchronously pauses the execution of the current code for a specified
 * number of seconds.
 *
 * @param {number} [sleepSeconds=config.sleepTime] - The number of seconds to sleep.
 * Defaults to the value of the `sleep_time` variable.
 * @return {Promise<void>} A promise that resolves after the specified number of
 * seconds have passed.
 */
async function sleep(sleepSeconds = config.sleepTime) {
  logger.debug("Sleeping for " + sleepSeconds + " seconds");
  return new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000));
}
// List process tracking
const listProcesses = new Map();
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
const ListSemaphore = {
  maxConcurrent: 1,
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
// List functions
/**
 * Asynchronously processes a list of URLs, extracts information from each URL, and sends the results to the frontend.
 *
 * @param {Object} body - An object containing the following properties:
 *   - url_list {Array<string>}: A list of URLs to process.
 *   - start {number} (optional): The starting index of the list to process. Defaults to 1.
 *   - chunk_size {number} (optional): The number of items to process at a time. Defaults to the value of the config.chunkSize variable.
 *   - sleep {boolean} (optional): Whether to wait for a short period of time before processing each URL. Defaults to false.
 *   - monitoring_type {string} (optional): The type of monitoring to perform. Defaults to "N/A".
 * @param {Object} res - The response object to send the results to.
 * @return {Promise<void>} A promise that resolves when the processing is complete.
 */
async function listFunc(body, res) {
  try {
    const startNum = body["start"] !== undefined ?
      +body["start"] === 0 ? 1 : +body["start"] : 1,
      chunkSize = +body["chunk_size"] >= +config.chunkSize ? +body["chunk_size"] : +config.chunkSize,
      stopNum = +chunkSize + 1,
      sleepBeforeListing = body["sleep"] !== undefined ? body["sleep"] : false,
      monitoringType = body["monitoring_type"] !== undefined ? body["monitoring_type"] : "N/A",
      urlList = body["url_list"] !== undefined ?
        body["url_list"] : [],
      lastItemIndex = startNum > 0 ? startNum - 1 : 0,
      listOfLists = [];

    if (urlList.length === 0) {
      throw new Error("url list is empty");
    }
    for (const urlItem of [...new Set(urlList)]) {
      logger.debug(
        `Processing item: ${urlItem}`,
        {
          url: urlItem, startNum: startNum, stopNum: stopNum,
          chunkSize: chunkSize, monitoringType: monitoringType
        }
      );
      listOfLists.push({
        url: fixCommonErrors(urlItem),
        startNum: startNum,
        stopNum: stopNum,
        chunkSize: chunkSize,
        sleepBeforeListing: sleepBeforeListing,
        monitoringType: monitoringType,
        lastItemIndex: lastItemIndex
      })
    }
    listParallel(listOfLists, config.queue.maxListings);
    res.writeHead(200, corsHeaders(config.types[".json"]));
    // This doesn't need escaping as it's consumed interanlly
    res.end(JSON.stringify({ Listing: listOfLists, maxConcurrent: config.queue.maxListings }));
  } catch (error) {
    logger.error(`${error.message}`);
    res.writeHead(500, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: he.escape(error.message) }));
  }
}
/**
 * Lists the given items in parallel with enhanced process tracking using a semaphore for global concurrency control
 * 
 * @param {Array} items - Array of items to be listed
 * @param {number} [maxConcurrent=1] - Maximum number of concurrent listings
 * @returns {Promise} A promise that resolves when all items have been listed
 */
async function listParallel(items, maxConcurrent = 1) {
  logger.trace(`Listing ${items.length} urls in parallel (max ${maxConcurrent} concurrent)`);

  // Update the semaphore's max concurrent value
  ListSemaphore.setMaxConcurrent(maxConcurrent);

  // Filter out URLs already being listed
  const filterUniqueItems = items.filter(item => {
    const url = item.url;
    const existingListing = Array.from(listProcesses.values())
      .find(process => process.url === url &&
        ['running', 'pending'].includes(process.status));

    return !existingListing;
  });

  logger.trace(`Filtered unique items for listing: ${filterUniqueItems.length}`);

  // Process all items with semaphore control
  const listPromises = filterUniqueItems.map(item =>
    listItemWithSemaphore(item)
  );

  // Wait for all listings to complete
  const results = await Promise.all(listPromises);

  // Check for any failures
  let allSuccess = results.every(result => result.status === 'success');

  // Log results
  results.forEach(result => {
    if (result.status === 'success') {
      logger.info(`Listed ${result.title} successfully`);
    } else if (result.status === 'failed') {
      logger.error(`Failed to list ${result.title}: ${result.error}`);
    }
  });

  return allSuccess;
}
/**
 * Wrapper for listItem that uses the semaphore to control concurrency
 */
async function listItemWithSemaphore(item) {
  logger.trace(`Listing item with semaphore: ${JSON.stringify(item)}`);
  // Acquire the semaphore before starting the listing
  await ListSemaphore.acquire();
  try {
    // Update task status in listProcesses to pending
    const urlString = item.url;
    const pendingEntry = {
      url: urlString,
      lastActivity: Date.now(),
      spawnTimeStamp: Date.now(),
      status: "pending"
    };
    const pendingKey = `pending_${urlString}_${Date.now()}`;
    listProcesses.set(pendingKey, pendingEntry);

    // Actual listing operation
    const result = await listItem(item, pendingKey);

    // Clean up the pending entry if it's still there
    if (listProcesses.has(pendingKey)) {
      listProcesses.delete(pendingKey);
    }

    return result;
  } finally {
    // Always release the semaphore, even if an error occurred
    ListSemaphore.release();
  }
}
const listItem = async (itemToList, processEntryKey) => {
  const urlString = itemToList.url,
    startNum = itemToList.startNum,
    stopNum = itemToList.stopNum,
    chunkSize = itemToList.chunkSize,
    sleepBeforeListing = itemToList.sleepBeforeListing,
    monitoringType = itemToList.monitoringType,
    lastItemIndex = itemToList.lastItemIndex;

  logger.debug(`Listing item: ${urlString}`, {
    url: urlString,
    startNum: startNum,
    stopNum: stopNum,
    chunkSize: chunkSize,
    monitoringType: monitoringType,
    sleepBeforeListing: sleepBeforeListing,
    lastItemIndex: lastItemIndex
  });

  try {
    // Update process status
    const processEntry = listProcesses.get(processEntryKey);
    if (processEntry) {
      processEntry.status = "initializing";
      processEntry.spawnType = "list";
      processEntry.spawnedProcess = null;
      processEntry.lastActivity = Date.now();
      listProcesses.set(processEntryKey, processEntry);
    }

    let playListIndex = -1, alreadyIndexed = false, playListTitle = "";

    // Sleep if required before listing
    if (sleepBeforeListing) {
      await sleep();
    }

    // Get initial response list, to see if it's a playlist or single video
    const responseList = await listSpawner(urlString, startNum, stopNum);
    logger.debug(`Response list: ${JSON.stringify(responseList)}, length: ${responseList.length}`);

    if (responseList.length === 0) {
      throw new Error("Response list is empty");
    }

    // Check if it's a playlist or single video
    if (responseList.length > 1 || playlistRegex.test(urlString)) {
      // Handle playlist case
      const isAlreadyIndexed = await playlist_list.findOne({
        where: { playlist_url: urlString }
      });

      if (isAlreadyIndexed) {
        logger.trace(`Playlist: ${isAlreadyIndexed.title.trim()} is indexed at ${isAlreadyIndexed.playlist_index}`);
        alreadyIndexed = true;
        playListIndex = isAlreadyIndexed.playlist_index;
        playListTitle = isAlreadyIndexed.title.trim();
      } else {
        // Add new playlist
        logger.warn("Playlist not encountered earlier, saving in database");
        // Do better sync for the playlist add
        await add_playlist(urlString, monitoringType);
        await sleep();

        const playlist = await playlist_list.findOne({
          order: [["createdAt", "DESC"]]
        });

        if (playlist) {
          playListIndex = playlist.playlist_index;
          playListTitle = playlist.title.trim();
          logger.trace(`Playlist: ${playlist.title} is indexed at ${playlist.playlist_index}`);
        } else {
          throw new Error("Playlist not found after creation");
        }
      }

      // Process response and start background listing
      const initResp = await processListingResponse(responseList, urlString, lastItemIndex, false);
      initResp.prev_playlist_index = playListIndex + 1;
      initResp.alreadyIndexed = alreadyIndexed;

      // I feel like the listBackground should also be tracked in the spawned processes
      // and keep track of the last activity so that we can kill it if needed 
      // TODO: Implement this
      listBackground(urlString, startNum, stopNum, chunkSize, true);
      logger.trace(`Done processing playlist: ${urlString}`);

      sock.emit("added-playlist-videos", {
        playlistUrl: urlString,
        title: playListTitle || urlString,
        monitoringType: monitoringType,
        indexInPlaylist: playListIndex + 1,
        lastItemIndex: lastItemIndex,
        alreadyIndexed: alreadyIndexed
      });

      return {
        status: 'success',
        title: playListTitle || urlString,
        url: urlString,
        result: initResp
      };

    } else {
      // Handle single video case
      const videoUrl = responseList[0].split("\t")[2];
      const videoAlreadyUnlisted = await video_indexer.findOne({
        where: {
          video_url: videoUrl,
          playlist_url: "None"
        }
      });

      if (videoAlreadyUnlisted) {
        logger.debug("Video already saved as unlisted");
        return {
          status: 'skipped',
          title: videoUrl,
          url: urlString,
          reason: 'already_unlisted'
        };
      } else {
        // Add new unlisted video
        logger.debug("Adding new video to unlisted videos list");
        const lastItem = await video_indexer.findOne({
          where: { playlist_url: "None" },
          order: [["index_in_playlist", "DESC"]],
          attributes: ["index_in_playlist"],
          limit: 1
        });

        const newIndex = lastItem ? lastItem.index_in_playlist + 1 : 0;
        const initResp = await processListingResponse(responseList, "None", newIndex, false);

        sock.emit("added-single-video", {
          videoUrl: videoUrl,
          title: initResp.title || urlString,
          playlist_url: "None",
          indexInPlaylist: newIndex,
        });

        return {
          status: 'success',
          title: initResp.title || urlString,
          url: urlString,
          result: initResp
        };
      }
    }

  } catch (error) {
    logger.error(`Error processing item: ${error.message}`, {
      url: urlString,
      error: error
    });
    return {
      status: 'failed',
      title: urlString,
      url: urlString,
      error: error.message
    };
  } finally {
    // Clean up process entry
    if (listProcesses.has(processEntryKey)) {
      listProcesses.delete(processEntryKey);
    }
  }
};
/**
 * Spawns a child process to run the `yt-dlp` command with the given parameters and returns a promise that resolves with the response.
 *
 * @param {string} bodyUrl - The URL of the item for which lister is going to be spawned.
 * @param {number} startNumber - The starting index of the listing operation.
 * @param {number} stopNumber - The ending index of the listing operation.
 * @return {Promise<string[]>} A promise that resolves with an array of strings representing the response from `yt-dlp`.
 */
async function listSpawner(bodyUrl, startNumber, stopNumber) {
  logger.trace(`listSpawner called`, {
    url: bodyUrl,
    start: startNumber,
    stop: stopNumber
  });

  return new Promise((resolve, reject) => {
    // Check if we've exceeded max listing processes
    if (listProcesses.size >= config.queue.maxListings) {
      logger.info("Max Listing processes spawned", { url: bodyUrl });
      return reject(new Error("Max Listing processes spawned"));
    }
    // Spawn the process
    const spawnedListProcess = spawn("yt-dlp", [
      "--playlist-start", startNumber.toString(),
      "--playlist-end", stopNumber.toString(),
      "--flat-playlist",
      "--print",
      "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s",
      bodyUrl
    ]);
    // Track the process
    const processEntry = {
      spawnType: "list",
      spawnedProcess: spawnedListProcess,
      lastActivity: Date.now(),
      spawnStatus: "running"
    };
    listProcesses.set(spawnedListProcess.pid.toString(), processEntry);
    // Collect response data
    let response = "";
    spawnedListProcess.stdout.setEncoding("utf8");
    spawnedListProcess.stdout.on("data", (data) => {
      response += data;
      // Update last activity timestamp
      const processCache = listProcesses.get(spawnedListProcess.pid.toString());
      if (processCache) {
        processCache.lastActivity = Date.now();
      }
    });
    // Handle stderr
    spawnedListProcess.stderr.setEncoding("utf8");
    spawnedListProcess.stderr.on("data", (data) => {
      logger.error(`stderr: ${data}`);
      // Update last activity timestamp
      const processCache = listProcesses.get(spawnedListProcess.pid.toString());
      if (processCache) {
        processCache.lastActivity = Date.now();
      }
    });
    // Handle spawn errors
    spawnedListProcess.on("error", (error) => {
      logger.error(`Spawn error: ${error.message}`);
      const processCache = listProcesses.get(spawnedListProcess.pid.toString());
      if (processCache) {
        processCache.spawnStatus = "failed";
        processCache.lastActivity = Date.now();
      }
    });
    // Handle process close
    spawnedListProcess.on("close", (code) => {
      const processCache = listProcesses.get(spawnedListProcess.pid.toString());
      if (code !== 0) {
        logger.error(`yt-dlp returned non-zero code: ${code}`);
        if (processCache) {
          processCache.spawnStatus = "failed";
        }
      }
      // Remove the process from the cache (this will trigger the dispose method)
      const removed = listProcesses.delete(spawnedListProcess.pid.toString());
      logger.debug(`List process removed from process queue: ${removed}`, {
        pid: spawnedListProcess.pid,
        code: code
      });
      // Resolve with processed response
      resolve(response.split("\n").filter((line) => line.length > 0));
    });
  });
}
/**
 * Asynchronously performs a background listing operation.
 *
 * @param {string} bodyUrl - The URL of the playlist.
 * @param {number} startNumber - The starting index of the playlist.
 * @param {number} stopNumber - The ending index of the playlist.
 * @param {number} chunk_size - The size of each chunk to process.
 * @param {boolean} isUpdateOperation - Indicates if the operation is an update.
 * @return {undefined}
 */
async function listBackground(
  bodyUrl,
  startNumber,
  stopNumber,
  chunk_size,
  isUpdateOperation
) {
  // yes a playlist on youtube atleast can only be 5000 long  && stopNumber < 5000
  // let max_size = 5000;
  // let loop_num = max_size / chunk_size;
  let count = 0;
  while (bodyUrl != "None") {
    startNumber = startNumber + chunk_size;
    stopNumber = stopNumber + chunk_size;
    // ideally we can set it to zero but that would get us rate limited by the services
    logger.trace(
      `listBackground: URL: ${bodyUrl}, Chunk: ${chunk_size},` +
      `Start: ${startNumber}, Stop: ${stopNumber}, Iteration: ${count}`
    );
    //await sleep();
    const response = await listSpawner(bodyUrl, startNumber, stopNumber);
    if (response.length === 0) {
      logger.trace(
        `Listing exited at Start: ${startNumber}, Stop: ${stopNumber}, Iteration ${count}`
      );
      break;
    }
    // yt-dlp starts counting from 1 for some reason so 1 needs to be subtracted here.
    const { quit_listing } = await processListingResponse(
      response,
      bodyUrl,
      startNumber - 1,
      isUpdateOperation
    );
    if (quit_listing) {
      logger.trace(
        `Listing exited at Start: ${startNumber}, Stop: ${stopNumber}, Iteration ${count}`
      );
      break;
    }
    count++;
  }
}
/**
 * Processes the response from a list operation and updates the video_list and video_indexer tables.
 *
 * @param {Array} response - The response array containing video information.
 * @param {string} bodyUrl - The URL of the playlist.
 * @param {number} index - The starting index of the list operation.
 * @param {boolean} isUpdateOperation - Indicates if it is an update operation.
 * @return {Promise<Object>} - A promise that resolves to an object containing the count of processed items, the response URL, the starting index, and a boolean indicating if listing should be quit.
 */
async function processListingResponse(
  response,
  bodyUrl,
  index,
  isUpdateOperation
) {
  logger.trace(
    `processListingResponse called`,
    { url: bodyUrl, start: index, isUpdate: isUpdateOperation }
  );
  const initResp = {
    count: 0,
    resp_url: bodyUrl,
    start: index,
    quit_listing: false,
  };
  // sock.emit("listing-or-downloading", { percentage: 101 });
  // Setting this to zero so that no effect is there in normal runs
  let last_item_index = 0;
  if (isUpdateOperation) {
    // manipulate the index
    const last_item = await video_indexer.findOne({
      where: {
        playlist_url: bodyUrl,
      },
      order: [["index_in_playlist", "DESC"]],
      attributes: ["index_in_playlist"],
      limit: 1,
    });
    logger.debug(`In update operation found last item ${JSON.stringify(last_item)}`);
    try {
      last_item_index = last_item.index_in_playlist + 1;
    } catch (error) {
      // encountered an error if unlisted videos was not initialized
      last_item_index = 1;
    }
  }
  // Query to check if all items already exist in the video_list table
  const allItemsExistInVideoList = await Promise.all(
    response.map(async (element) => {
      const element_arr = element.split("\t");
      const vid_url = element_arr[2];
      const foundItem = await video_list.findOne({
        where: { video_url: vid_url },
      });
      logger.debug(
        `found item: ${JSON.stringify(
          foundItem
        )} in video_list for url: ${vid_url}`
      );
      return foundItem !== null;
    })
  );
  // Query to check if the video is already indexed in the junction table
  const allItemsExistInVideoIndexer = await Promise.all(
    response.map(async (element) => {
      const element_arr = element.split("\t");
      const vid_url = element_arr[2];
      const playlist_url = bodyUrl; // Assuming bodyUrl refers to the playlist_url
      const foundItem = await video_indexer.findOne({
        where: { video_url: vid_url, playlist_url: playlist_url },
      });
      logger.debug(
        `found item: ${JSON.stringify(
          foundItem
        )} in video_indexer for url: ${vid_url} and playlist_url ${playlist_url}`
      );
      return foundItem !== null;
    })
  );
  if (
    allItemsExistInVideoList.every((item) => item === true) &&
    allItemsExistInVideoIndexer.every((item) => item === true)
  ) {
    logger.debug("All items already exist in the database.");
    initResp["quit_listing"] = true;
    initResp["count"] = allItemsExistInVideoIndexer.length;
    return initResp; // Return early if all items exist
  } else {
    logger.debug("Videos per list index exist in video_list", {
      allItemsExistInVideoList: JSON.stringify(allItemsExistInVideoList),
    });
    logger.debug("Videos per list index exist in video_indexer", {
      allItemsExistInVideoIndexer: JSON.stringify(allItemsExistInVideoIndexer),
    });
  }
  // This is what I was looking for
  await Promise.all(
    response.map(async (element, map_idx) => {
      try {
        const [title, ...rest] = element.split("\t");
        const vid_id = rest[0].trim();
        const vid_url = rest[1];
        const vid_size_temp = rest[2];
        const vid_size = vid_size_temp === "NA" ? -1 : parseInt(vid_size_temp);
        let item_available = true;
        if (["[Deleted video]", "[Private video]", "[Unavailable video]"].includes(title)) {
          item_available = false;
        }
        const title_processed = await stringSlicer(title === "NA" ? vid_id.trim() : title, config.maxTitleLength);
        if (!allItemsExistInVideoList[map_idx]) {
          const vid_data = {
            video_id: vid_id,
            title: title_processed,
            approximate_size: vid_size,
            downloaded: false,
            available: item_available,
          };
          const [foundVid, createdVid] = await video_list.findOrCreate({
            where: { video_url: vid_url },
            defaults: vid_data,
          });
          logger.debug("Result of video add " + JSON.stringify([foundVid, createdVid]));
          if (!createdVid) {
            updateVideoEntry(foundVid, vid_data);
          }
        }
        if (!allItemsExistInVideoIndexer[map_idx]) {
          const junction_data = {
            video_url: vid_url,
            playlist_url: bodyUrl,
            index_in_playlist: index + map_idx + last_item_index,
          };
          const [foundJunction, createdJunction] = await video_indexer.findOrCreate({
            where: junction_data,
          });
          logger.debug("Result of video_playlist_index add " + JSON.stringify([foundJunction, createdJunction]));
          if (!createdJunction) {
            logger.debug(`Found video_indexer: ${JSON.stringify(foundJunction)}`);
          }
        }
      } catch (error) {
        logger.error(`${error.message} - ${error.stack}`);
      } finally {
        initResp["count"]++;
      }
    })
  );
  return initResp;
}
//Authentication functions
/**
 * Asynchronously hashes the given password using bcrypt.
 *
 * @param {string} password - The password to be hashed
 * @return {Promise<Array>} A promise that resolves to an array containing the salt and hash
 */
async function hashPassword(password) {
  try {
    const salt = await bcrypt.genSalt(config.saltRounds);
    const hash = await bcrypt.hash(password, salt);
    return [salt, hash];
  } catch (error) {
    throw new Error("Error hashing password");
  }
}
/**
 * Asynchronously registers a user based on the request and response objects.
 *
 * @param {Object} req - the request object
 * @param {Object} res - the response object
 * @return {Promise<void>} a promise that resolves when the registration process is complete
 */
async function register(req, res) {
  // First check if registration is allowed
  if (!config.registration.allowed) {
    res.writeHead(403, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: "Registration is disabled" }));
  }

  // Check user limit
  const userCount = await users.count();
  if (userCount >= config.registration.maxUsers) {
    res.writeHead(403, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: "Maximum number of users reached" }));
  }

  const body = await extractJson(req),
    user_name = body["user_name"],
    body_password = body["password"];
  // Reject the request if the body_password is larger than 72 bytes as bcrypt only supports 72 bytes
  if (Buffer.byteLength(body_password, 'utf8') > 72) {
    logger.error("Password too long", {
      user_name: user_name,
      password_length: Buffer.byteLength(body_password, 'utf8'),
    });
    res.writeHead(400, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: "Password too long" }));
  }
  const foundUser = await users.findOne({
    where: { user_name: user_name },
  });
  if (body_password !== undefined) {
    if (foundUser === null) {
      const [salt, password] = await hashPassword(body_password);
      users.create({ user_name: user_name, salt: salt, password: password });
      res.writeHead(201, corsHeaders(config.types[".json"]));
      res.end(JSON.stringify({ Outcome: "User added successfully" }));
    } else {
      res.writeHead(409, corsHeaders(config.types[".json"]));
      res.end(JSON.stringify({ Outcome: "User already exists" }));
    }
  } else {
    res.writeHead(400, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ Outcome: "Password is empty" }));
  }
}
/**
 * Generates a token for the given user with the specified expiry time.
 *
 * @param {Object} user - The user object
 * @param {string} expiry_time - The expiry time for the token
 * @return {string} The generated token
 */
function generateToken(user, expiry_time) {
  return jwt.sign(
    {
      id: user.id,
      lastPasswordChangeTime: user.updatedAt
    },
    config.secretKey, { expiresIn: expiry_time }
  );
}
/**
 * Verify the token from the request, check for user data in cache or database, and handle token expiration or other errors.
 *
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @param {function} next - The next middleware function
 * @return {Promise<void>} Promise that resolves when the verification is completed
 */
async function verifyToken(req, res, next) {
  try {
    const body = await extractJson(req),
      token = body["token"];
    const decoded = jwt.verify(token, config.secretKey);
    //logger.verbose(`Decoded token: ${JSON.stringify(decoded)}}`);
    let foundUser = userCache.get(decoded.id);
    if (!foundUser) {
      logger.debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      userCache.set(decoded.id, foundUser);
    }
    //logger.verbose(`foundUser: ${JSON.stringify(foundUser)}`)
    // Check if the last password change timestamp matches the one in the database for the user
    if (foundUser === null) {
      logger.error("User not found in the database");
      res.writeHead(404, corsHeaders(config.types[".json"]));
      return res.end(JSON.stringify({ Outcome: "User not found" }));
    }
    let foundUserUpdatedAt = foundUser.updatedAt.toISOString(); // Convert to UTC ISO string
    if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
      logger.debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      userCache.set(decoded.id, foundUser);
      foundUserUpdatedAt = foundUser.updatedAt.toISOString();
      // Logging the re-fetched user data
      //debug(`foundUser.updatedAt: ${foundUserUpdatedAt}`);
      //debug(`decoded.lastPasswordChangeTime: ${decoded.lastPasswordChangeTime}`);
      // Checking again
      if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
        logger.error(`Token Expired`);
        res.writeHead(401, corsHeaders(config.types[".json"]));
        return res.end(JSON.stringify({ Outcome: "Token Expired" }));
      }
    }
    next(body, res);
  } catch (error) {
    logger.error(error);
    if (error.name === "TokenExpiredError") {
      sock.emit("token-expired")
      res.writeHead(401, corsHeaders(config.types[".json"]));
      return res.end(JSON.stringify({ Outcome: "Token Expired" }));
    }
    res.writeHead(500, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: he.escape(error.message) }));
  }
}
/**
 * Verify the socket data and return true if the token is valid, false otherwise.
 *
 * @param {Object} data - the socket data containing the authentication token
 * @return {boolean} true if the token is valid, false otherwise
 */
async function verifySocket(data) {
  try {
    const token = data.handshake.auth.token;
    const decoded = jwt.verify(token, config.secretKey);

    let foundUser = userCache.get(decoded.id);
    if (!foundUser) {
      logger.debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      userCache.set(decoded.id, foundUser);
    }

    // Check if the last password change timestamp matches the one in the token
    const foundUserUpdatedAt = foundUser.updatedAt.toISOString(); // Convert to UTC ISO string
    if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
      logger.debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      userCache.set(decoded.id, foundUser);

      // Update timestamp
      const updatedFoundUserUpdatedAt = foundUser.updatedAt.toISOString();

      // Checking again
      if (updatedFoundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
        logger.debug(`Token Expired`);
        return false;
      }
    }
    return true;
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      logger.error(`${error.message.split(":")[0]}`);
    }
    else if (error.name === "TokenExpiredError") {
      logger.error(`Token Expired`);
    }
    else {
      logger.error(error);
    }
    return false;
  }
}
/**
 * A rate limiter function that checks the incoming request's IP address against the maximum requests allowed within a standard TTL window. It then updates the IP cache and forwards the request to the next function.
 *
 * @param {object} req - the request object
 * @param {object} res - the response object
 * @param {function} current - the current function to be called
 * @param {function} next - the next function to be called
 * @param {number} max_requests_per_ip_in_stdTTL - maximum requests allowed per IP within standard TTL
 * @param {number} stdTTL - standard time-to-live value in seconds
 */
async function rateLimiter(req, res, current, next, max_requests_per_ip_in_stdTTL, stdTTL) {
  // const req_clone = req.clone();
  const ipAddress = req.socket.remoteAddress;
  logger.trace(`Incoming request from ${ipAddress}`);
  if (ipCache.get(ipAddress) >= max_requests_per_ip_in_stdTTL) {
    logger.debug(`rate limiting ${ipAddress}`);
    res.writeHead(429, corsHeaders(config.types[".json"]));
    return res.end(JSON.stringify({ Outcome: "Too many requests" }));
  }
  if (!ipCache.has(ipAddress)) {
    ipCache.set(ipAddress, 1, +stdTTL);
    logger.debug(`adding to ipCache ${ipAddress}: ${ipCache.get(ipAddress)}`);
  }
  else {
    ipCache.set(ipAddress, ipCache.get(ipAddress) + 1, +stdTTL);
    logger.debug(`ipCache ${ipAddress}: ${ipCache.get(ipAddress)}`);
  }
  current(req, res, next);
}
/**
 * Asynchronous function for user login.
 *
 * @param {Object} req - the request object
 * @param {Object} res - the response object
 * @return {Promise} a Promise that resolves when the login process is complete
 */
async function login(req, res) {
  try {
    const body = await extractJson(req),
      user_name = body["user_name"],
      body_password = body["password"],
      expiry_time = body["expiry_time"] || "31d";
    // Reject the request if the body_password is larger than 72 bytes as bcrypt only supports 72 bytes
    if (Buffer.byteLength(body_password, 'utf8') > 72) {
      logger.error("Password too long", {
        user_name: user_name,
        password_length: Buffer.byteLength(body_password, 'utf8'),
      });
      res.writeHead(400, corsHeaders(config.types[".json"]));
      return res.end(JSON.stringify({ Outcome: "Password too long" }));
    }
    const foundUser = await users.findOne({
      where: { user_name: user_name },
    });
    if (foundUser === null) {
      logger.verbose(`Issuing token for user ${user_name} failed`);
      res.writeHead(404, corsHeaders(config.types[".json"]));
      res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
    } else {
      const passwordMatch = await bcrypt.compare(body_password, foundUser.password);
      logger.trace(`Password match: ${passwordMatch}`, {
        user_name: user_name,
      });
      if (!passwordMatch) {
        logger.verbose(`Issuing token for user ${foundUser.user_name} failed`);
        res.writeHead(401, corsHeaders(config.types[".json"]));
        return res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
      }
      const token = generateToken(foundUser, expiry_time);
      logger.verbose(`Issued token for user ${foundUser.user_name} expires in ${expiry_time}`);
      res.writeHead(202, corsHeaders(config.types[".json"]));
      return res.end(JSON.stringify({ token: he.escape(token) }));
    }
  } catch (error) {
    logger.error(`Error generating token: ${error.message}`);
    res.writeHead(500, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ Outcome: "Internal Server Error" }));
  }
}

// The scheduled updater
/**
 * Executes a scheduled update by performing a quick update followed by a full update.
 * Emits a "playlist-done" event with a message and id indicating that the update is complete.
 * Logs the start and end time of the update, as well as the next scheduled update time.
 *
 * @return {Promise<void>} A promise that resolves when the update is complete.
 */
async function scheduledUpdater() {
  logger.info(`Scheduled update started at: ${new Date().toLocaleString()}`);
  logger.info(`Starting the quick update`);
  //quick update then full update
  quick_updates()
    .then(full_updates())
    .then(() =>
      sock.emit("playlist-done", {
        message: "done updating playlist or channel",
        id: "None",
      })
    );
  logger.info(`Scheduled update finished at: ${new Date().toLocaleString()}`);
  logger.info(`Next scheduled update on ${job.nextDates(1)}`);
}

/**
 * Executes quick updates for playlists of monitoring_type "Fast".
 *
 * @return {Promise<void>} A promise that resolves when all playlists are updated.
 */
async function quick_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: "Fast",
    },
  });

  logger.info(`Fast updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    let index = -config.chunkSize + 1;
    try {
      await sleep();
      await listBackground(
        playlist.playlist_url,
        index,
        index + config.chunkSize,
        config.chunkSize,
        true
      );
      logger.trace(`Done processing playlist ${playlist.playlist_url}`);
      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      logger.error(
        `error processing playlist ${playlist.playlist_url}, ${error.message}`
      );
    }
  }
}
// this one needs to be tested more
/**
 * Asynchronously updates all playlists marked as "Full" by performing a full update on each playlist.
 *
 * @return {Promise<void>} A Promise that resolves when all playlists have been updated.
 */
async function full_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: "Full",
    },
  });
  logger.info(`Full updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    try {
      logger.info(
        `Full updating playlist: ${playlist.title.trim()} being updated fully`
      );
      // Since this is a full update the isUpdateOperation will be false
      await sleep();
      await listBackground(
        playlist.playlist_url,
        0,
        config.chunkSize,
        config.chunkSize,
        false
      );
      logger.info(`Done processing playlist ${playlist.playlist_url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      logger.error(
        `error processing playlist ${playlist.playlist_url}: ${error.message}`
      );
    }
  }
}

// Download functions
/**
 * Asynchronous function for downloading items based on input body and response.
 *
 * @param {Object} body - The body containing information for downloading.
 * @param {Object} res - The response object to send back.
 * @return {Promise} A Promise that resolves when the download process is completed.
 */
async function downloadLister(body, res) {
  try {
    const downloadList = [],
      playListUrl = body["playListUrl"] !== undefined ?
        body["playListUrl"] : "None",
      urlList = body["urlList"] !== undefined ?
        body["urlList"] : [];
    for (const urlItem of [...new Set(urlList)]) {
      logger.debug(`checking for ${urlItem} in db`);
      const video_item = await video_list.findOne({
        where: { video_url: urlItem },
      });
      if (!video_item) {
        logger.error(`Video with URL ${urlItem} is not indexed`, {
          url: urlItem,
          table: "video_list"
        });
        res.writeHead(404, corsHeaders(config.types[".json"]));
        return res.end(JSON.stringify({ error: `Video with URL ${urlItem} is not indexed` }));
      }
      let saveDirectory = "";
      try {
        const saveDirectoryConst = await playlist_list.findOne({
          where: { playlist_url: playListUrl },
        });
        saveDirectory = saveDirectoryConst.save_dir;
      } catch (error) {
        if (saveDirectory !== "") {
          saveDirectory = "";
          logger.error(`${error.message}`);
        }
      }
      downloadList.push({
        url: urlItem,
        title: video_item.title,
        saveDirectory: saveDirectory,
        videoId: video_item.videoId
      });
    }
    downloadParallel(downloadList, config.queue.maxDownloads);
    res.writeHead(200, corsHeaders(config.types[".json"]));
    // This doesn't need escaping as it's consumed interanlly
    res.end(JSON.stringify({ Downloading: downloadList }));
  } catch (error) {
    logger.error(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ error: he.escape(error.message) }));
  }
}
// Download process tracking
const downloadProcesses = new Map(); // Map to track download processes
/**
 * Cleans up tasks in the provided task map based on their status and activity.
 * 
 * This function iterates through the `taskMap` and removes tasks that are either
 * completed, failed, or stalled for longer than the configured maximum idle time.
 * For stalled tasks, it attempts to terminate their associated processes using
 * `SIGKILL` or `SIGTERM` signals.
 * 
 * @param {Map<string, Object>} taskMap - A map containing task objects, where each key is a task identifier
 * and the value is an object representing the task. Each task object is expected to have the following properties:
 *   - {string} status - The current status of the task (e.g., 'completed', 'failed', 'running').
 *   - {number} lastActivity - The timestamp of the last activity for the task.
 *   - {number} spawnTimeStamp - The timestamp when the task was spawned.
 *   - {Function} [kill] - An optional function to terminate the task's process.
 * 
 * @throws {Error} Logs errors if process termination fails for stalled tasks.
 */
function cleanupMap(taskMap) {
  const now = Date.now();
  logger.info(`Cleaning up download processes older than ${config.queue.maxIdle / 1000} seconds`);
  logger.trace(`Map State: ${getStateFromMap(taskMap)}`);
  // Iterate through the taskMap and remove completed or stalled tasks
  for (const [key, task] of taskMap.entries()) {
    // logger.trace(`Task ${key} State: ${JSON.stringify(task)}`);
    const { status, lastActivity, spawnTimeStamp } = task;
    logger.debug(`Checking task ${key}, status=${status}, lastActivity=${lastActivity}, spawnTimeStamp=${spawnTimeStamp}`);
    if (status === 'completed' || status === 'failed') {
      logger.debug(`Cleaning up completed task: ${key}`);
      taskMap.delete(key);
    } else if (status === 'running' && (now - spawnTimeStamp > config.queue.maxIdle)) {
      logger.warn(`Cleaning up stalled task: ${key}`);
      logger.trace(`Task ${key} last activity: ${lastActivity}`);
      logger.trace(`Task ${key} spawn time: ${spawnTimeStamp}`);
      logger.trace(`Task ${key} idle time: ${now - spawnTimeStamp / 1000} seconds`);
      logger.trace(`Task ${key} has a kill handler? ${typeof task.spawnedProcess.kill}`);
      if (task && typeof task.spawnedProcess.kill === 'function') {
        try {
          task.warn(`Killing stalled process for task ${key} with SIGKILL`);
          // Attempt to kill the process
          const killed = task.spawnedProcess.kill('SIGKILL');
          if (killed) {
            logger.info(`Killed stalled process for task ${key}`);
          } else {
            logger.warn(`Failed to kill stalled process for task ${key}`);
            const terminate = task.spawnedProcess.kill('SIGTERM');
            logger.info(`Sent SIGTERM to stalled process for task ${key}`);
            if (terminate) {
              logger.info(`Terminated stalled process for task ${key}`);
            } else {
              logger.warn(`Failed to terminate stalled process for task ${key}`);
            }
          }
        } catch (err) {
          logger.error(`Failed to kill process for task ${key}:`, err);
        }
      }
      taskMap.delete(key);
    }
  }
}
setInterval(() => cleanupMap(downloadProcesses), config.queue.cleanUpInterval);
/**
 * Converts a Map of tasks into a JSON string representation of their statuses.
 *
 * @param {Map<string, {status: string}>} taskMap - A Map where the key is a task identifier (string)
 * and the value is an object containing a `status` property (string).
 * @returns {string} A JSON string representing an object where each key is a task identifier
 * and the value is the corresponding task's status.
 */
function getStateFromMap(taskMap) {
  const resultMap = new Map();
  for (const [key, task] of taskMap.entries()) {
    logger.debug(`Task ${key} with status: ${task.status}`);
    logger.trace(`Task ${key} with status: ${JSON.stringify(task)}`);
    resultMap.set(key, task.status);
  }
  return JSON.stringify(Object.fromEntries(resultMap));
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
 * Downloads the given items in parallel with enhanced process tracking using a semaphore for global concurrency control
 * 
 * @param {Array} items - Array of items to be downloaded
 * @param {number} [maxConcurrent=2] - Maximum number of concurrent downloads
 * @returns {Promise} A promise that resolves when all items have been downloaded
 */
async function downloadParallel(items, maxConcurrent = 2) {
  logger.trace(`Downloading ${items.length} videos in parallel (max ${maxConcurrent} concurrent)`);

  // Update the semaphore's max concurrent value
  DownloadSemaphore.setMaxConcurrent(maxConcurrent);

  // Filter out URLs already being downloaded
  const filterUniqueItems = items.filter(item => {
    const url = item.url;
    const existingDownload = Array.from(downloadProcesses.values())
      .find(process => process.url === url &&
        ['running', 'pending'].includes(process.status));

    return !existingDownload;
  });

  logger.trace(`Filtered unique items for download: ${filterUniqueItems.length}`);

  // Process all items with semaphore control
  const downloadPromises = filterUniqueItems.map(item =>
    downloadItemWithSemaphore(item)
  );

  // Wait for all downloads to complete
  const results = await Promise.all(downloadPromises);

  // Check for any failures
  let allSuccess = results.every(result => result.status === 'success');

  // Log results
  results.forEach(result => {
    if (result.status === 'success') {
      logger.info(`Downloaded ${result.title} successfully`);
    } else if (result.status === 'failed') {
      logger.error(`Failed to download ${result.title}: ${result.error}`);
    }
  });

  return allSuccess;
}
/**
 * Wrapper for downloadItem that uses the semaphore to control concurrency
 */
async function downloadItemWithSemaphore(item) {
  logger.trace(`Downloading item with semaphore: ${JSON.stringify(item)}`);
  // Acquire the semaphore before starting the download
  await DownloadSemaphore.acquire();
  try {
    // Update task status in downloadProcesses to pending
    const urlString = item.url,
      title = item.title;
    const pendingEntry = {
      url: urlString,
      title: title,
      lastActivity: Date.now(),
      spawnTimeStamp: Date.now(),
      status: "pending"
    };
    const pendingKey = `pending_${urlString}_${Date.now()}`;
    downloadProcesses.set(pendingKey, pendingEntry);

    // Actual download
    const result = await downloadItem(item, pendingKey);

    // Clean up the pending entry if it's still there
    if (downloadProcesses.has(pendingKey)) {
      downloadProcesses.delete(pendingKey);
    }

    return result;
  } finally {
    // Always release the semaphore, even if an error occurred
    DownloadSemaphore.release();
  }
}
// Create a function to download a single item
/**
 * Downloads a video or media item using yt-dlp and manages the download process.
 * Ensures that no duplicate downloads are initiated and tracks the progress of the download.
 *
 * @async
 * @function downloadItem
 * @param {Object} itemToDownload - An object containing details of the item to download.
 * @param {string} itemToDownload.url - The URL of the video or media to download.
 * @param {string} itemToDownload.title - The title of the video or media.
 * @param {string} itemToDownload.saveDirectory - The directory where the file should be saved.
 * @param {string} itemToDownload.videoId - The unique video ID.
 * @param {string} processEntryKey - The key used to track the download process in the `downloadProcesses` map.
 * @returns {Promise<Object>} A promise that resolves to an object containing the download status and details:
 * - `url` {string} - The URL of the downloaded item.
 * - `title` {string} - The title of the downloaded item.
 * - `status` {string} - The status of the download (`success`, `failed`, or `skipped`).
 * - `reason` {string} [optional] - The reason for skipping the download (if applicable).
 * - `error` {string} [optional] - The error message (if applicable).
 *
 * @throws {Error} If an error occurs during the download process.
 *
 * @example
 * const item = {
 *   url: "https://example.com/video",
 *   title: "Sample Video",
 *   saveDirectory: "videos",
 *   videoId: "12345"
 * };
 * downloadItem(item, "processKey123")
 *   .then(result => console.log(result))
 *   .catch(error => console.error(error));
 */
const downloadItem = async (itemToDownload, processEntryKey) => {
  const urlString = itemToDownload.url,
    title = itemToDownload.title,
    saveDirectory = itemToDownload.saveDirectory,
    videoId = itemToDownload.videoId;

  try {

    // Prepare save path
    const save_path = path_fs.join(config.saveLocation, saveDirectory.trim());
    logger.debug(`Downloading to path: ${save_path}`);

    // Create directory if it doesn't exist
    if (save_path !== config.saveLocation && !fs.existsSync(save_path)) {
      fs.mkdirSync(save_path, { recursive: true });
    }

    // Return a promise that resolves when download is complete
    return new Promise((resolve, reject) => {
      let hold = null;
      let realFileName = null;

      sock.emit("download-start", { message: "" });

      const spawnedDownloadProcess = spawn("yt-dlp", downloadOptions.concat([save_path, urlString]));

      // Track the process for cleanup
      const processEntry = downloadProcesses.get(processEntryKey);
      if (processEntry) {
        processEntry.spawnedProcess = spawnedDownloadProcess;
        processEntry.status = "running";
        processEntry.lastActivity = Date.now();
        downloadProcesses.set(processEntryKey, processEntry);
      } else {
        logger.error(`Process entry not found for key: ${processEntryKey}`);
        return reject(new Error(`Process entry not found for key: ${processEntryKey}`));
      }

      // Handle stdout
      spawnedDownloadProcess.stdout.setEncoding("utf8");
      spawnedDownloadProcess.stdout.on("data", (data) => {
        try {
          const dataStr = data.toString().trim();

          // Percentage tracking
          const percentageMatch = /(\d{1,3}\.\d)/.exec(dataStr);
          if (percentageMatch !== null) {
            const percentage = parseFloat(percentageMatch[0]);
            const percentageDiv10 = Math.floor(percentage / 10);

            if (percentageDiv10 === 0 && hold === null) {
              hold = 0;
              logger.trace(dataStr, { pid: spawnedDownloadProcess.pid });
            } else if (percentageDiv10 > hold) {
              hold = percentageDiv10;
              logger.trace(dataStr, { pid: spawnedDownloadProcess.pid });
            }

            sock.emit("listing-or-downloading", { percentage: percentage });
          }

          // Filename extraction
          const fileNameMatch = /Destination: (.+)/m.exec(dataStr);
          if (fileNameMatch && fileNameMatch[1] && realFileName === null) {
            realFileName = fileNameMatch[1]
              .replace(path_fs.extname(fileNameMatch[1]), "")
              .replace(save_path + "/", "")
              .trim();
            logger.debug(`Extracted filename: ${realFileName}, filename from db: ${title}`, { pid: spawnedDownloadProcess.pid });
          }

          // Track the process for cleanup
          const processEntry = downloadProcesses.get(processEntryKey);
          if (processEntry) {
            processEntry.lastActivity = Date.now();
          } else {
            logger.error(`Process entry not found for key: ${processEntryKey}`);
            return reject(new Error(`Process entry not found for key: ${processEntryKey}`));
          }
        } catch (error) {
          if (!(error instanceof TypeError)) {
            sock.emit("error", { message: `${error}` });
          }
        }
      });

      // Handle stderr
      spawnedDownloadProcess.stderr.setEncoding("utf8");
      spawnedDownloadProcess.stderr.on("data", (data) => {
        logger.error(`stderr: ${data}`, { pid: spawnedDownloadProcess.pid });
        // Track the process for cleanup
        const processEntry = downloadProcesses.get(processEntryKey);
        if (processEntry) {
          processEntry.lastActivity = Date.now();
        } else {
          logger.error(`Process entry not found for key: ${processEntryKey}`);
          return reject(new Error(`Process entry not found for key: ${processEntryKey}`));
        }
      });

      // Handle process errors
      spawnedDownloadProcess.on("error", (error) => {
        logger.error(`Download process error: ${error.message}`, { pid: spawnedDownloadProcess.pid });
        // Track the process for cleanup
        const processEntry = downloadProcesses.get(processEntryKey);
        if (processEntry) {
          processEntry.lastActivity = Date.now();
        } else {
          logger.error(`Process entry not found for key: ${processEntryKey}`);
          return reject(new Error(`Process entry not found for key: ${processEntryKey}`));
        }
        reject(error);
      });

      // Handle process close
      spawnedDownloadProcess.on("close", async (code) => {
        try {
          const entity = await video_list.findOne({
            where: { video_url: urlString },
          });

          if (code === 0) {
            const entityProp = {
              downloaded: true,
              available: true,
              title: (title === videoId || title === "NA")
                ? (realFileName || title)
                : title
            };
            logger.debug(`Update data: ${JSON.stringify(entityProp)}`, { pid: spawnedDownloadProcess.pid });

            entity.set(entityProp);
            await entity.save();

            const titleForFrontend = entityProp.title;
            sock.emit("download-done", {
              message: titleForFrontend,
              url: urlString,
              title: titleForFrontend
            });

            // Remove from download processes cache
            const processEntry = downloadProcesses.has(processEntryKey);
            if (processEntry) {
              downloadProcesses.delete(processEntryKey);
            } else {
              logger.error(`Process entry not found for key: ${processEntryKey}`);
              return reject(new Error(`Process entry not found for key: ${processEntryKey}`));
            }
            logger.trace(`Removed process from cache: ${spawnedDownloadProcess.pid}`, { pid: spawnedDownloadProcess.pid });

            // Printing the map state and size for debugging
            logger.trace(`Map State: ${getStateFromMap(downloadProcesses)}`, { pid: spawnedDownloadProcess.pid });
            logger.trace(`Map Size: ${downloadProcesses.size}`, { pid: spawnedDownloadProcess.pid });

            resolve({
              url: urlString,
              title: titleForFrontend,
              status: 'success'
            });
          } else {
            sock.emit("download-failed", {
              message: `${entity.title}`,
              url: urlString,
            });

            resolve({
              url: urlString,
              title: title,
              status: 'failed'
            });
          }
        } catch (error) {
          logger.error(`Error in download close handler: ${error.message}`, { pid: spawnedDownloadProcess.pid });
          reject(error);
        }
      });
    });
  } catch (error) {
    logger.error(`Parallel download error: ${error.message}`);
    return {
      url: urlString,
      title: title,
      status: 'failed',
      error: error.message
    };
  }
};
/**
 * Asynchronously handles monitoring type functionality based on the input body and response.
 *
 * @param {Object} body - The body object containing url and watch parameters.
 * @param {Object} res - The response object for sending the outcome of the monitoring.
 * @return {Promise} A Promise that resolves when the monitoring process is complete.
 */
async function monitoringTypeUpdater(body, res) {
  try {
    const bodyUrl = body["url"],
      monitoring_type = body["watch"];
    if (body["url"] === undefined || body["watch"] === undefined) {
      throw new Error("url and watch are required");
    }
    logger.trace(
      `monitoringTypeUpdater:  url: ${bodyUrl}, monitoring_type: ${monitoring_type}`
    );
    const playlist = await playlist_list.findOne({
      where: { playlist_url: bodyUrl },
    });
    playlist.monitoring_type = monitoring_type;
    await playlist.update({ monitoring_type }, { silent: true });
    res.writeHead(200, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ Outcome: "Success" }));
  } catch (error) {
    logger.error(`error in monitoringTypeUpdater: ${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ error: he.escape(error.message) }));
  }
}
// TODO: Fix this stupid function
/**
 * Adds a playlist to the playlist_list table in the database.
 *
 * @param {string} url_var - The URL of the playlist.
 * @param {string} monitoring_type_var - The type of monitoring for the playlist.
 * @return {Promise<void>} - A Promise that resolves when the playlist is added.
 */
async function add_playlist(url_var, monitoring_type_var) {
  let title_str = "",
    next_item_index = 0;
  const last_item_index = await playlist_list.findOne({
    order: [["playlist_index", "DESC"]],
    attributes: ["playlist_index"],
    limit: 1,
  });
  if (last_item_index !== null)
    next_item_index = last_item_index.playlist_index + 1;
  if (listProcesses.size >= config.queue.maxListings) {
    logger.info("Max Listing processes spawned", { url: url_var });
    return new Error("Max Listing processes spawned");
  }
  const getTitleProcess = spawn("yt-dlp", [
    "--playlist-end",
    1,
    "--flat-playlist",
    "--print",
    "%(playlist_title)s",
    url_var,
  ]);
  // Track the process
  const processEntry = {
    spawnType: "list",
    spawnedProcess: getTitleProcess,
    lastActivity: Date.now(),
    spawnStatus: "running"
  };
  listProcesses.set(getTitleProcess.pid.toString(), processEntry);
  getTitleProcess.stdout.setEncoding("utf8");
  getTitleProcess.stdout.on("data", async (data) => {
    title_str += data;
    // Update last activity timestamp
    const processCache = listProcesses.get(getTitleProcess.pid.toString());
    if (processCache) {
      processCache.lastActivity = Date.now();
    }
  });
  getTitleProcess.stderr.setEncoding("utf8");
  getTitleProcess.stderr.on("data", (data) => {
    logger.error(`stderr: ${data}`);
    // Update last activity timestamp
    const processCache = listProcesses.get(getTitleProcess.pid.toString());
    if (processCache) {
      processCache.lastActivity = Date.now();
    }
  });
  getTitleProcess.on("error", (error) => {
    logger.error(`Error in getTitleProcess: ${error.message}`);
    // Update last activity timestamp
    const processCache = listProcesses.get(getTitleProcess.pid.toString());
    if (processCache) {
      processCache.spawnStatus = "failed";
    }
  });
  getTitleProcess.on("close", async (code) => {
    const processCache = listProcesses.get(getTitleProcess.pid.toString());
    if (code !== 0) {
      logger.error(`yt-dlp returned non-zero code: ${code}`);
      if (processCache) {
        processCache.spawnStatus = "failed";
      }
    }
    if (code === 0) {
      if (title_str.trim() == "NA") {
        try {
          title_str = urlToTitle(url_var);
        } catch (error) {
          title_str = url_var;
          logger.error(`${error.message}`);
        }
      }
      title_str = stringSlicer(title_str, config.maxTitleLength);
      logger.debug(`Title: ${title_str}`, { url: url_var, pid: getTitleProcess.pid });
      // no need to use found or create syntax here as
      // this is only run the first time a playlist is made
      await playlist_list.findOrCreate({
        where: { playlist_url: url_var },
        defaults: {
          title: title_str.trim(),
          monitoring_type: monitoring_type_var,
          save_dir: title_str.trim(),
          playlist_index: next_item_index,
        },
      });
    }
    logger.error("Playlist could not be created", {
      url: url_var,
      code: code,
    });
    if (listProcesses.has(getTitleProcess.pid.toString())) {
      const removed = listProcesses.delete(getTitleProcess.pid.toString());
      logger.debug(`List process removed from process queue: ${removed}`, {
        pid: getTitleProcess.pid,
        code: code
      });
    } else {
      logger.warn(`Attempted to remove a non-existent process from the queue`, {
        pid: getTitleProcess.pid
      });
    }
  });
}

// Query function that send data to frontend
/**
 * Asynchronously processes the playlists data and sends the result to the frontend.
 *
 * @param {Object} body - The request body containing parameters for processing playlists.
 * @param {Object} res - The response object to send back the processed playlists data.
 */
async function playlistsToTable(body, res) {
  try {
    const start_num = body["start"] !== undefined ? +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? +body["stop"] : config.chunkSize,
      sort_with = body["sort"] !== undefined ? +body["sort"] : 1,
      order = body["order"] !== undefined ? +body["order"] : 1,
      query_string = body["query"] !== undefined ? body["query"] : "",
      type = order == 2 ? "DESC" : "ASC", // 0, 1 it will be ascending else descending
      row = sort_with == 3 ? "updatedAt" : "playlist_index";
    logger.trace(
      `playlistsToTable called`, {
      start: start_num,
      stop: stop_num,
      order: order,
      query: query_string,
      type: type,
      row: row
    }
    );
    if (query_string == "") {
      playlist_list
        .findAndCountAll({
          where: {
            playlist_index: {
              [Op.gte]: 0,
            },
          },
          limit: stop_num - start_num,
          offset: start_num,
          order: [[row, type]],
        })
        .then((result) => {
          res.writeHead(200, corsHeaders(config.types[".json"]));
          res.end(JSON.stringify(result));
        });
    } else {
      playlist_list
        .findAndCountAll({
          where: {
            title: {
              [Op.iLike]: `%${query_string}%`,
            },
            playlist_index: {
              // In future there can many more hidden playlists
              // so this seems like a good addition
              [Op.gte]: 0,
            },
          },
          limit: stop_num - start_num,
          offset: start_num,
          order: [[row, type]],
        })
        .then((result) => {
          res.writeHead(200, corsHeaders(config.types[".json"]));
          res.end(JSON.stringify(result));
        });
    }
  } catch (error) {
    logger.error(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ error: he.escape(error.message) }));
  }
}
/**
 * Asynchronously processes the sublist data and sends the result to the frontend.
 *
 * @param {Object} body - The request body containing parameters for processing the sublist.
 * @param {Object} res - The response object to send back the processed sublist data.
 * @return {Promise} A promise that resolves when the data has been processed and sent to the frontend.
 */
async function sublistToTable(body, res) {
  try {
    const playlist_url = body["url"] !== undefined ? body["url"] : "None",
      // temp fix for Frontend bug that is causing the start number to be -ve and crashing the app
      start_num = body["start"] !== undefined ? +body["start"] < 0 ? 0 : +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? +body["stop"] : config.chunkSize,
      query_string = body["query"] !== undefined ? body["query"] : "",
      sort_downloaded = body["sortDownloaded"] !== undefined ? body["sortDownloaded"] : false,
      // [video_list, "downloaded", "DESC"] shows up as [null,"downloaded","DESC"] in the logs
      // but removing it causes an errorMissingColumnError: column video_list.downloaded does not exist
      order_array = sort_downloaded
        ? [video_list, "downloaded", "DESC"]
        : ["index_in_playlist", "ASC"];
    logger.trace(
      `sublistToTable called`, {
      start: start_num,
      stop: stop_num,
      query: query_string,
      orderFor: sort_downloaded ? "downloaded" : "index_in_playlist",
      order: sort_downloaded ? "DESC" : "ASC",
      playlist_url: playlist_url
    });
    try {
      if (query_string == "") {
        // video_indexer is not associated to video_list!
        video_indexer
          .findAndCountAll({
            attributes: ["index_in_playlist", "playlist_url"],
            include: [
              {
                attributes: [
                  "title",
                  "video_id",
                  "video_url",
                  "downloaded",
                  "available",
                ],
                model: video_list,
              },
            ],
            where: { playlist_url: playlist_url },
            limit: stop_num - start_num,
            offset: start_num,
            // To sort by downloaded - [video_list, "downloaded", "DESC"]
            // To sort by index_in_playlist - ["index_in_playlist", "DESC"]
            order: [order_array],
            //raw: true,
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(config.types[".json"]));
            res.end(JSON.stringify(result));
          });
      } else {
        video_indexer
          .findAndCountAll({
            attributes: ["index_in_playlist", "playlist_url"],
            include: [
              {
                attributes: [
                  "title",
                  "video_id",
                  "video_url",
                  "downloaded",
                  "available",
                ],
                model: video_list,
                where: { title: { [Op.iLike]: `%${query_string}%` } },
              },
            ],
            where: { playlist_url: playlist_url },
            limit: stop_num - start_num,
            offset: start_num,
            order: [order_array],
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(config.types[".json"]));
            res.end(JSON.stringify(result));
          });
      }
    } catch (error) {
      logger.error(`${error.message}`);
    }
  } catch (error) {
    logger.error(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(config.types[".json"]));
    res.end(JSON.stringify({ error: he.escape(error.message) }));
  }
}

// Functions to run the server
/**
 * Returns CORS headers based on the specified type.
 *
 * @param {string} type - The type to be used for Content-Type header
 * @return {object} CORS headers object
 */
const corsHeaders = (type) => {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": 2592000,
    "Content-Type": type,
  };
};

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
      type: config.types[element.extension],
    };
  });
  staticAssets[`${config.urlBase}/`] = staticAssets[`${config.urlBase}/index.html`];
  staticAssets[config.urlBase] = staticAssets[`${config.urlBase}/index.html`];
  staticAssets[`${config.urlBase}/.gz`] = staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}.gz`] = staticAssets[`${config.urlBase}/index.html.gz`];
  staticAssets[`${config.urlBase}/.br`] = staticAssets[`${config.urlBase}/index.html.br`];
  staticAssets[`${config.urlBase}.br`] = staticAssets[`${config.urlBase}/index.html.br`];
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets = makeAssets(filesList);
let serverOptions = {};

if (config.nativeHttps) {
  const keyPath = process.env.KEY_PATH;
  const certPath = process.env.CERT_PATH;
  try {
    serverOptions = {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8")
    };
  } catch (error) {
    logger.error("Error reading secret files:", error);
    process.exit(1);
  }
}

const server = http.createServer(serverOptions, (req, res) => {
  if (req.url.startsWith(config.urlBase) && req.method === "GET") {
    try {
      const get = req.url;
      const reqEncoding = req.headers["accept-encoding"] || "";
      const resHeaders = corsHeaders(staticAssets[get].type);
      logger.trace(`Request Recieved`, {
        path: req.url,
        method: req.method,
        encoding: reqEncoding,
      });
      if (reqEncoding.includes("br")) {
        resHeaders["Content-Encoding"] = "br";
        res.writeHead(200, resHeaders);
        res.write(staticAssets[get + ".br"].file);
        return res.end();
      } else if (reqEncoding.includes("gzip")) {
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
      res.writeHead(404, corsHeaders(config.types[".html"]));
      res.write("Not Found");
    }
    res.end();
  } else if (req.method === "OPTIONS") {
    // necessary for cors
    res.writeHead(204, corsHeaders(config.types[".json"]));
    res.end();
  } else if (req.method === "HEAD") {
    // necessary for health check
    res.writeHead(204, corsHeaders(config.types[".json"]));
    res.end();
  } else if (req.url === config.urlBase + "/list" && req.method === "POST") {
    verifyToken(req, res, listFunc);
  } else if (req.url === config.urlBase + "/download" && req.method === "POST") {
    verifyToken(req, res, downloadLister);
  } else if (req.url === config.urlBase + "/watch" && req.method === "POST") {
    verifyToken(req, res, monitoringTypeUpdater);
  } else if (req.url === config.urlBase + "/getplay" && req.method === "POST") {
    verifyToken(req, res, playlistsToTable);
  } else if (req.url === config.urlBase + "/getsub" && req.method === "POST") {
    verifyToken(req, res, sublistToTable);
  }
  else if (req.url === config.urlBase + "/register" && req.method === "POST") {
    rateLimiter(req, res, register, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  }
  else if (req.url === config.urlBase + "/login" && req.method === "POST") {
    rateLimiter(req, res, login, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  } else {
    logger.error("Requested Resource couldn't be found", {
      path: req.url,
      method: req.method
    });
    res.writeHead(404, corsHeaders(config.types[".html"]));
    res.write("Not Found");
    res.end();
  }
});

const io = new Server(server, {
  path: config.urlBase + "/socket.io/",
  cors: {
    // cors will only happen on these so it's best to keep it limited
    origin: [
      `http://localhost:5173`,
      `http://localhost:${config.port}`,
    ],
  },
});

io.use((socket, next) => {
  verifySocket(socket).then((result) => {
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
  logger.info(`Next scheduled update is on ${job.nextDates(1)}`);
  logger.verbose(
    `Download Options: yt-dlp ${downloadOptions.join(" ")} "${config.saveLocation.endsWith("/") ? config.saveLocation : config.saveLocation + "/"}` +
    `{playlist_dir}" "{url}"`
  );
  logger.verbose(
    "List Options: yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
    `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {bodyUrl}`
  );
  job.start();
});
