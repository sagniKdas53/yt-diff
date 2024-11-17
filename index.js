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
const { LRUCache } = require('lru-cache');

const { Server } = require("socket.io");

const protocol = process.env.PROTOCOL || "http";
const host = process.env.HOSTNAME || "localhost";
const port = +process.env.PORT || 8888;
const url_base = process.env.BASE_URL || "/ytdiff";

const db_host = process.env.DB_HOST || "localhost";
const db_user = process.env.DB_USERNAME || "ytdiff";
// Do remember to change this
const db_pass = process.env.DB_PASSWORD_FILE
  ? fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim()
  : process.env.DB_PASSWORD && process.env.DB_PASSWORD.trim()
    ? process.env.DB_PASSWORD
    : "ytd1ff";

const save_location = process.env.SAVE_PATH || "/home/sagnik/Videos/yt-dlp/";
const sleep_time = process.env.SLEEP ?? 3; // Will accept zero seconds, not recommended though.
const chunk_size_env = +process.env.CHUNK_SIZE_DEFAULT || 10; // From my research, this is what youtube uses
exports.chunk_size_env = chunk_size_env;
const scheduled_update_string = process.env.UPDATE_SCHEDULED || "*/30 * * * *";
const time_zone = process.env.TZ_PREFERRED || "Asia/Kolkata";

const save_subs = process.env.SAVE_SUBTITLES !== "false";
const save_description = process.env.SAVE_DESCRIPTION !== "false";
const save_comments = process.env.SAVE_COMMENTS !== "false";
const save_thumbnail = process.env.SAVE_THUMBNAIL !== "false";

const MAX_LENGTH = 255; // this is what sequelize used for postgres
const salt_rounds = 10;
const global_stdTTL = 3600;
const max_requests_per_ip_in_stdTTL = process.env.MAX_REQUESTS_PER_IP || 10;
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
  max: 10, // Maximum number of items to store in the cache
  ttl: global_stdTTL * 1000, // Time-to-live for each item in milliseconds
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
    debug(`sizeCalculation for ${key} is ${value_string.length}`);
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
    debug(`Disposing cache item with key: ${key} for reason: ${reason}`);
    value = null;
  },
});

const user_cache = new LRUCache(cache_options(10000));
const ip_cache = new LRUCache(cache_options(1000));
const secret_key = process.env.SECRET_KEY_FILE
  ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
  : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
    ? process.env.SECRET_KEY.trim()
    : new Error("SECRET_KEY or SECRET_KEY_FILE environment variable must be set");
if(secret_key instanceof Error) {
  throw secret_key;
}
const not_needed = ["", "pornstar", "model", "videos"];
const playlistRegex = /(?:playlist|list=)\b/i;
exports.playlistRegex = playlistRegex;
// spankbang lists playlists as playlist/1,2 so need to add a way to integrate it
const options = [
  "--embed-metadata",
  save_subs ? "--write-subs" : "",
  save_subs ? "--write-auto-subs" : "",
  save_description ? "--write-description" : "",
  save_comments ? "--write-comments" : "",
  save_thumbnail ? "--write-thumbnail" : "",
  "--paths",
].filter(Boolean);
const MAX_CLIENTS = 10;
// let is superior to vars don't use vars
let connectedClients = 0;

// Logging methods
// The highest log level is trace(ie: shows every call), which is the default
// info(ie: shows info about each call) is next and then debug(ie: shows debug info about each call)
const allowed_log_levels = (process.env.LOG_LEVELS || "trace").toLowerCase().trim().split(",");

const cached_log_level = allowed_log_levels.includes("trace") ? [true, true, true] :
  allowed_log_levels.includes("info") ? [false, true, true] :
    allowed_log_levels.includes("debug") ? [false, false, true] : [false, false, false];
/**
 * Trims the given message and returns the trimmed message. If an error occurs during trimming,
 * the original message is returned.
 *
 * @param {string} msg - The message to be trimmed.
 * @return {string} The trimmed message or the original message if an error occurs.
 */
const msg_trimmer = (msg) => {
  try {
    return msg.trim();
  } catch (error) {
    return msg;
  }
};
const orange = color.xterm(208);
// 153 is like sky but very light
// 83 is greenish
// 192 is like hay looks soothing TBH
const trace_color = color.xterm(192);
// trace < info < debug
/**
 * Logs a trace message if the log level is set to trace.
 *
 * @param {string} msg - The message to be logged.
 * @return {undefined} This function does not return a value.
 */
const trace = (msg) => {
  if (cached_log_level[0])
    console.log(
      trace_color(`[${new Date().toLocaleString()}] TRACE: ${msg}`)
    );
};
exports.trace = trace;
/**
 * Logs an informational message if the log level is set to info.
 *
 * @param {string} msg - The message to be logged.
 * @return {undefined} This function does not return a value.
 */
const info = (msg) => {
  if (cached_log_level[1])
    console.log(
      color.blueBright(`[${new Date().toLocaleString()}] INFO: ${msg}`)
    );
};
/**
 * Logs a debug message if the log level is set to debug.
 *
 * @param {string} msg - The message to be logged.
 * @return {undefined} This function does not return a value.
 */
const debug = (msg) => {
  if (cached_log_level[2])
    console.log(
      color.magentaBright(`[${new Date().toLocaleString()}] DEBUG: ${msg}`)
    );
};
exports.debug = debug;
/**
 * A description of the entire function.
 *
 * @param {string} msg - The message to be logged
 * @return {undefined} This function does not return a value
 */
