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
        maxAge: +process.env.CACHE_MAX_AGE || 3600,
        reqPerIP: +process.env.MAX_REQUESTS_PER_IP || 10
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
    secretKey: process.env.SECRET_KEY_FILE
        ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
        : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
            ? process.env.SECRET_KEY.trim()
            : new Error("SECRET_KEY or SECRET_KEY_FILE environment variable must be set"),
    notNeeded: ["", "pornstar", "model", "videos"],
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
    }
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
const cacheOptionsGenerator = (size) => ({
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
        const value_string = JSON.stringify(value);
        logger.debug(`Calculating size of cache item with key: ${key}`,
            { key: key, value: value_string, size: value_string.length });
        return value_string.length; // Size in bytes
    },
    maxSize: size, // Maximum total size of all cache items in bytes
    /**
     * Clear sensitive data when an item is removed.
     *
     * @param {string} key - The key associated with the value to be disposed of.
     * @param {any} value - The value to be disposed of.
     * @param {string} reason - The reason for disposing of the value.
     */
    dispose: (key, value, reason) => {
        // Clear sensitive data when an item is removed
        logger.debug(`Disposing cache item with key: ${key}`,
            { key: key, value: value, reason: reason }
        );
        value = null;
    },
});

const userCache = new LRUCache(cacheOptionsGenerator(1000));
const ipCache = new LRUCache(cacheOptionsGenerator(1000));

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
 * logger.debug('This is a debug message');
 * logger.verbose('This is a verbose message');
 * logger.info('This is an info message');
 * logger.warn('This is a warning message');
 * logger.error('This is an error message');
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
            { tables: [video_list.name, playlist_list.name, video_indexer.name] }
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
                { playlist: unlistedPlaylist.name }
            );
        }
        // Making a default user
        const userName = "admin";
        const defaultUser = await users.findOne({ where: { user_name: userName } });
        if (defaultUser === null) {
            logger.debug("Creating default user");
            const generatedPassword = generatePassword();
            const [salt, password] = await hashPassword(generatedPassword);
            users.create({ user_name: userName, salt: salt, password: password });
            logger.info(
                "Default user created successfully",
                { user_name: userName, password: generatedPassword }
            );
        } else {
            logger.debug("Default user already exists",
                { user_name: userName }
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
                time_zone: config.timeZone
            }
        );
    },
    null,
    true,
    config.timeZone
);

// Make sure the save location exists
if (!fs.existsSync(config.saveLocation)) {
    logger.info("Ensuring save location exists", { save_location: config.saveLocation });
    fs.mkdirSync(config.saveLocation, { recursive: true });
}

// Utility functions
/**
 * Generates a random password.
 *
 * @return {string} A 16 character long password.
 */
