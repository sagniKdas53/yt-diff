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
  defaultCORSMaxAge: 2592000, // 30 days
  urlBase: process.env.BASE_URL || "/ytdiff",
  ssl: {
    key: process.env.SSL_KEY,
    cert: process.env.SSL_CERT,
    passphrase: process.env.SSL_PASSPHRASE,
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
    cleanUpInterval: +process.env.CLEANUP_INTERVAL_MS || 1 * 60 * 1000, // 1 minutes
    maxIdle: +process.env.PROCESS_MAX_AGE || 5 * 60 * 1000, // 5 minutes
  },
  registration: {
    allowed: process.env.ALLOW_REGISTRATION === "true",
    maxUsers: +(process.env.MAX_USERS || 10)
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
};
const CORS_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  `http://localhost:${config.port}`,
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
          ip: request.connection.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method
        });

        request.connection.destroy();
        reject({
          status: 413,
          message: "Request Too Large"
        });
      }
    });

    request.on("end", () => {
      try {
        const parsedData = JSON.parse(requestBody);
        resolve(parsedData);
      } catch (error) {
        logger.error("Failed to parse JSON", {
          ip: request.connection.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method,
          error: error.message
        });

        reject({
          status: 400,
          message: "Invalid JSON"
        });
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
    const userCount = await users.count();
    if (userCount >= config.registration.maxUsers) {
      response.writeHead(403, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Maximum number of users reached"
      }));
    }

    const requestData = await parseRequestJson(request);
    const { user_name: username, password } = requestData;

    // Validate password length (bcrypt limit is 72 bytes)
    if (Buffer.byteLength(password, 'utf8') > 72) {
      logger.error("Password too long", {
        username,
        passwordLength: Buffer.byteLength(password, 'utf8')
      });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Password exceeds maximum length"
      }));
    }

    // Check for existing user
    const existingUser = await users.findOne({
      where: { user_name: username }
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
    await users.create({
      user_name: username,
      salt: salt,
      password: hashedPassword
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
 * Middleware to verify JWT tokens and check user authentication
 *
 * @param {Object} request - HTTP request object
 * @param {Object} response - HTTP response object
 * @param {Function} next - Next middleware function
 * @returns {Promise<void>} Resolves when verification completes
 */
async function authenticateRequest(request, response, next) {
  try {
    const requestData = await parseRequestJson(request);
    const { token } = requestData;

    // Verify token
    const decodedToken = jwt.verify(token, config.secretKey);

    // Check cache first
    let user = userCache.get(decodedToken.id);

    if (!user) {
      logger.debug(`Fetching user data for ID ${decodedToken.id}`);
      user = await users.findByPk(decodedToken.id);
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

    // Continue to next middleware
    next(requestData, response);

  } catch (error) {
    logger.error("Token verification failed", { error: error.message });

    const statusCode = error.name === "TokenExpiredError" ? 401 : 500;
    const message = error.name === "TokenExpiredError" ? "Token expired" : "Authentication failed";

    if (error.name === "TokenExpiredError") {
      sock.emit("token-expired", { error: error.message });
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
      user = await users.findByPk(decodedToken.id);
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
    const requestData = await parseRequestJson(request);
    const {
      user_name: username,
      password,
      expiry_time: expiryTime = "31d"
    } = requestData;

    // Validate password length
    if (Buffer.byteLength(password, 'utf8') > 72) {
      logger.error("Password too long", {
        username,
        passwordLength: Buffer.byteLength(password, 'utf8')
      });
      response.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Password exceeds maximum length"
      }));
    }

    // Find user
    const user = await users.findOne({
      where: { user_name: username }
    });

    if (!user) {
      logger.verbose(`Authentication failed for user ${username}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      logger.verbose(`Authentication failed for user ${username}`);
      response.writeHead(401, generateCorsHeaders(MIME_TYPES[".json"]));
      return response.end(JSON.stringify({
        status: 'error',
        message: "Invalid credentials"
      }));
    }

    // Generate token
    const token = generateAuthToken(user, expiryTime);
    logger.verbose(`Authentication successful for user ${username}`);

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
 *   - {Object} spawnedProcess - The child process associated with the task.
 *   - {function} spawnedProcess.kill - A function to terminate the child process.
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
          logger.warn(`Killing stalled process for task ${key} with SIGKILL`);
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
          logger.error(`Failed to kill process for task ${key}:`, { error: err.message });
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
    const processedUrls = new Set();
    const playlistUrl = requestBody.playListUrl ?? "None";

    // Process each URL
    for (const videoUrl of requestBody.urlList) {
      if (processedUrls.has(videoUrl)) {
        continue; // Skip duplicates
      }

      logger.debug(`Checking video in database`, { url: videoUrl });

      // Look up video in database
      const videoEntry = await video_list.findOne({
        where: { video_url: videoUrl }
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
        const playlist = await playlist_list.findOne({
          where: { playlist_url: playlistUrl }
        });
        saveDirectory = playlist?.save_dir ?? "";
      } catch (error) {
        logger.error(`Error getting playlist save directory`, {
          error: error.message,
          playlistUrl
        });
      }

      // Add to download queue
      videosToDownload.push([
        videoUrl,
        videoEntry.title,
        saveDirectory,
        videoEntry.video_id
      ]);
      processedUrls.add(videoUrl);
    }

    // Start downloads
    downloadItemsConcurrently(videosToDownload, config.queue.maxDownloads);

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
 * @param {Array<Array<string>>} items - Array of items to download, each containing:
 *   [0]: URL of video
 *   [1]: Title of video  
 *   [2]: Save directory path
 *   [3]: Video ID
 * @param {number} [maxConcurrent=2] - Maximum number of concurrent downloads
 * @returns {Promise<boolean>} Resolves to true if all downloads successful
 */
async function downloadItemsConcurrently(items, maxConcurrent = 2) {
  logger.trace(`Downloading ${items.length} videos concurrently (max ${maxConcurrent} concurrent)`);

  // Update the semaphore's max concurrent value
  DownloadSemaphore.setMaxConcurrent(maxConcurrent);

  // Filter out URLs already being downloaded
  const uniqueItems = items.filter(item => {
    const videoUrl = item[0];
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
 * @param {Array} downloadItem - Array containing video details:
 *   [0]: Video URL
 *   [1]: Video title
 *   [2]: Save directory path  
 *   [3]: Video ID
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
    const [videoUrl, videoTitle] = downloadItem;

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
 * @param {Array} downloadItem - Array containing video details:
 *   [0]: Video URL  
 *   [1]: Video title
 *   [2]: Save directory path
 *   [3]: Video ID
 * @param {string} processKey - Key to track download process
 * @returns {Promise<Object>} Download result containing:
 *   - url: Video URL
 *   - title: Video title
 *   - status: 'success' | 'failed' 
 *   - error?: Error message if failed
 */
async function executeDownload(downloadItem, processKey) {
  const [videoUrl, videoTitle, saveDir, videoId] = downloadItem;

  try {
    // Prepare save path
    const savePath = path_fs.join(config.saveLocation, saveDir.trim());
    logger.debug(`Downloading to path: ${savePath}`);

    // Create directory if needed
    if (savePath !== config.saveLocation && !fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let progressPercent = null;
      let actualFileName = null;

      // Notify frontend of download start
      sock.emit("download-started", { percentage: 101 });

      // Spawn download process
      const downloadProcess = spawn("yt-dlp", downloadOptions.concat([savePath, videoUrl]));

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

            sock.emit("downloading-percent-update", { percentage: percent });
          }

          // Extract actual filename
          const fileNameMatch = /Destination: (.+)/m.exec(output);
          if (fileNameMatch?.[1] && !actualFileName) {
            actualFileName = fileNameMatch[1]
              .replace(path_fs.extname(fileNameMatch[1]), "")
              .replace(savePath + "/", "")
              .trim();

            logger.debug(`Actual filename: ${actualFileName}, DB title: ${videoTitle}`,
              { pid: downloadProcess.pid });
          }

          // Update activity timestamp
          updateProcessActivity(processKey);

        } catch (error) {
          if (!(error instanceof TypeError)) {
            sock.emit("error", { message: error.message });
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
          const videoEntry = await video_list.findOne({
            where: { video_url: videoUrl }
          });

          if (code === 0) {
            // Update video entry on success
            const updates = {
              downloaded: true,
              available: true,
              title: (videoTitle === videoId || videoTitle === "NA")
                ? (actualFileName || videoTitle)
                : videoTitle
            };

            logger.debug(`Updating video: ${JSON.stringify(updates)}`,
              { pid: downloadProcess.pid });

            await videoEntry.update(updates);

            // Notify frontend
            sock.emit("download-done", {
              url: videoUrl,
              title: updates.title
            });

            // Cleanup process entry
            cleanupProcess(processKey, downloadProcess.pid);

            resolve({
              url: videoUrl,
              title: updates.title,
              status: 'success'
            });

          } else {
            // Handle download failure
            sock.emit("download-failed", {
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
    logger.trace(`Process map state: ${getStateFromMap(downloadProcesses)}`);
    logger.trace(`Process map size: ${downloadProcesses.size}`);
  }
}

// List functions
const listProcesses = new Map(); // Map to track listing processes
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
    // Check process limit
    if (listProcesses.size >= config.queue.maxListings) {
      logger.info("Maximum listing processes reached", { url: videoUrl });
      return reject(new Error("Maximum listing processes reached"));
    }

    // Configure process arguments
    const processArgs = [
      "--playlist-start", startIndex.toString(),
      "--playlist-end", endIndex.toString(),
      "--flat-playlist",
      "--print",
      "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s",
      videoUrl
    ];

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
    responseUrl: playlistUrl,
    startIndex: startIndex,
    shouldStopProcessing: false
  };

  // Get last processed index for updates
  let lastProcessedIndex = 0;
  if (isUpdate) {
    const lastItem = await video_indexer.findOne({
      where: { playlist_url: playlistUrl },
      order: [["index_in_playlist", "DESC"]],
      attributes: ["index_in_playlist"],
      limit: 1
    });

    lastProcessedIndex = lastItem ? lastItem.index_in_playlist + 1 : 1;
    logger.debug("Found last processed index", { index: lastProcessedIndex });
  }

  // Check for existing items
  const existingItems = await Promise.all([
    // Check video_list table
    Promise.all(responseItems.map(async item => {
      const videoUrl = item.split("\t")[2];
      return await video_list.findOne({
        where: { video_url: videoUrl }
      });
    })),
    // Check video_indexer table
    Promise.all(responseItems.map(async item => {
      const videoUrl = item.split("\t")[2];
      return await video_indexer.findOne({
        where: {
          video_url: videoUrl,
          playlist_url: playlistUrl
        }
      });
    }))
  ]);

  const [existingVideos, existingIndexes] = existingItems;
  const allExist = existingVideos.every(v => v) && existingIndexes.every(i => i);

  if (allExist) {
    logger.debug("All videos already exist in database");
    result.shouldStopProcessing = true;
    result.count = existingIndexes.length;
    return result;
  }

  // Process items
  await Promise.all(responseItems.map(async (item, index) => {
    try {
      const [title, videoId, videoUrl, approxSize] = item.split("\t");

      // Prepare video data
      const videoData = {
        video_id: videoId.trim(),
        title: await stringSlicer(
          title === "NA" ? videoId.trim() : title,
          config.maxTitleLength
        ),
        approximate_size: approxSize === "NA" ? -1 : parseInt(approxSize),
        downloaded: false,
        available: !["[Deleted video]", "[Private video]", "[Unavailable video]"].includes(title)
      };

      // Update or create video record
      if (!existingVideos[index]) {
        await video_list.create({
          video_url: videoUrl,
          ...videoData
        });
      } else {
        await updateVideoMetadata(existingVideos[index], videoData);
      }

      // Create index record if needed
      if (!existingIndexes[index]) {
        await video_indexer.create({
          video_url: videoUrl,
          playlist_url: playlistUrl,
          index_in_playlist: startIndex + index + lastProcessedIndex
        });
      }

      result.count++;

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
 * @param {string} newData.video_id - Video ID
 * @param {number} newData.approximate_size - Approximate file size
 * @param {string} newData.title - Video title
 * @param {boolean} newData.available - Video availability status
 * @returns {Promise<void>} Resolves when update complete
 */
async function updateVideoMetadata(existingVideo, newData) {
  logger.trace("Checking video metadata for updates", {
    videoId: existingVideo.video_id,
    newData: newData
  });

  const differences = [];
  let requiresUpdate = false;

  // Check for differences
  if (existingVideo.video_id !== newData.video_id) {
    differences.push({
      field: 'video_id',
      old: existingVideo.video_id,
      new: newData.video_id
    });
    requiresUpdate = true;
  }

  if (+existingVideo.approximate_size !== +newData.approximate_size) {
    differences.push({
      field: 'approximate_size',
      old: existingVideo.approximate_size,
      new: newData.approximate_size
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

  if (existingVideo.available !== newData.available) {
    differences.push({
      field: 'available',
      old: existingVideo.available,
      new: newData.available
    });
    requiresUpdate = true;
  }

  // Perform update if needed
  if (requiresUpdate) {
    logger.warn("Video metadata changes detected", { differences });

    Object.assign(existingVideo, {
      video_id: newData.video_id,
      approximate_size: +newData.approximate_size,
      title: newData.title,
      available: newData.available
    });

    await existingVideo.save();
    logger.debug("Video metadata updated successfully");
  } else {
    logger.debug("No video metadata updates needed");
  }
}
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
async function processUrlList(requestBody, response) {
  try {
    // Validate required parameters
    if (!requestBody.url_list) {
      throw new Error("URL list is required");
    }

    // Extract and normalize parameters
    const startIndex = Math.max(1, +(requestBody.start ?? 1));
    const chunkSize = Math.max(config.chunkSize, +(requestBody.chunk_size ?? config.chunkSize));
    const endIndex = startIndex + chunkSize;
    const shouldSleep = requestBody.sleep ?? false;
    const monitoringType = requestBody.monitoring_type ?? "N/A";
    const lastProcessedIndex = startIndex > 0 ? startIndex - 1 : 0;

    logger.trace("Processing URL list", {
      urlCount: requestBody.url_list.length,
      startIndex,
      endIndex,
      chunkSize,
      shouldSleep,
      monitoringType
    });

    // Process each URL
    for (let urlIndex = 0; urlIndex < requestBody.url_list.length; urlIndex++) {
      const currentUrl = requestBody.url_list[urlIndex];
      logger.debug(`Processing URL ${urlIndex + 1}/${requestBody.url_list.length}`, { url: currentUrl });

      try {
        // Initialize processing for current URL
        const success = await initializeListProcessing(
          currentUrl,
          requestBody,
          urlIndex,
          response,
          shouldSleep,
          lastProcessedIndex,
          startIndex,
          endIndex,
          chunkSize,
          monitoringType
        );

        if (success) {
          logger.debug(`Successfully processed URL: ${currentUrl}`);
        } else {
          logger.warn(`Processing may have failed for URL: ${currentUrl}`);
        }

      } catch (error) {
        logger.error("Error processing URL", {
          url: currentUrl,
          index: urlIndex,
          error: error.message
        });

        // Send error response only for first URL
        if (urlIndex === 0) {
          const status = error.status || 500;
          response.writeHead(status, generateCorsHeaders(MIME_TYPES[".json"]));
          response.end(JSON.stringify({ error: he.escape(error.message) }));
        }

        // Notify frontend of failure
        sock.emit("listing-failed", {
          error: error.message,
          url: currentUrl === "None" ? requestBody.url_list[urlIndex] : currentUrl
        });
      }
    }

    logger.debug("Completed processing all URLs");

  } catch (error) {
    logger.error("Failed to process URL list", {
      error: error.message,
      stack: error.stack
    });
  }
}
/**
 * Initializes playlist/video processing and handles indexing
 * 
 * @param {string} currentUrl - URL to process
 * @param {Object} requestBody - Request body containing parameters
 * @param {number} urlIndex - Current index in URL list
 * @param {Object} response - HTTP response object
 * @param {boolean} shouldSleep - Whether to sleep before processing
 * @param {number} lastProcessedIndex - Index of last processed item
 * @param {number} startIndex - Start index for processing
 * @param {number} endIndex - End index for processing 
 * @param {number} batchSize - Size of batches to process
 * @param {string} monitoringType - Type of monitoring
 * @returns {Promise<boolean>} Promise resolving to true if successful
 */
function initializeListProcessing(currentUrl, requestBody, urlIndex, response, shouldSleep, lastProcessedIndex, startIndex, endIndex, batchSize, monitoringType) {
  let playlistIndex = -1;
  let isAlreadyIndexed = false;

  logger.trace(`initializeListProcessing: url: ${currentUrl}, index: ${urlIndex}, startIndex: ${startIndex}, endIndex: ${endIndex}, batchSize: ${batchSize}, monitoringType: ${monitoringType}`);

  return new Promise(async (resolve, reject) => {
    try {
      // Fix URL format and get initial response
      currentUrl = fixCommonErrors(currentUrl);
      if (shouldSleep) await sleep();
      const responseItems = await fetchVideoInformation(currentUrl, startIndex, endIndex);

      // Validate response
      if (responseItems.length === 0) {
        return reject(new Error("Empty response list"));
      }

      // Check if URL is playlist or single video
      const isPlaylist = responseItems.length > 1 || playlistRegex.test(currentUrl);

      if (isPlaylist) {
        // Handle playlist case
        try {
          // Look for existing playlist
          const existingPlaylist = await playlist_list.findOne({
            where: { playlist_url: currentUrl }
          });

          if (existingPlaylist) {
            // Use existing playlist data
            isAlreadyIndexed = true;
            playlistIndex = existingPlaylist.playlist_index;
            lastProcessedIndex = lastProcessedIndex;
          } else {
            // Create new playlist entry
            await addPlaylist(currentUrl, monitoringType);
            const newPlaylist = await playlist_list.findOne({
              order: [["createdAt", "DESC"]]
            });

            if (!newPlaylist) {
              throw new Error("Failed to create playlist");
            }

            await sleep();
            playlistIndex = newPlaylist.playlist_index;
          }
        } catch (error) {
          return reject(error);
        }
      } else {
        // Handle single video case
        try {
          currentUrl = "None"; // Mark as unlisted
          const videoUrl = responseItems[0].split("\t")[2];

          // Check for existing unlisted video
          const existingVideo = await video_indexer.findOne({
            where: {
              video_url: videoUrl,
              playlist_url: currentUrl
            }
          });

          if (existingVideo) {
            // Return existing video data
            if (urlIndex === 0) {
              response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
              response.end(JSON.stringify({
                message: "Video already saved as unlisted",
                count: 1,
                resp_url: currentUrl,
                start: existingVideo.index_in_playlist
              }));
            }
            sock.emit("listing-done", {
              message: "done processing for a single video",
              url: currentUrl === "None" ? requestBody["url_list"][urlIndex] : currentUrl
            });
            return resolve(true);
          }

          // Get next index for new unlisted video
          const lastUnlistedVideo = await video_indexer.findOne({
            where: { playlist_url: currentUrl },
            order: [["index_in_playlist", "DESC"]],
            attributes: ["index_in_playlist"],
            limit: 1
          });

          lastProcessedIndex = lastUnlistedVideo ? lastUnlistedVideo.index_in_playlist : 0;
        } catch (error) {
          logger.error(error.message);
          return reject(error);
        }
      }

      // Process response and update frontend
      const processingResult = await processVideoInformation(responseItems, currentUrl, lastProcessedIndex, false);
      processingResult.prevPlaylistIndex = playlistIndex + 1;
      processingResult.isAlreadyIndexed = isAlreadyIndexed;

      if (urlIndex === 0) {
        response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
        response.end(JSON.stringify(processingResult));
      }

      // Process remaining items in background
      await processPlaylistBackground(currentUrl, startIndex, endIndex, batchSize, true);

      logger.trace(`Done processing playlist: ${currentUrl}`);
      sock.emit("listing-done", {
        message: "done processing playlist entry",
        url: currentUrl === "None" ? requestBody["url_list"][urlIndex] : currentUrl
      });

      resolve(true);

    } catch (error) {
      reject(error);
    }
  });
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
    const playlist = await playlist_list.findOne({
      where: { playlist_url: playlistUrl }
    });

    if (!playlist) {
      throw new Error("Playlist not found");
    }

    // Update monitoring type
    await playlist.update(
      { monitoring_type: monitoringType },
      { silent: true }
    );

    logger.debug("Successfully updated monitoring type", {
      playlistUrl,
      oldType: playlist.monitoring_type,
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
 * Asynchronously processes playlist items in the background in chunks
 *
 * @param {string} playlistUrl - The URL of the playlist to process
 * @param {number} startIndex - Starting index for processing items
 * @param {number} endIndex - Ending index for processing items  
 * @param {number} chunkSize - Size of chunks to process at a time
 * @param {boolean} isUpdateOperation - Whether this is an update of existing items
 * @returns {Promise<void>} Resolves when background processing is complete
 */
async function processPlaylistBackground(
  playlistUrl,
  startIndex,
  endIndex,
  chunkSize,
  isUpdateOperation
) {
  let processedChunks = 0;

  while (playlistUrl !== "None") {
    // Calculate indices for next chunk
    const nextStartIndex = startIndex + chunkSize;
    const nextEndIndex = endIndex + chunkSize;

    logger.trace(
      `Processing playlist chunk:`, {
      url: playlistUrl,
      chunkSize: chunkSize,
      startIndex: nextStartIndex,
      endIndex: nextEndIndex,
      iteration: processedChunks
    }
    );

    // Get playlist items for this chunk
    const responseItems = await fetchVideoInformation(playlistUrl, nextStartIndex, nextEndIndex);

    // Exit if no more items
    if (responseItems.length === 0) {
      logger.trace(
        `Finished processing playlist - no more items found`, {
        lastStartIndex: nextStartIndex,
        lastEndIndex: nextEndIndex,
        totalChunks: processedChunks
      }
      );
      break;
    }

    // Process the chunk items
    // Note: yt-dlp starts counting from 1, so subtract 1 from index
    const { shouldStopProcessing } = await processVideoInformation(
      responseItems,
      playlistUrl,
      nextStartIndex - 1,
      isUpdateOperation
    );

    // Exit if processing should stop
    if (shouldStopProcessing) {
      logger.trace(
        `Stopping playlist processing early`, {
        lastStartIndex: nextStartIndex,
        lastEndIndex: nextEndIndex,
        totalChunks: processedChunks
      }
      );
      break;
    }

    // Update indices for next iteration
    startIndex = nextStartIndex;
    endIndex = nextEndIndex;
    processedChunks++;
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
  const lastPlaylist = await playlist_list.findOne({
    order: [["playlist_index", "DESC"]],
    attributes: ["playlist_index"],
    limit: 1
  });

  if (lastPlaylist !== null) {
    nextPlaylistIndex = lastPlaylist.playlist_index + 1;
  }

  // Check if we've hit the process limit
  if (listProcesses.size >= config.queue.maxListings) {
    logger.info("Maximum listing processes reached", { url: playlistUrl });
    throw new Error("Maximum listing processes reached");
  }

  // Spawn process to get playlist title
  const titleProcess = spawn("yt-dlp", [
    "--playlist-end", "1",
    "--flat-playlist",
    "--print", "%(playlist_title)s",
    playlistUrl
  ]);

  // Track the process
  const processEntry = {
    spawnType: "list",
    spawnedProcess: titleProcess,
    lastActivity: Date.now(),
    spawnStatus: "running"
  };
  listProcesses.set(titleProcess.pid.toString(), processEntry);

  return new Promise((resolve, reject) => {
    // Handle stdout
    titleProcess.stdout.setEncoding("utf8");
    titleProcess.stdout.on("data", data => {
      playlistTitle += data;
      const processCache = listProcesses.get(titleProcess.pid.toString());
      if (processCache) {
        processCache.lastActivity = Date.now();
      }
    });

    // Handle stderr
    titleProcess.stderr.setEncoding("utf8");
    titleProcess.stderr.on("data", data => {
      logger.error(`Error getting playlist title: ${data}`);
      const processCache = listProcesses.get(titleProcess.pid.toString());
      if (processCache) {
        processCache.lastActivity = Date.now();
      }
    });

    // Handle process errors
    titleProcess.on("error", error => {
      logger.error(`Title process error: ${error.message}`);
      const processCache = listProcesses.get(titleProcess.pid.toString());
      if (processCache) {
        processCache.spawnStatus = "failed";
      }
      reject(error);
    });

    // Handle process completion
    titleProcess.on("close", async code => {
      try {
        const processCache = listProcesses.get(titleProcess.pid.toString());

        if (code !== 0) {
          logger.error(`Title process failed with code: ${code}`);
          if (processCache) {
            processCache.spawnStatus = "failed";
          }
          throw new Error("Failed to get playlist title");
        }

        // Handle empty or NA title
        if (playlistTitle.trim() === "NA") {
          try {
            playlistTitle = await urlToTitle(playlistUrl);
          } catch (error) {
            logger.error(`Failed to get title from URL: ${error.message}`);
            playlistTitle = playlistUrl;
          }
        }

        // Trim title to max length
        playlistTitle = stringSlicer(playlistTitle, config.maxTitleLength);
        logger.debug(`Creating playlist with title: ${playlistTitle}`, {
          url: playlistUrl,
          pid: titleProcess.pid
        });

        // Create playlist entry
        const [playlist, created] = await playlist_list.findOrCreate({
          where: { playlist_url: playlistUrl },
          defaults: {
            title: playlistTitle.trim(),
            monitoring_type: monitoringType,
            save_dir: playlistTitle.trim(),
            playlist_index: nextPlaylistIndex
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
      } finally {
        // Clean up process tracking
        if (listProcesses.has(titleProcess.pid.toString())) {
          const removed = listProcesses.delete(titleProcess.pid.toString());
          logger.debug(`Process removed from queue: ${removed}`, {
            pid: titleProcess.pid
          });
        }
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
 * @param {number} [requestBody.sort=1] - Sort column (1: playlist_index, 3: updatedAt)  
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
    const sortBy = sortColumn === 3 ? "updatedAt" : "playlist_index";

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
        playlist_index: {
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
    const results = await playlist_list.findAndCountAll(queryOptions);

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
      ? [video_list, "downloaded", "DESC"]
      : ["index_in_playlist", "ASC"];

    logger.trace("Fetching playlist videos", {
      startIndex,
      endIndex,
      searchQuery,
      sortBy: sortByDownloaded ? "downloaded" : "index_in_playlist",
      sortDirection: sortByDownloaded ? "DESC" : "ASC",
      playlistUrl
    });

    // Build base query options
    const queryOptions = {
      attributes: ["index_in_playlist", "playlist_url"],
      include: [{
        attributes: [
          "title",
          "video_id",
          "video_url",
          "downloaded",
          "available"
        ],
        model: video_list,
        ...(searchQuery && {
          where: {
            title: { [Op.iLike]: `%${searchQuery}%` }
          }
        })
      }],
      where: { playlist_url: playlistUrl },
      limit: endIndex - startIndex,
      offset: startIndex,
      order: [sortOrder]
    };

    // Execute query
    const results = await video_indexer.findAndCountAll(queryOptions);

    // Send response
    response.writeHead(200, generateCorsHeaders(MIME_TYPES[".json"]));
    response.end(JSON.stringify(results));

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
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets = makeAssets(filesList);
let serverOptions = {};

if (config.nativeHttps) {
  try {
    serverOptions = {
      key: fs.readFileSync(config.ssl.key, "utf8"),
      cert: fs.readFileSync(config.ssl.cert, "utf8"),
      ...(config.ssl.passphrase && { passphrase: config.ssl.passphrase })
    };
  } catch (error) {
    logger.error("Error reading SSL certificate files:", error);
    process.exit(1);
  }
}

const server = http.createServer(serverOptions, (req, res) => {
  if (req.url.startsWith(config.urlBase) && req.method === "GET") {
    try {
      const get = req.url;
      const reqEncoding = req.headers["accept-encoding"] || "";
      const resHeaders = generateCorsHeaders(staticAssets[get].type);
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
    authenticateRequest(req, res, processUrlList);
  } else if (req.url === config.urlBase + "/download" && req.method === "POST") {
    authenticateRequest(req, res, processDownloadRequest);
  } else if (req.url === config.urlBase + "/watch" && req.method === "POST") {
    authenticateRequest(req, res, updatePlaylistMonitoring);
  } else if (req.url === config.urlBase + "/getplay" && req.method === "POST") {
    authenticateRequest(req, res, getPlaylistsForDisplay);
  } else if (req.url === config.urlBase + "/getsub" && req.method === "POST") {
    authenticateRequest(req, res, getPlaylistVideos);
  }
  else if (req.url === config.urlBase + "/register" && req.method === "POST") {
    rateLimit(req, res, registerUser, (req, res, next) => next(req, res),
      config.cache.reqPerIP, config.cache.maxAge);
  }
  else if (req.url === config.urlBase + "/login" && req.method === "POST") {
    rateLimit(req, res, authenticateUser, (req, res, next) => next(req, res),
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
