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
    logLevel: (process.env.LOG_LEVELS || "trace").toLowerCase().trim().split(","),
    secretKey: process.env.SECRET_KEY_FILE
        ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
        : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
            ? process.env.SECRET_KEY.trim()
            : new Error("SECRET_KEY or SECRET_KEY_FILE environment variable must be set"),
    notNeeded: ["", "pornstar", "model", "videos"],
    playlistRegex: /(?:playlist|list=)\b/i,
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
const cache_options = (size) => ({
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

const userCache = new LRUCache(cache_options(1000));
const ipCache = new LRUCache(cache_options(1000));

// Logging
// TODO: Move these constants to config
const allowedLogLevel = (process.env.LOG_LEVELS || "trace").toLowerCase().trim();
const logLevels = ["trace", "debug", "verbose", "info", "warn", "error"];
const currentLogLevelIndex = logLevels.indexOf(allowedLogLevel);
const orange = color.xterm(208);
const trace_color = color.xterm(195);

// Helper function to format logs in Grafana logfmt format
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
// Logger
const logger = {
    trace: (message, fields = {}) => {
        if (currentLogLevelIndex <= logLevels.indexOf("trace")) {
            console.debug(trace_color(logfmt('trace', message, fields)));
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

logger.info("Logger initialized", { logLevel: allowedLogLevel });

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
                { playlist: unlistedPlaylist }
            );
        }
        // Making a default user
        const userName = "admin";
        const defaultUser = await users.findOne({ where: { user_name: userName } });
        if (defaultUser === null) {
            logger.debug("Creating default user");
            const generatedPassword = generate_password();
            const [salt, password] = await hash_password(generatedPassword);
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
    // scheduled_updater,
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

// Helper functions
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
            //logger.debug(`Request Accept-Encoding: [${reqEncoding}]`);
            if (reqEncoding.includes("br")) {
                //logger.debug(`Sending ${get} compressed with brotli`);
                resHeaders["Content-Encoding"] = "br";
                res.writeHead(200, resHeaders);
                //logger.info(`Writing ${get}.br`);
                res.write(staticAssets[get + ".br"].file);
                return res.end();
                //res.write(zlib.gzipSync(staticAssets[get].file));
            } else if (reqEncoding.includes("gzip")) {
                //logger.debug(`Sending ${get} compressed with gzip`);
                resHeaders["Content-Encoding"] = "gzip";
                res.writeHead(200, resHeaders);
                //logger.info(`Writing ${get}.gz`);
                res.write(staticAssets[get + ".gz"].file);
                return res.end();
                //res.write(zlib.gzipSync(staticAssets[get].file));
            } else {
                //logger.debug(`Sending ${get} uncompressed`);
                res.writeHead(200, resHeaders);
                res.write(staticAssets[get].file);
            }
        } catch (error) {
            logger.error("Error in processing request", {
                error: error,
                path: req.url,
                method: req.method
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
        verifyToken(req, res, monitoringTypeFunc);
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
        `Download Options: yt-dlp ${downloadOptions.join(" ")} "${config.saveLocation.endsWith("/") ? config.saveLocation : config.saveLocation + "/"
        }{playlist_dir}" "{url}"`
    );
    logger.verbose(
        "List Options: yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
        `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {body_url}`
    );
    job.start();
});