function generatePassword() {
    const password = generator.generate({
        length: 16,
        numbers: true,
        lowercase: true,
        uppercase: true,
        symbols: true,
        strict: true
    });
    return password;
}
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
async function stringSlicer(str, len) {
    if (str.length > len) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        return decoder.decode(encoder.encode(str.slice(0, len)));
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
            .filter((item) => !not_needed.includes(item))
            .join("");
    } catch (error) {
        logger.error(`${error.message}`);
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
 * Spawns a child process to run the `yt-dlp` command with the given parameters and returns a promise that resolves with the response.
 *
 * @param {string} bodyUrl - The URL of the playlist to download.
 * @param {number} start_num - The starting index of the playlist to download.
 * @param {number} stop_num - The ending index of the playlist to download.
 * @return {Promise<string[]>} A promise that resolves with an array of strings representing the response from `yt-dlp`.
 */
async function listSpawner(bodyUrl, start_num, stop_num) {
    logger.trace(
        `listSpawner called`,
        { url: bodyUrl, start: start_num, stop: stop_num }
    );
    return new Promise((resolve, reject) => {
        const ytList = spawn("yt-dlp", [
            "--playlist-start",
            start_num,
            "--playlist-end",
            stop_num,
            "--flat-playlist",
            "--print",
            "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s",
            bodyUrl,
        ]);
        let response = "";
        ytList.stdout.setEncoding("utf8");
        ytList.stdout.on("data", (data) => {
            response += data;
        });
        ytList.stderr.setEncoding("utf8");
        ytList.stderr.on("data", (data) => {
            // maybe use sockets to send the stderr to the
            logger.error(`stderr: ${data}`);
        });
        ytList.on("error", (error) => {
            logger.error(`${error.message}`);
        });
        ytList.on("close", (code) => {
            if (code !== 0) {
                logger.error(`yt-dlp returned code: ${code}`);
            }
            resolve(response.split("\n").filter((line) => line.length > 0));
        });
    });
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
async function processResponse(
    response,
    bodyUrl,
    index,
    isUpdateOperation
) {
    logger.trace(
        `processResponse called`,
        { url: bodyUrl, start: index, update: isUpdateOperation }
    );
    const init_resp = {
        count: 0,
        resp_url: bodyUrl,
        start: index,
        quit_listing: false,
    };
    sock.emit("listing-or-downloading", { percentage: 101 });
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
        init_resp["quit_listing"] = true;
        init_resp["count"] = allItemsExistInVideoIndexer.length;
        return init_resp; // Return early if all items exist
    } else {
        logger.debug(`Videos per list index exist in video_list: ${JSON.stringify(
            allItemsExistInVideoList
        )}`)
        logger.debug(`Videos per list index exist in video_indexer: ${JSON.stringify(
            allItemsExistInVideoIndexer
        )}`);
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
                const title_processed = await stringSlicer(title === "NA" ? vid_id.trim() : title, MAX_LENGTH);
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
                init_resp["count"]++;
            }
        })
    );
    return init_resp;
}
/**
 * Updates a video entry in the database.
 *
 * @param {Object} found - The found video object.
 * @param {Object} data - The data to update the video with.
 * @return {Promise<void>} - A promise that resolves when the video entry is updated.
 */