const verbose = (msg) => {
  // This is just for adding some color to the logs, I don"t use it anywhere meaningful
  console.log(
    color.greenBright(`[${new Date().toLocaleString()}] VERBOSE: ${msg}`)
  );
};
/**
 * Logs an error message with a timestamp and the trimmed message.
 *
 * @param {string} msg - The message to be logged.
 * @return {undefined} This function does not return a value.
 */
const err_log = (msg) => {
  console.error(
    color.redBright(`[${new Date().toLocaleString()}] ERROR: ${msg_trimmer(msg)}`)
  );
};
exports.err_log = err_log;
/**
 * Logs a warning message with a timestamp and the warning message.
 *
 * @param {string} msg - The warning message to be logged
 * @return {undefined} This function does not return a value
 */
const warn = (msg) => {
  console.log(
    orange(`[${new Date().toLocaleString()}] WARNING: ${msg}`)
  );
};
exports.warn = warn;

info(`Allowed log level: ${allowed_log_levels}`);

if (!fs.existsSync(save_location)) {
  fs.mkdirSync(save_location, { recursive: true });
}

const sequelize = new Sequelize({
  host: db_host,
  dialect: "postgres",
  logging: false,
  username: db_user,
  password: db_pass,
  database: "vidlist",
});

try {
  sequelize.authenticate().then(() => {
    info("Connection to database has been established successfully");
  });
} catch (error) {
  err_log(`Unable to connect to the database: ${error}`);
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
exports.playlist_list = playlist_list;

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
exports.video_indexer = video_indexer;

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
    info(
      "tables exist or are created successfully"
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
      info(
        "Unlisted playlist created successfully with playlist url: "
        + unlistedPlaylist.playlist_url
      );
    }
    // Making a default user
    const userName = "admin";
    const defaultUser = await users.findOne({ where: { user_name: userName } });
    if (defaultUser === null) {
      debug("Creating default user");
      const generatedPassword = generate_password();
      const [salt, password] = await hash_password(generatedPassword);
      users.create({ user_name: userName, salt: salt, password: password });
      info(
        "Default user created successfully with user name: "
        + userName + " and password: " + generatedPassword
      );
    }else{
      debug("Default user already exists");
    }
  })
  .catch((error) => {
    err_log(`Unable to create table : ${error}`);
  });

// sequelize need to start before this can start
const job = new CronJob(
  scheduled_update_string,
  scheduled_updater,
  null,
  true,
  time_zone
);

// Utility functions
/**
 * Generates a random password.
 *
 * @return {string} A 16 character long password.
 */