async function updateVideoEntry(found, data) {
    // The object was found and not created
    // Does not change the downloaded state
    // I have a sneaking suspicion that this
    // will fail when there is any real change
    // in the video, lets see when that happens
    logger.trace(`updateVideoEntry called`,
        { found: found, data: data }
    );
    // trace added here as an exception to check if this ever gets invoked or is just redundant
    if (
        found.video_id !== data.video_id ||
        +found.approximate_size !== +data.approximate_size ||
        found.title !== data.title ||
        found.available !== data.available
    ) {
        const differences = [];
        if (found.id !== data.id) {
            differences.push(`id: ${found.id} (found) vs. ${data.id} (expected)`);
        }
        if (+found.approximate_size !== +data.approximate_size) {
            differences.push(
                `approximate_size: ${found.approximate_size} (found) vs. ${data.approximate_size} (expected)`
            );
        }
        if (found.title !== data.title) {
            differences.push(
                `title: ${found.title} (found) vs. ${data.title} (expected)`
            );
        }
        if (found.available !== data.available) {
            differences.push(
                `available: ${found.available} (found) vs. ${data.available} (expected)`
            );
        }
        logger.warn(
            `Found ${differences.length} difference(s)`, {
            differences: differences,
        }
        );
        found.id = data.id;
        found.approximate_size = +data.approximate_size;
        found.title = data.title;
        found.available = data.available;
        await found.save();
    } else if (found.downloaded !== data.downloaded) {
        logger.debug("This property does not need modification", {
            found: found.downloaded,
            data: data.downloaded,
        });
    }
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
 * Asynchronously hashes the given password using bcrypt.
 *
 * @param {string} password - The password to be hashed
 * @return {Promise<Array>} A promise that resolves to an array containing the salt and hash
 */
async function hashPassword(password) {
    try {
        const salt = await bcrypt.genSalt(salt_rounds);
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
    const body = await extractJson(req),
        user_name = body["user_name"],
        body_password = body["password"];
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
        secretKey, { expiresIn: expiry_time }
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
        const foundUser = await users.findOne({
            where: { user_name: user_name },
        });
        if (foundUser === null) {
            logger.verbose(`Issuing token for user ${user_name} failed`);
            res.writeHead(404, corsHeaders(config.types[".json"]));
            res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
        } else {
            const passwordMatch = await bcrypt.compare(body_password, foundUser.password);
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
            await list_background(
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
            await list_background(
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
        const download_list = [],
            in_download_list = new Set(),
            // remember to send this from the frontend
            play_list_url = body["playListUrl"] !== undefined ? body["playListUrl"] : "None";
        for (const url_item of body["urlList"]) {
            if (!in_download_list.has(url_item)) {
                logger.debug(`checking for ${url_item} in db`);
                const video_item = await video_list.findOne({
                    where: { video_url: url_item },
                });
                let save_dir = "";
                try {
                    const save_dir_const = await playlist_list.findOne({
                        where: { playlist_url: play_list_url },
                    });
                    save_dir = save_dir_const.save_dir;
                } catch (error) {
                    if (save_dir !== "") {
                        save_dir = "";
                        logger.error(`${error.message}`);
                    }
                }
                download_list.push([
                    url_item,
                    video_item.title,
                    save_dir,
                    video_item.video_id
                ]);
                in_download_list.add(url_item);
            }
        }
        download_sequential(download_list);
        res.writeHead(200, corsHeaders(config.types[".json"]));
        // This doesn't need escaping as it's consumed interanlly
        res.end(JSON.stringify({ Downloading: download_list }));
    } catch (error) {
        logger.error(`${error.message}`);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(config.types[".json"]));
        res.end(JSON.stringify({ error: he.escape(error.message) }));
    }
}
// Add a parallel downloader someday
/**
 * Downloads the given items sequentially.
 *
 * @param {Array} items - array of items to be downloaded
 * @return {Promise} a promise that resolves when all the items have been downloaded
 */
async function download_sequential(items) {
    logger.trace(`Downloading ${items.length} videos sequentially`);
    let count = 1;
    for (const [url_str, title, save_dir, video_id] of items) {
        try {
            // yeah, this needs a join too from the playlists now to get the save directory and stuff
            logger.trace(`Downloading Video: ${count++}, Url: ${url_str}`);
            let hold = null;
            // Find a way to check and update it in the db if it is not correct
            let realFileName = null;
            // check if the trim is actually necessary
            const save_path = path_fs.join(save_location, save_dir.trim());
            logger.debug(`Downloading to path: ${save_path}`);
            // if save_dir == "",  then save_path == save_location
            if (save_path != save_location && !fs.existsSync(save_path)) {
                fs.mkdirSync(save_path, { recursive: true });
            }
            sock.emit("download-start", { message: "" });
            // logger.verbose(`executing: yt-dlp ${options.join(" ")} ${save_path} ${url_str}`);
            const yt_dlp = spawn("yt-dlp", options.concat([save_path, url_str]));
            yt_dlp.stdout.setEncoding("utf8");
            yt_dlp.stdout.on("data", async (data) => {
                try {
                    const dataStr = data.toString().trim(); // Convert buffer to string once
                    // logger.trace(dataStr);
                    // Percentage extraction
                    const percentageMatch = /(\d{1,3}\.\d)/.exec(dataStr);
                    if (percentageMatch !== null) {
                        const percentage = parseFloat(percentageMatch[0]);
                        const percentageDiv10 = Math.floor(percentage / 10);
                        if (percentageDiv10 === 0 && hold === null) {
                            hold = 0;
                            logger.trace(dataStr);
                        } else if (percentageDiv10 > hold) {
                            hold = percentageDiv10;
                            logger.trace(dataStr);
                        }
                        // Send percentage to the frontend
                        sock.emit("listing-or-downloading", { percentage: percentage });
                    }
                    // Filename extraction, now it can handle if multiple lines
                    //  are received from stdout in a single on event
                    const fileNameMatch = /Destination: (.+)/m.exec(dataStr);
                    if (fileNameMatch && fileNameMatch[1] && realFileName === null) {
                        realFileName = fileNameMatch[1]
                            .replace(path_fs.extname(fileNameMatch[1]), "")
                            .replace(save_path + "/", "").trim();
                        logger.debug(`extracted filename: ${realFileName}, filename from db: ${title}`);
                    }
                } catch (error) {
                    // logger.error(`${data} : ${error.message}`);
                    // this is done so that the toasts do not go crazy
                    if (!error instanceof TypeError) {
                        sock.emit("error", { message: `${error}` });
                    }
                }
            });
            yt_dlp.stderr.setEncoding("utf8");
            yt_dlp.stderr.on("data", (data) => {
                logger.error(`stderr: ${data}`);
            });
            yt_dlp.on("error", (error) => {
                logger.error(`${error.message}`);
            });
            yt_dlp.on("close", async (code) => {
                const entity = await video_list.findOne({
                    where: { video_url: url_str },
                });
                if (code === 0) {
                    const entityProp = {
                        downloaded: true,
                        available: true,
                        title: (title === video_id || title === "NA") ? (realFileName || title) : title
                    };
                    logger.debug(`Update data: ${JSON.stringify(entityProp)}`);
                    entity.set(entityProp);
                    await entity.save();
                    const titleForFrontend = entityProp.title;
                    sock.emit("download-done", {
                        message: titleForFrontend,
                        url: url_str,
                        title: titleForFrontend
                    });
                } else {
                    sock.emit("download-failed", {
                        message: `${entity.title}`,
                        url: url_str,
                    });
                }
            });
            // this holds the for loop, preventing the next iteration from happening
            await new Promise((resolve) => yt_dlp.on("close", resolve));
            logger.trace(`Downloaded ${title} at location ${save_path}`);
        } catch (error) {
            logger.error(`${error.message}`);
        }
    }
}
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
        const start_num = body["start"] !== undefined ?
            +body["start"] === 0 ? 1 : +body["start"] : 1, chunk_size = +body["chunk_size"] >= +config.chunkSize ? +body["chunk_size"] : +config.chunkSize, stop_num = +chunk_size + 1, sleep_before_listing = body["sleep"] !== undefined ? body["sleep"] : false, monitoring_type = body["monitoring_type"] !== undefined ? body["monitoring_type"] : "N/A";
        let index = 0;
        //logger.verbose(`body: ${JSON.stringify(body)}`);
        //logger.verbose(`start_num: ${start_num}, stop_num: ${stop_num}, chunk_size: ${chunk_size}, sleep_before_listing: ${sleep_before_listing}, monitoring_type: ${monitoring_type}`);

        if (body["url_list"] === undefined) {
            throw new Error("url list is required");
        }
        let url_list = body["url_list"], last_item_index = start_num > 0 ? start_num - 1 : 0; // index must start from 0 so start_num needs to subtracted by 1

        //debug(`payload: ${JSON.stringify(body)}`);
        logger.trace(
            `listFunc:  url_list: ${url_list}, start_num: ${start_num}, index: ${last_item_index}, ` +
            `stop_num: ${stop_num}, chunk_size: ${chunk_size}, ` +
            `sleep_before_listing: ${sleep_before_listing}, monitoring_type: ${monitoring_type}`
        );
        // TODO: Convert this to a synchronous function, ie use promises,
        // return a dummy response to res and then wait for the promise to resolve
        // one by one, then send the updates to the frontend using sock.emit("playlist-done")
        // make sure the emits are giving the correct data (ie: url, index) to the frontend
        try {
            // so this didn't work, need to figure out how to make it send requests one by one
            // let index = 0;
            for (const current_url of url_list) {
                //url_list.map(async (current_url, index) => {
                logger.debug(`current_url: ${current_url}, index: ${index}`);
                try {
                    const done = await list_init(current_url, body, index, res, sleep_before_listing, last_item_index, start_num, stop_num, chunk_size, monitoring_type);
                    if (done) {
                        logger.debug(`processed current_url: ${current_url}, index: ${index}`);
                    } else if (done instanceof Error) {
                        logger.error(`listFunc processing error: ${done.message}`);
                    } else {
                        logger.debug(`done: ${done}, current_url: ${current_url}, index: ${index}`);
                    }
                } catch (error) {
                    logger.error(`listFunc processing error: ${error.message}`);
                }
                index += 1;
                //});
            }
            logger.debug("List processing done");
        } catch (error) {
            logger.error(`${error.message}`);
            const status = error.status || 500;
            if (index === 0) {
                res.writeHead(status, corsHeaders(config.types[".json"]));
                res.end(JSON.stringify({ error: he.escape(error.message) }));
            }
            sock.emit("playlist-done", {
                message: "done processing playlist or channel",
                id: current_url === "None" ? body["url_list"][index] : current_url,
            });
        }
    } catch (error) {
        logger.error(`${error.message}`);
        //const status = error.status || 500;
        //res.writeHead(status, corsHeaders(config.types[".json"]));
        //res.end(JSON.stringify({ error: he.escape(error.message) }));
    }
}
/**
 * Initializes the list processing for a given URL.
 *
 * @param {string} current_url - The URL to process.
 * @param {Object} body - The request body.
 * @param {number} index - The index of the URL in the list.
 * @param {Object} res - The response object.
 * @param {boolean} sleep_before_listing - Whether to sleep before listing.
 * @param {number} last_item_index - The index of the last item processed.
 * @param {number} start_num - The start number.
 * @param {number} stop_num - The stop number.
 * @param {number} chunk_size - The chunk size.
 * @param {string} monitoring_type - The monitoring type.
 * @return {Promise} A promise that resolves when the list processing is complete.
 */
function list_init(current_url, body, index, res, sleep_before_listing, last_item_index, start_num, stop_num, chunk_size, monitoring_type) {
    let play_list_index = -1, already_indexed = false;
    logger.trace(`list_init: url: ${current_url}, index: ${index}, start_num: ${start_num}, stop_num: ${stop_num}, chunk_size: ${chunk_size}, monitoring_type: ${monitoring_type}`);
    //try {
    return new Promise(async (resolve, reject) => {
        logger.trace("Processing url: " + current_url);
        current_url = fixCommonErrors(current_url);
        if (sleep_before_listing) { await sleep(); }
        const response_list = await listSpawner(current_url, start_num, stop_num);
        logger.debug(`response_list: ${JSON.stringify(response_list)}, response_list.length: ${response_list.length}`);
        // Checking if the response qualifies as a playlist
        if (response_list.length === 0) {
            reject(new Error("response_list.length is 0"));
        }
        const play_list_exists = new Promise(async (resolve, reject) => {
            if (response_list.length > 1 || playlistRegex.test(current_url)) {
                const is_already_indexed = await playlist_list.findOne({
                    where: { playlist_url: current_url },
                });
                try {
                    logger.trace(
                        `Playlist: ${is_already_indexed.title.trim()} is indexed at ${is_already_indexed.playlist_index}`
                    );
                    already_indexed = true;
                    // Now that this is obtained setting the playlist index in front end is do able only need to figure out how
                    play_list_index = is_already_indexed.playlist_index;
                    // Resolve the promise with the last item index
                    resolve(last_item_index);
                } catch (error) {
                    logger.warn(
                        "playlist or channel not encountered earlier, saving in database"
                    );
                    // Its not an error, but the title extraction,
                    // will only be done once the error is raised
                    // then is used to find the index of the previous playlist
                    await add_playlist(current_url, monitoring_type)
                        .then(() => playlist_list.findOne({
                            order: [["createdAt", "DESC"]],
                        })
                        )
                        .then(async (playlist) => {
                            if (playlist) {
                                await sleep();
                                play_list_index = playlist.playlist_index;
                                logger.trace(
                                    `Playlist: ${playlist.title} is indexed at ${playlist.playlist_index}`
                                );
                                // Resolve the promise with the last item index
                                resolve(last_item_index);
                            } else {
                                throw new Error("Playlist not found");
                            }
                        })
                        .catch((error) => {
                            logger.error("Error occurred:", error);
                        });
                }
            } else {
                // This is an unlisted video, since the response does not qualify as a playlist
                try {
                    current_url = "None";
                    // If the url is determined to be an unlisted video
                    // (i.e: not belonging to a playlist)
                    // then the last unlisted video index is used to increment over.
                    const video_already_unlisted = await video_indexer.findOne({
                        where: {
                            video_url: response_list[0].split("\t")[2],
                            playlist_url: current_url,
                        },
                    });
                    logger.debug("unlisted video entry found: " +
                        JSON.stringify(video_already_unlisted)
                    );
                    if (video_already_unlisted !== null) {
                        logger.debug("Video already saved as unlisted");
                        reject(video_already_unlisted);
                    } else {
                        logger.debug("Adding a new video to the unlisted videos list");
                        const last_item = await video_indexer.findOne({
                            where: {
                                playlist_url: current_url,
                            },
                            order: [["index_in_playlist", "DESC"]],
                            attributes: ["index_in_playlist"],
                            limit: 1,
                        });
                        //debug(JSON.stringify(last_item));
                        try {
                            last_item_index = last_item.index_in_playlist;
                        } catch (error) {
                            // encountered an error if unlisted videos was not initialized
                            last_item_index = 0;
                        }
                        resolve(last_item_index + 1);
                    }
                } catch (error) {
                    logger.error(`${error.message}`);
                    const status = error.status || 500;
                    if (index === 0) {
                        res.writeHead(status, corsHeaders(config.types[".json"]));
                        res.end(JSON.stringify({ error: he.escape(error.message) }));
                    }
                    sock.emit("playlist-done", {
                        message: "done processing playlist or channel",
                        id: current_url === "None" ? body["url_list"][index] : current_url,
                    });
                }
            }
        });
        await play_list_exists.then(
            (last_item_index) => {
                // logger.debug("last_item_index: " + last_item_index);
                processResponse(response_list, current_url, last_item_index, false)
                    .then((init_resp) => {
                        try {
                            init_resp["prev_playlist_index"] = play_list_index + 1;
                            init_resp["already_indexed"] = already_indexed;
                            if (index === 0) {
                                res.writeHead(200, corsHeaders(config.types[".json"]));
                                res.end(JSON.stringify(init_resp));
                            }
                            resolve(true)
                        } catch (error) {
                            logger.error(`${error.message}`);
                            reject(error);
                        }
                    })
                    .then(() => {
                        list_background(
                            current_url,
                            start_num,
                            stop_num,
                            chunk_size,
                            true
                        ).then(() => {
                            logger.trace(`Done processing playlist: ${current_url}`);
                            sock.emit("playlist-done", {
                                message: "done processing playlist or channel",
                                id: current_url === "None" ? body["url_list"][index] : current_url,
                            });
                        });
                    });
            },
            (video_already_unlisted) => {
                logger.trace("Video already saved as unlisted");
                try {
                    if (index === 0) {
                        res.writeHead(200, corsHeaders(config.types[".json"]));
                        res.end(
                            JSON.stringify({
                                message: "Video already saved as unlisted",
                                count: 1,
                                resp_url: current_url,
                                start: video_already_unlisted.index_in_playlist,
                            })
                        );
                    }
                    sock.emit("playlist-done", {
                        message: "done processing playlist or channel",
                        id: current_url === "None" ? body["url_list"][index] : current_url,
                    });
                    resolve(true);
                } catch (error) {
                    logger.error(`${error.message}`);
                    reject(error);
                }
            }
        );
    })
    // } catch (error) {
    //   logger.trace(`Error in list_init: ${error.message}`);
    //   return new Promise((_, reject) => {
    //     // Not really sure what to do here
    //     reject(error);
    //   })
    // }
}
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
/**
 * Asynchronously performs a background listing operation.
 *
 * @param {string} bodyUrl - The URL of the playlist.
 * @param {number} start_num - The starting index of the playlist.
 * @param {number} stop_num - The ending index of the playlist.
 * @param {number} chunk_size - The size of each chunk to process.
 * @param {boolean} isUpdateOperation - Indicates if the operation is an update.
 * @return {undefined}
 */
async function list_background(
    bodyUrl,
    start_num,
    stop_num,
    chunk_size,
    isUpdateOperation
) {
    // yes a playlist on youtube atleast can only be 5000 long  && stop_num < 5000
    // let max_size = 5000;
    // let loop_num = max_size / chunk_size;
    let count = 0;
    while (bodyUrl != "None") {
        start_num = start_num + chunk_size;
        stop_num = stop_num + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        logger.trace(
            `list_background: URL: ${bodyUrl}, Chunk: ${chunk_size},` +
            `Start: ${start_num}, Stop: ${stop_num}, Iteration: ${count}`
        );
        //await sleep();
        const response = await listSpawner(bodyUrl, start_num, stop_num);
        if (response.length === 0) {
            logger.trace(
                `Listing exited at Start: ${start_num}, Stop: ${stop_num}, Iteration ${count}`
            );
            break;
        }
        // yt-dlp starts counting from 1 for some reason so 1 needs to be subtracted here.
        const { quit_listing } = await processResponse(
            response,
            bodyUrl,
            start_num - 1,
            isUpdateOperation
        );
        if (quit_listing) {
            logger.trace(
                `Listing exited at Start: ${start_num}, Stop: ${stop_num}, Iteration ${count}`
            );
            break;
        }
        count++;
    }
}
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
    const get_title = spawn("yt-dlp", [
        "--playlist-end",
        1,
        "--flat-playlist",
        "--print",
        "%(playlist_title)s",
        url_var,
    ]);
    get_title.stdout.setEncoding("utf8");
    get_title.stdout.on("data", async (data) => {
        title_str += data;
    });
    get_title.on("close", async (code) => {
        if (code === 0) {
            if (title_str == "NA\n") {
                try {
                    title_str = await urlToTitle(url_var);
                } catch (error) {
                    title_str = url_var;
                    logger.error(`${error.message}`);
                }
            }
            title_str = await stringSlicer(title_str, MAX_LENGTH);
            // no need to use found or create syntax here as
            // this is only run the first time a playlist is made
            playlist_list.findOrCreate({
                where: { playlist_url: url_var },
                defaults: {
                    title: title_str.trim(),
                    monitoring_type: monitoring_type_var,
                    save_dir: title_str.trim(),
                    playlist_index: next_item_index,
                },
            });
        } else {
            logger.error("Playlist could not be created");
        }
    });
}

// List function that send data to frontend
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
            `playlistsToTable: Start: ${start_num}, Stop: ${stop_num}, ` +
            `Order: ${order}, Type: ${type}, Query: "${query_string}"`
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
            // but don't remove as it work I don't remember why
            order_array = sort_downloaded
                ? [video_list, "downloaded", "DESC"]
                : ["index_in_playlist", "ASC"];
        logger.trace(
            `sublistToTable:  Start: ${start_num}, Stop: ${stop_num}, ` +
            ` Query: "${query_string}", Order: ${JSON.stringify(order_array)}, ` +
            `playlist_url: ${playlist_url}`
        );
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