function generate_password() {
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
async function extract_json(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", function (data) {
      body += data;
      if (body.length > 1e6) {
        req.connection.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });
    req.on("end", function () {
      try {
        const parsedBody = JSON.parse(body);
        resolve(parsedBody);
      } catch (error) {
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
async function string_slicer(str, len) {
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
 * @param {string} body_url - The URL to extract the title from.
 * @return {string} The extracted title from the URL.
 */
async function url_to_title(body_url) {
  try {
    return new URL(body_url).pathname
      .split("/")
      .filter((item) => !not_needed.includes(item))
      .join("");
  } catch (error) {
    err_log(`${error.message}`);
    return body_url;
  }
}
/**
 * Fixes common errors in the given body URL related to YouTube and Pornhub links.
 *
 * @param {string} body_url - The URL to check and modify.
 * @return {string} The modified URL after fixing common errors.
 */
function fix_common_errors(body_url) {
  if (body_url.includes("youtube")) {
    if (!/\/videos\/?$/.test(body_url) && body_url.includes("/@")) {
      body_url = body_url.replace(/\/$/, "") + "/videos";
    }
    // if (/(.*)&t=[0-9s]*$/.test(body_url)) {
    //   body_url = /(.*)&t=[0-9s]*$/.exec(str)[1];
    //   debug(body_url);
    // }
    debug(`${body_url} is a youtube link`);
  }
  if (body_url.includes("pornhub") && body_url.includes("/model/")) {
    if (!/\/videos\/?$/.test(body_url)) {
      body_url = body_url.replace(/\/$/, "") + "/videos";
    }
    debug(`${body_url} is a hub channel`);
  }
  // TODO: Add checks for other sites
  return body_url;
}
exports.fix_common_errors = fix_common_errors;
/**
 * Spawns a child process to run the `yt-dlp` command with the given parameters and returns a promise that resolves with the response.
 *
 * @param {string} body_url - The URL of the playlist to download.
 * @param {number} start_num - The starting index of the playlist to download.
 * @param {number} stop_num - The ending index of the playlist to download.
 * @return {Promise<string[]>} A promise that resolves with an array of strings representing the response from `yt-dlp`.
 */
async function list_spawner(body_url, start_num, stop_num) {
  trace(
    `list_spawner: Start: ${start_num}, Stop: ${stop_num}, Url: ${body_url}`
  );
  return new Promise((resolve, reject) => {
    const yt_list = spawn("yt-dlp", [
      "--playlist-start",
      start_num,
      "--playlist-end",
      stop_num,
      "--flat-playlist",
      "--print",
      "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s",
      body_url,
    ]);
    let response = "";
    yt_list.stdout.setEncoding("utf8");
    yt_list.stdout.on("data", (data) => {
      response += data;
    });
    yt_list.stderr.setEncoding("utf8");
    yt_list.stderr.on("data", (data) => {
      // maybe use sockets to send the stderr to the
      err_log(`stderr: ${data}`);
    });
    yt_list.on("error", (error) => {
      err_log(`${error.message}`);
    });
    yt_list.on("close", (code) => {
      if (code !== 0) {
        err_log(`yt-dlp returned code: ${code}`);
      }
      resolve(response.split("\n").filter((line) => line.length > 0));
    });
  });
}
exports.list_spawner = list_spawner;
/**
 * Processes the response from a list operation and updates the video_list and video_indexer tables.
 *
 * @param {Array} response - The response array containing video information.
 * @param {string} body_url - The URL of the playlist.
 * @param {number} index - The starting index of the list operation.
 * @param {boolean} is_update_operation - Indicates if it is an update operation.
 * @return {Promise<Object>} - A promise that resolves to an object containing the count of processed items, the response URL, the starting index, and a boolean indicating if listing should be quit.
 */
async function process_response(
  response,
  body_url,
  index,
  is_update_operation
) {
  trace(
    `process_response: Index: ${index}, Url: ${body_url}, Updating Playlist: ${is_update_operation}`
  );
  const init_resp = {
    count: 0,
    resp_url: body_url,
    start: index,
    quit_listing: false,
  };
  sock.emit("listing-or-downloading", { percentage: 101 });
  // Setting this to zero so that no effect is there in normal runs
  let last_item_index = 0;
  if (is_update_operation) {
    // manipulate the index
    const last_item = await video_indexer.findOne({
      where: {
        playlist_url: body_url,
      },
      order: [["index_in_playlist", "DESC"]],
      attributes: ["index_in_playlist"],
      limit: 1,
    });
    debug(`In update operation found last item ${JSON.stringify(last_item)}`);
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
      debug(
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
      const playlist_url = body_url; // Assuming body_url refers to the playlist_url
      const foundItem = await video_indexer.findOne({
        where: { video_url: vid_url, playlist_url: playlist_url },
      });
      debug(
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
    debug("All items already exist in the database.");
    init_resp["quit_listing"] = true;
    init_resp["count"] = allItemsExistInVideoIndexer.length;
    return init_resp; // Return early if all items exist
  } else {
    debug(`Videos per list index exist in video_list: ${JSON.stringify(
      allItemsExistInVideoList
    )}`)
    debug(`Videos per list index exist in video_indexer: ${JSON.stringify(
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
        const title_processed = await string_slicer(title === "NA" ? vid_id.trim() : title, MAX_LENGTH);
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
          debug("Result of video add " + JSON.stringify([foundVid, createdVid]));
          if (!createdVid) {
            update_vid_entry(foundVid, vid_data);
          }
        }
        if (!allItemsExistInVideoIndexer[map_idx]) {
          const junction_data = {
            video_url: vid_url,
            playlist_url: body_url,
            index_in_playlist: index + map_idx + last_item_index,
          };
          const [foundJunction, createdJunction] = await video_indexer.findOrCreate({
            where: junction_data,
          });
          debug("Result of video_playlist_index add " + JSON.stringify([foundJunction, createdJunction]));
          if (!createdJunction) {
            debug(`Found video_indexer: ${JSON.stringify(foundJunction)}`);
          }
        }
      } catch (error) {
        err_log(`${error.message} - ${error.stack}`);
      } finally {
        init_resp["count"]++;
      }
    })
  );
  return init_resp;
}
exports.process_response = process_response;
/**
 * Updates a video entry in the database.
 *
 * @param {Object} found - The found video object.
 * @param {Object} data - The data to update the video with.
 * @return {Promise<void>} - A promise that resolves when the video entry is updated.
 */
async function update_vid_entry(found, data) {
  // The object was found and not created
  // Does not change the downloaded state
  // I have a sneaking suspicion that this
  // will fail when there is any real change
  // in the video, lets see when that happens
  trace(`update_vid_entry: found: ${JSON.stringify(found)} vs. data: ${JSON.stringify(data)}`);
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
    warn(
      `Found ${differences.length} difference(s): ${differences.join(", ")}`
    );
    found.id = data.id;
    found.approximate_size = +data.approximate_size;
    found.title = data.title;
    found.available = data.available;
    await found.save();
  } else if (found.downloaded !== data.downloaded) {
    debug("This property does not need modification");
  }
}
/**
 * Asynchronously pauses the execution of the current code for a specified
 * number of seconds.
 *
 * @param {number} [sleep_seconds=sleep_time] - The number of seconds to sleep.
 * Defaults to the value of the `sleep_time` variable.
 * @return {Promise<void>} A promise that resolves after the specified number of
 * seconds have passed.
 */
async function sleep(sleep_seconds = sleep_time) {
  debug("Sleeping for " + sleep_seconds + " seconds");
  return new Promise((resolve) => setTimeout(resolve, sleep_seconds * 1000));
}
exports.sleep = sleep;
//Authentication functions
/**
 * Asynchronously hashes the given password using bcrypt.
 *
 * @param {string} password - The password to be hashed
 * @return {Promise<Array>} A promise that resolves to an array containing the salt and hash
 */
async function hash_password(password) {
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
  const body = await extract_json(req),
    user_name = body["user_name"],
    body_password = body["password"];
  const foundUser = await users.findOne({
    where: { user_name: user_name },
  });
  if (body_password !== undefined) {
    if (foundUser === null) {
      const [salt, password] = await hash_password(body_password);
      users.create({ user_name: user_name, salt: salt, password: password });
      res.writeHead(201, corsHeaders(json_t));
      res.end(JSON.stringify({ Outcome: "User added successfully" }));
    } else {
      res.writeHead(409, corsHeaders(json_t));
      res.end(JSON.stringify({ Outcome: "User already exists" }));
    }
  } else {
    res.writeHead(400, corsHeaders(json_t));
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
function generate_token(user, expiry_time) {
  return jwt.sign(
    {
      id: user.id,
      lastPasswordChangeTime: user.updatedAt
    },
    secret_key, { expiresIn: expiry_time }
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
async function verify_token(req, res, next) {
  try {
    const body = await extract_json(req),
      token = body["token"];
    const decoded = jwt.verify(token, secret_key);
    //verbose(`Decoded token: ${JSON.stringify(decoded)}}`);
    let foundUser = user_cache.get(decoded.id);
    if (!foundUser) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);
    }
    //verbose(`foundUser: ${JSON.stringify(foundUser)}`)
    // Check if the last password change timestamp matches the one in the database for the user
    if (foundUser === null) {
      err_log("User not found in the database");
      res.writeHead(404, corsHeaders(json_t));
      return res.end(JSON.stringify({ Outcome: "User not found" }));
    }
    let foundUserUpdatedAt = foundUser.updatedAt.toISOString(); // Convert to UTC ISO string
    if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);
      foundUserUpdatedAt = foundUser.updatedAt.toISOString();
      // Logging the re-fetched user data
      //debug(`foundUser.updatedAt: ${foundUserUpdatedAt}`);
      //debug(`decoded.lastPasswordChangeTime: ${decoded.lastPasswordChangeTime}`);
      // Checking again
      if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
        err_log(`Token Expired`);
        res.writeHead(401, corsHeaders(json_t));
        return res.end(JSON.stringify({ Outcome: "Token Expired" }));
      }
    }
    next(body, res);
  } catch (error) {
    err_log(error);
    if (error.name === "TokenExpiredError") {
      sock.emit("token-expired")
      res.writeHead(401, corsHeaders(json_t));
      return res.end(JSON.stringify({ Outcome: "Token Expired" }));
    }
    res.writeHead(500, corsHeaders(json_t));
    return res.end(JSON.stringify({ Outcome: error.message }));
  }
}
/**
 * Verify the socket data and return true if the token is valid, false otherwise.
 *
 * @param {Object} data - the socket data containing the authentication token
 * @return {boolean} true if the token is valid, false otherwise
 */
async function verify_socket(data) {
  try {
    const token = data.handshake.auth.token;
    const decoded = jwt.verify(token, secret_key);

    let foundUser = user_cache.get(decoded.id);
    if (!foundUser) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);
    }

    // Check if the last password change timestamp matches the one in the token
    const foundUserUpdatedAt = foundUser.updatedAt.toISOString(); // Convert to UTC ISO string
    if (foundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);

      // Update timestamp
      const updatedFoundUserUpdatedAt = foundUser.updatedAt.toISOString();

      // Checking again
      if (updatedFoundUserUpdatedAt !== decoded.lastPasswordChangeTime) {
        debug(`Token Expired`);
        return false;
      }
    }
    return true;
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      err_log(`${error.message.split(":")[0]}`);
    }
    else if (error.name === "TokenExpiredError") {
      err_log(`Token Expired`);
    }
    else {
      err_log(error);
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
async function rate_limiter(req, res, current, next, max_requests_per_ip_in_stdTTL, stdTTL) {
  // const req_clone = req.clone();
  const ipAddress = req.socket.remoteAddress;
  trace(`Incoming request from ${ipAddress}`);
  if (ip_cache.get(ipAddress) >= max_requests_per_ip_in_stdTTL) {
    debug(`rate limiting ${ipAddress}`);
    res.writeHead(429, corsHeaders(json_t));
    return res.end(JSON.stringify({ Outcome: "Too many requests" }));
  }
  if (!ip_cache.has(ipAddress)) {
    ip_cache.set(ipAddress, 1, +stdTTL);
    debug(`adding to ip_cache ${ipAddress}: ${ip_cache.get(ipAddress)}`);
  }
  else {
    ip_cache.set(ipAddress, ip_cache.get(ipAddress) + 1, +stdTTL);
    debug(`ip_cache ${ipAddress}: ${ip_cache.get(ipAddress)}`);
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
    const body = await extract_json(req),
      user_name = body["user_name"],
      body_password = body["password"],
      expiry_time = body["expiry_time"] || "31d";
    const foundUser = await users.findOne({
      where: { user_name: user_name },
    });
    if (foundUser === null) {
      verbose(`Issuing token for user ${user_name} failed`);
      res.writeHead(404, corsHeaders(json_t));
      res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
    } else {
      const passwordMatch = await bcrypt.compare(body_password, foundUser.password);
      if (!passwordMatch) {
        verbose(`Issuing token for user ${foundUser.user_name} failed`);
        res.writeHead(401, corsHeaders(json_t));
        return res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
      }
      const token = generate_token(foundUser, expiry_time);
      verbose(`Issued token for user ${foundUser.user_name} expires in ${expiry_time}`);
      res.writeHead(202, corsHeaders(json_t));
      return res.end(JSON.stringify({ token: token }));
    }
  } catch (error) {
    err_log(`Error generating token: ${error.message}`);
    res.writeHead(500, corsHeaders(json_t));
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
async function scheduled_updater() {
  info(`Scheduled update started at: ${new Date().toLocaleString()}`);
  info(`Starting the quick update`);
  //quick update then full update
  quick_updates()
    .then(full_updates())
    .then(() =>
      sock.emit("playlist-done", {
        message: "done updating playlist or channel",
        id: "None",
      })
    );
  info(`Scheduled update finished at: ${new Date().toLocaleString()}`);
  info(`Next scheduled update on ${job.nextDates(1)}`);
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

  info(`Fast updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    let index = -chunk_size_env + 1;
    try {
      await sleep();
      await list_background(
        playlist.playlist_url,
        index,
        index + chunk_size_env,
        chunk_size_env,
        true
      );
      trace(`Done processing playlist ${playlist.playlist_url}`);
      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err_log(
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
  info(`Full updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    try {
      info(
        `Full updating playlist: ${playlist.title.trim()} being updated fully`
      );
      // Since this is a full update the is_update_operation will be false
      await sleep();
      await list_background(
        playlist.playlist_url,
        0,
        chunk_size_env,
        chunk_size_env,
        false
      );
      info(`Done processing playlist ${playlist.playlist_url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err_log(
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
async function download_lister(body, res) {
  try {
    const download_list = [],
      in_download_list = new Set(),
      // remember to send this from the frontend
      play_list_url = body["playListUrl"] !== undefined ? body["playListUrl"] : "None";
    for (const url_item of body["urlList"]) {
      if (!in_download_list.has(url_item)) {
        debug(`checking for ${url_item} in db`);
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
            err_log(`${error.message}`);
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
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify({ Downloading: download_list }));
  } catch (error) {
    err_log(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
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
  trace(`Downloading ${items.length} videos sequentially`);
  let count = 1;
  for (const [url_str, title, save_dir, video_id] of items) {
    try {
      // yeah, this needs a join too from the playlists now to get the save directory and stuff
      trace(`Downloading Video: ${count++}, Url: ${url_str}`);
      let hold = null;
      // Find a way to check and update it in the db if it is not correct
      let realFileName = null;
      // check if the trim is actually necessary
      const save_path = path_fs.join(save_location, save_dir.trim());
      debug(`Downloading ${realFileName} to path: ${save_path}`);
      // if save_dir == "",  then save_path == save_location
      if (save_path != save_location && !fs.existsSync(save_path)) {
        fs.mkdirSync(save_path, { recursive: true });
      }
      sock.emit("download-start", { message: "" });
      // verbose(`executing: yt-dlp ${options.join(" ")} ${save_path} ${url_str}`);
      const yt_dlp = spawn("yt-dlp", options.concat([save_path, url_str]));
      yt_dlp.stdout.setEncoding("utf8");
      yt_dlp.stdout.on("data", async (data) => {
        try {
          const dataStr = data.toString().trim(); // Convert buffer to string once
          // trace(dataStr);
          // Percentage extraction
          const percentageMatch = /(\d{1,3}\.\d)/.exec(dataStr);
          if (percentageMatch !== null) {
            const percentage = parseFloat(percentageMatch[0]);
            const percentageDiv10 = Math.floor(percentage / 10);
            if (percentageDiv10 === 0 && hold === null) {
              hold = 0;
              trace(dataStr);
            } else if (percentageDiv10 > hold) {
              hold = percentageDiv10;
              trace(dataStr);
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
            debug(`extracted filename: ${realFileName}, filename from db: ${title}`);
          }
        } catch (error) {
          // err_log(`${data} : ${error.message}`);
          // this is done so that the toasts do not go crazy
          if (!error instanceof TypeError) {
            sock.emit("error", { message: `${error}` });
          }
        }
      });
      yt_dlp.stderr.setEncoding("utf8");
      yt_dlp.stderr.on("data", (data) => {
        err_log(`stderr: ${data}`);
      });
      yt_dlp.on("error", (error) => {
        err_log(`${error.message}`);
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
          debug(`Update data: ${JSON.stringify(entityProp)}`);
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
      trace(`Downloaded ${title} at location ${save_path}`);
    } catch (error) {
      err_log(`${error.message}`);
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
 *   - chunk_size {number} (optional): The number of items to process at a time. Defaults to the value of the chunk_size_env variable.
 *   - sleep {boolean} (optional): Whether to wait for a short period of time before processing each URL. Defaults to false.
 *   - monitoring_type {string} (optional): The type of monitoring to perform. Defaults to "N/A".
 * @param {Object} res - The response object to send the results to.
 * @return {Promise<void>} A promise that resolves when the processing is complete.
 */

async function list_func(body, res) {
  try {
    const start_num = body["start"] !== undefined ?
      +body["start"] === 0 ? 1 : +body["start"] : 1, chunk_size = +body["chunk_size"] >= +chunk_size_env ? +body["chunk_size"] : +chunk_size_env, stop_num = +chunk_size + 1, sleep_before_listing = body["sleep"] !== undefined ? body["sleep"] : false, monitoring_type = body["monitoring_type"] !== undefined ? body["monitoring_type"] : "N/A";
    let index = 0;
    //verbose(`body: ${JSON.stringify(body)}`);
    //verbose(`start_num: ${start_num}, stop_num: ${stop_num}, chunk_size: ${chunk_size}, sleep_before_listing: ${sleep_before_listing}, monitoring_type: ${monitoring_type}`);

    if (body["url_list"] === undefined) {
      throw new Error("url list is required");
    }
    let url_list = body["url_list"], last_item_index = start_num > 0 ? start_num - 1 : 0; // index must start from 0 so start_num needs to subtracted by 1

    //debug(`payload: ${JSON.stringify(body)}`);
    trace(
      `list_func:  url_list: ${url_list}, start_num: ${start_num}, index: ${last_item_index}, ` +
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
        debug(`current_url: ${current_url}, index: ${index}`);
        try {
          const done = await list_init(current_url, body, index, res, sleep_before_listing, last_item_index, start_num, stop_num, chunk_size, monitoring_type);
          if (done) {
            debug(`processed current_url: ${current_url}, index: ${index}`);
          } else if (done instanceof Error) {
            err_log(`list_func processing error: ${done.message}`);
          } else {
            debug(`done: ${done}, current_url: ${current_url}, index: ${index}`);
          }
        } catch (error) {
          err_log(`list_func processing error: ${error.message}`);
        }
        index += 1;
        //});
      }
      debug("List processing done");
    } catch (error) {
      err_log(`${error.message}`);
      const status = error.status || 500;
      if (index === 0) {
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ error: error.message }));
      }
      sock.emit("playlist-done", {
        message: "done processing playlist or channel",
        id: current_url === "None" ? body["url_list"][index] : current_url,
      });
    }
  } catch (error) {
    err_log(`${error.message}`);
    //const status = error.status || 500;
    //res.writeHead(status, corsHeaders(json_t));
    //res.end(JSON.stringify({ error: error.message }));
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
  trace(`list_init: url: ${current_url}, index: ${index}, start_num: ${start_num}, stop_num: ${stop_num}, chunk_size: ${chunk_size}, monitoring_type: ${monitoring_type}`);
  //try {
  return new Promise(async (resolve, reject) => {
    trace("Processing url: " + current_url);
    current_url = fix_common_errors(current_url);
    if (sleep_before_listing) { await sleep(); }
    const response_list = await list_spawner(current_url, start_num, stop_num);
    debug(`response_list: ${JSON.stringify(response_list)}, response_list.length: ${response_list.length}`);
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
          trace(
            `Playlist: ${is_already_indexed.title.trim()} is indexed at ${is_already_indexed.playlist_index}`
          );
          already_indexed = true;
          // Now that this is obtained setting the playlist index in front end is do able only need to figure out how
          play_list_index = is_already_indexed.playlist_index;
          // Resolve the promise with the last item index
          resolve(last_item_index);
        } catch (error) {
          warn(
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
                trace(
                  `Playlist: ${playlist.title} is indexed at ${playlist.playlist_index}`
                );
                // Resolve the promise with the last item index
                resolve(last_item_index);
              } else {
                throw new Error("Playlist not found");
              }
            })
            .catch((error) => {
              err_log("Error occurred:", error);
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
          debug("unlisted video entry found: " +
            JSON.stringify(video_already_unlisted)
          );
          if (video_already_unlisted !== null) {
            debug("Video already saved as unlisted");
            reject(video_already_unlisted);
          } else {
            debug("Adding a new video to the unlisted videos list");
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
          err_log(`${error.message}`);
          const status = error.status || 500;
          if (index === 0) {
            res.writeHead(status, corsHeaders(json_t));
            res.end(JSON.stringify({ error: error.message }));
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
        // debug("last_item_index: " + last_item_index);
        process_response(response_list, current_url, last_item_index, false)
          .then((init_resp) => {
            try {
              init_resp["prev_playlist_index"] = play_list_index + 1;
              init_resp["already_indexed"] = already_indexed;
              if (index === 0) {
                res.writeHead(200, corsHeaders(json_t));
                res.end(JSON.stringify(init_resp));
              }
              resolve(true)
            } catch (error) {
              err_log(`${error.message}`);
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
              trace(`Done processing playlist: ${current_url}`);
              sock.emit("playlist-done", {
                message: "done processing playlist or channel",
                id: current_url === "None" ? body["url_list"][index] : current_url,
              });
            });
          });
      },
      (video_already_unlisted) => {
        trace("Video already saved as unlisted");
        try {
          if (index === 0) {
            res.writeHead(200, corsHeaders(json_t));
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
          err_log(`${error.message}`);
          reject(error);
        }
      }
    );
  })
  // } catch (error) {
  //   trace(`Error in list_init: ${error.message}`);
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
async function monitoring_type_func(body, res) {
  try {
    const body_url = body["url"],
      monitoring_type = body["watch"];
    if (body["url"] === undefined || body["watch"] === undefined) {
      throw new Error("url and watch are required");
    }
    trace(
      `monitoring_type_func:  url: ${body_url}, monitoring_type: ${monitoring_type}`
    );
    const playlist = await playlist_list.findOne({
      where: { playlist_url: body_url },
    });
    playlist.monitoring_type = monitoring_type;
    await playlist.update({ monitoring_type }, { silent: true });
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify({ Outcome: "Success" }));
  } catch (error) {
    err_log(`error in monitoring_type_func: ${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
/**
 * Asynchronously performs a background listing operation.
 *
 * @param {string} body_url - The URL of the playlist.
 * @param {number} start_num - The starting index of the playlist.
 * @param {number} stop_num - The ending index of the playlist.
 * @param {number} chunk_size - The size of each chunk to process.
 * @param {boolean} is_update_operation - Indicates if the operation is an update.
 * @return {undefined}
 */
async function list_background(
  body_url,
  start_num,
  stop_num,
  chunk_size,
  is_update_operation
) {
  // yes a playlist on youtube atleast can only be 5000 long  && stop_num < 5000
  // let max_size = 5000;
  // let loop_num = max_size / chunk_size;
  let count = 0;
  while (body_url != "None") {
    start_num = start_num + chunk_size;
    stop_num = stop_num + chunk_size;
    // ideally we can set it to zero but that would get us rate limited by the services
    trace(
      `list_background: URL: ${body_url}, Chunk: ${chunk_size},` +
      `Start: ${start_num}, Stop: ${stop_num}, Iteration: ${count}`
    );
    //await sleep();
    const response = await list_spawner(body_url, start_num, stop_num);
    if (response.length === 0) {
      trace(
        `Listing exited at Start: ${start_num}, Stop: ${stop_num}, Iteration ${count}`
      );
      break;
    }
    // yt-dlp starts counting from 1 for some reason so 1 needs to be subtracted here.
    const { quit_listing } = await process_response(
      response,
      body_url,
      start_num - 1,
      is_update_operation
    );
    if (quit_listing) {
      trace(
        `Listing exited at Start: ${start_num}, Stop: ${stop_num}, Iteration ${count}`
      );
      break;
    }
    count++;
  }
}
exports.list_background = list_background;
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
          title_str = await url_to_title(url_var);
        } catch (error) {
          title_str = url_var;
          err_log(`${error.message}`);
        }
      }
      title_str = await string_slicer(title_str, MAX_LENGTH);
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
      err_log("Playlist could not be created");
    }
  });
}
exports.add_playlist = add_playlist;

// List function that send data to frontend
/**
 * Asynchronously processes the playlists data and sends the result to the frontend.
 *
 * @param {Object} body - The request body containing parameters for processing playlists.
 * @param {Object} res - The response object to send back the processed playlists data.
 */
async function playlists_to_table(body, res) {
  try {
    const start_num = body["start"] !== undefined ? +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? +body["stop"] : chunk_size_env,
      sort_with = body["sort"] !== undefined ? +body["sort"] : 1,
      order = body["order"] !== undefined ? +body["order"] : 1,
      query_string = body["query"] !== undefined ? body["query"] : "",
      type = order == 2 ? "DESC" : "ASC", // 0, 1 it will be ascending else descending
      row = sort_with == 3 ? "updatedAt" : "playlist_index";
    trace(
      `playlists_to_table: Start: ${start_num}, Stop: ${stop_num}, ` +
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
          res.writeHead(200, corsHeaders(json_t));
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
          res.writeHead(200, corsHeaders(json_t));
          res.end(JSON.stringify(result));
        });
    }
  } catch (error) {
    err_log(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
/**
 * Asynchronously processes the sublist data and sends the result to the frontend.
 *
 * @param {Object} body - The request body containing parameters for processing the sublist.
 * @param {Object} res - The response object to send back the processed sublist data.
 * @return {Promise} A promise that resolves when the data has been processed and sent to the frontend.
 */
async function sublist_to_table(body, res) {
  try {
    const playlist_url = body["url"] !== undefined ? body["url"] : "None",
      // temp fix for Frontend bug that is causing the start number to be -ve and crashing the app
      start_num = body["start"] !== undefined ? +body["start"] < 0 ? 0 : +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? +body["stop"] : chunk_size_env,
      query_string = body["query"] !== undefined ? body["query"] : "",
      sort_downloaded = body["sortDownloaded"] !== undefined ? body["sortDownloaded"] : false,
      // [video_list, "downloaded", "DESC"] shows up as [null,"downloaded","DESC"] in the logs
      // but don't remove as it work I don't remember why
      order_array = sort_downloaded
        ? [video_list, "downloaded", "DESC"]
        : ["index_in_playlist", "ASC"];
    trace(
      `sublist_to_table:  Start: ${start_num}, Stop: ${stop_num}, ` +
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
            res.writeHead(200, corsHeaders(json_t));
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
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(result));
          });
      }
    } catch (error) {
      err_log(`${error.message}`);
    }
  } catch (error) {
    err_log(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}

const json_t = "text/json; charset=utf-8";
exports.json_t = json_t;
const html = "text/html; charset=utf-8";
/**
 * Returns CORS headers based on the specified type.
 *
 * @param {type} type - The type to be used for Content-Type header
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
exports.corsHeaders = corsHeaders;

const types = {
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".gz": "application/gzip",
  ".br": "application/brotli",
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
    staticAssets[element.filePath.replace("dist", "/ytdiff")] = {
      file: fs.readFileSync(element.filePath),
      type: types[element.extension],
    };
  });
  staticAssets["/ytdiff/"] = staticAssets["/ytdiff/index.html"];
  staticAssets["/ytdiff"] = staticAssets["/ytdiff/index.html"];
  staticAssets["/ytdiff/.gz"] = staticAssets["/ytdiff/index.html.gz"];
  staticAssets["/ytdiff.gz"] = staticAssets["/ytdiff/index.html.gz"];
  staticAssets["/ytdiff/.br"] = staticAssets["/ytdiff/index.html.br"];
  staticAssets["/ytdiff.br"] = staticAssets["/ytdiff/index.html.br"];
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets = makeAssets(filesList);
let server_options = {};

if (process.env.USE_NATIVE_HTTPS === "true") {
  const keyPath = process.env.KEY_PATH;
  const certPath = process.env.CERT_PATH;
  try {
    server_options = {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8")
    };
  } catch (error) {
    err_log("Error reading secret files:", error);
    process.exit(1);
  }
}

const server = http.createServer(server_options, (req, res) => {
  if (req.url.startsWith(url_base) && req.method === "GET") {
    try {
      const get = req.url; //.replace(url_base, "");
      const reqEncoding = req.headers["accept-encoding"] || "";
      const resHeaders = corsHeaders(staticAssets[get].type);
      //debug(`Request Accept-Encoding: [${reqEncoding}]`);
      if (reqEncoding.includes("br")) {
        //debug(`Sending ${get} compressed with brotli`);
        resHeaders["Content-Encoding"] = "br";
        res.writeHead(200, resHeaders);
        //info(`Writing ${get}.br`);
        res.write(staticAssets[get + ".br"].file);
        return res.end();
        //res.write(zlib.gzipSync(staticAssets[get].file));
      } else if (reqEncoding.includes("gzip")) {
        //debug(`Sending ${get} compressed with gzip`);
        resHeaders["Content-Encoding"] = "gzip";
        res.writeHead(200, resHeaders);
        //info(`Writing ${get}.gz`);
        res.write(staticAssets[get + ".gz"].file);
        return res.end();
        //res.write(zlib.gzipSync(staticAssets[get].file));
      } else {
        //debug(`Sending ${get} uncompressed`);
        res.writeHead(200, resHeaders);
        res.write(staticAssets[get].file);
      }
    } catch (error) {
      //err_log(`${error.message}`);
      res.writeHead(404, corsHeaders(html));
      res.write("Not Found");
    }
    res.end();
  } else if (req.method === "OPTIONS") {
    // necessary for cors
    res.writeHead(204, corsHeaders(json_t));
    res.end();
  } else if (req.method === "HEAD") {
    // necessary for health check
    res.writeHead(204, corsHeaders(json_t));
    res.end();
  } else if (req.url === url_base + "/list" && req.method === "POST") {
    verify_token(req, res, list_func);
  } else if (req.url === url_base + "/download" && req.method === "POST") {
    verify_token(req, res, download_lister);
  } else if (req.url === url_base + "/watch" && req.method === "POST") {
    verify_token(req, res, monitoring_type_func);
  } else if (req.url === url_base + "/getplay" && req.method === "POST") {
    //rate_limiter(req, res, verify_token, playlists_to_table);
    verify_token(req, res, playlists_to_table);
  } else if (req.url === url_base + "/getsub" && req.method === "POST") {
    //rate_limiter(req, res, verify_token, sublist_to_table);
    verify_token(req, res, sublist_to_table);
  }
  else if (req.url === url_base + "/register" && req.method === "POST") {
    //register(req, res);
    rate_limiter(req, res, register, (req, res, next) => next(req, res),
      max_requests_per_ip_in_stdTTL, global_stdTTL);
  }
  else if (req.url === url_base + "/login" && req.method === "POST") {
    //login(req, res);
    rate_limiter(req, res, login, (req, res, next) => next(req, res),
      max_requests_per_ip_in_stdTTL, global_stdTTL);
  } else {
    res.writeHead(404, corsHeaders(html));
    res.write("Not Found");
    res.end();
  }
});

const io = new Server(server, {
  path: url_base + "/socket.io/",
  cors: {
    // cors will only happen on these so it's best to keep it limited
    origin: [
      "http://localhost:5173",
      "http://localhost:8888",
    ],
  },
});

io.use((socket, next) => {
  verify_socket(socket).then((result) => {
    if (result) {
      //debug("Valid socket: " + socket.id);
      next();
    }
    else {
      //err_log("Invalid socket: " + socket.id);
      next(new Error("Invalid socket"));
    }
  }).catch((err) => {
    err_log(err);
    next(new Error(err.message));
  });
});

const sock = io.on("connection", (socket) => {
  if (connectedClients >= MAX_CLIENTS) {
    info("Rejecting client: " + socket.id);
    socket.emit("connection-error", "Server full");
    // Disconnect the client
    socket.disconnect(true);
    return;
  }

  // Increment the count of connected clients
  socket.emit("init", { message: "Connected", id: socket.id });
  socket.on("acknowledge", ({ data, id }) => {
    info(`${data} to client id ${id}`);
    connectedClients++;
  });

  socket.on("disconnect", () => {
    // Decrement the count of connected clients when a client disconnects
    info(`Disconnected from client id ${socket.id}`);
    connectedClients--;
  });
  return socket;
});
exports.sock = sock;

server.listen(port, async () => {
  if (process.env.HIDE_PORTS === "true") {
    info(`Server listening on ${protocol}://${host}${url_base}`);
  } else {
    info(`Server listening on ${protocol}://${host}:${port}${url_base}`);
  }
  // I do not really know if calling these here is a good idea, but how else can I even do it?
  const start = Date.now();
  await sleep();
  const elapsed = Date.now() - start;
  info("Sleep duration: " + elapsed / 1000 + " seconds");
  info(`Next scheduled update is on ${job.nextDates(1)}`);
  verbose(
    `Download Options: yt-dlp ${options.join(" ")} "${save_location.endsWith("/") ? save_location : save_location + "/"
    }{playlist_dir}" "{url}"`
  );
  verbose(
    "List Options: yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
    `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {body_url}`
  );
  job.start();
});
