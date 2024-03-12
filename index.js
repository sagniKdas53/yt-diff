"use strict";
const { Sequelize, DataTypes, Op } = require("sequelize");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const color = require("cli-color");
const CronJob = require("cron").CronJob;
const fs = require("fs");
const http = require("http");
const path_fs = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const NodeCache = require("node-cache");

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
const user_cache = new NodeCache({ stdTTL: global_stdTTL, checkperiod: 7200 });
const ip_cache = new NodeCache({ stdTTL: global_stdTTL, checkperiod: 7200 });
const secret_key = process.env.SECRET_KEY_FILE
  ? fs.readFileSync(process.env.SECRET_KEY_FILE, "utf8").trim()
  : process.env.SECRET_KEY && process.env.SECRET_KEY.trim()
    ? process.env.SECRET_KEY
    : "ytd1ff";
const not_needed = ["", "pornstar", "model", "videos"];
const playlistRegex = /(?:playlist|list=)\b/i;
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

// Logging methods
const allowed_log_levels = (process.env.LOG_LEVELS || "info,trace,debug").split(",");
const cached_log_level =
  [allowed_log_levels.includes("info"),
  allowed_log_levels.includes("trace"),
  allowed_log_levels.includes("debug")];
const msg_trimmer = (msg) => {
  try {
    return msg.trim();
  } catch (error) {
    return msg;
  }
};
const info = (msg) => {
  if (cached_log_level[0])
    console.log(
      color.blueBright(`[${new Date().toLocaleString()}] INFO: ${msg}`)
    );
};
const verbose = (msg) => {
  // This is just for adding some color to the logs, I don"t use it anywhere meaningful
  console.log(
    color.greenBright(`[${new Date().toLocaleString()}] VERBOSE: ${msg}`)
  );
};
const debug = (msg) => {
  if (cached_log_level[2])
    console.log(
      color.magentaBright(`[${new Date().toLocaleString()}] DEBUG: ${msg}`)
    );
};
const err_log = (msg) => {
  console.error(
    color.redBright(`[${new Date().toLocaleString()}] ERROR: ${msg_trimmer(msg)}`)
  );
};
const warn = (msg) => {
  console.log(
    color.yellowBright(`[${new Date().toLocaleString()}] WARN: ${msg}`)
  );
};
const trace = (msg) => {
  if (cached_log_level[1])
    console.log(
      color.cyanBright(`[${new Date().toLocaleString()}] TRACE: ${msg}`)
    );
};

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
    info("Connection to server has been established successfully");
  });
} catch (error) {
  err_log(`Unable to connect to the server: ${error}`);
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
  .then(() => {
    info(
      "video_list and playlist_list tables exist or are created successfully"
    );
    // Making the unlisted playlist
    playlist_list.findOrCreate({
      where: { playlist_url: "None" },
      defaults: {
        title: "None",
        monitoring_type: "N/A",
        save_dir: "",
        playlist_index: -1,
      },
    });
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
async function extract_json(req) {
  return new Promise((resolve, reject) => {
    var body = "";
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
async function string_slicer(str, len) {
  if (str.length > len) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return decoder.decode(encoder.encode(str.slice(0, len)));
  }
  return str;
}
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
  return body_url;
}
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
    var response = "";
    yt_list.stdout.on("data", (data) => {
      response += data;
    });
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
    //debug(JSON.stringify(last_item));
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
      // debug(
      //   `found item: ${JSON.stringify(
      //     foundItem
      //   )} for url: ${vid_url}`
      // );
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
      // debug(
      //   `found item: ${JSON.stringify(
      //     foundItem
      //   )} for url: ${vid_url} and playlist_url ${playlist_url}`
      // );
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
  // }
  // else {
  //   debug("Doing full update on playlist");
  // }

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
          // debug("Result of video add " + JSON.stringify([foundVid, createdVid]));
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
          // debug("Result of video_playlist_index add " + JSON.stringify([foundJunction, createdJunction]));
          if (!createdJunction) {
            debug(`Found video_indexer: ${JSON.stringify(foundJunction)}`);
          }
        }
      } catch (error) {
        err_log(`${error.message}\n${error.stack}`);
      } finally {
        init_resp["count"]++;
      }
    })
  );
  return init_resp;
}
async function update_vid_entry(found, data) {
  // The object was found and not created
  // Does not change the downloaded state
  // I have a sneaking suspicion that this
  // will fail when there is any real change
  // in the video, lets see when that happens
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
async function sleep(sleep_seconds = sleep_time) {
  debug("Sleeping for " + sleep_seconds + " seconds");
  return new Promise((resolve) => setTimeout(resolve, sleep_seconds * 1000));
}
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
      lastPasswordChange: user.updatedAt
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
    var foundUserUpdatedAt = foundUser.updatedAt.toISOString(); // Convert to UTC ISO string
    if (foundUserUpdatedAt !== decoded.lastPasswordChange) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);
      foundUserUpdatedAt = foundUser.updatedAt.toISOString();
      // Logging the re-fetched user data
      debug(`foundUser.updatedAt: ${foundUserUpdatedAt}`);
      debug(`decoded.lastPasswordChange: ${decoded.lastPasswordChange}`);
      // Checking again
      if (foundUserUpdatedAt !== decoded.lastPasswordChange) {
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
    if (foundUserUpdatedAt !== decoded.lastPasswordChange) {
      debug(`Checking the database for a user with id ${decoded.id}`);
      foundUser = await users.findByPk(decoded.id);
      user_cache.set(decoded.id, foundUser);

      // Update timestamp
      const updatedFoundUserUpdatedAt = foundUser.updatedAt.toISOString();

      // Checking again
      if (updatedFoundUserUpdatedAt !== decoded.lastPasswordChange) {
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
  const ipAddress = req.connection.remoteAddress;
  debug(`incoming request from ${ipAddress}`);
  if (ip_cache.get(ipAddress) >= max_requests_per_ip_in_stdTTL) {
    debug(`rate limit ${ipAddress}`);
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
      expiry_time = body["expiry_time"] || "1d";
    verbose(`Token expires in ${expiry_time}`);
    const foundUser = await users.findOne({
      where: { user_name: user_name },
    });
    verbose(`Found user ${JSON.stringify(foundUser)}`)
    if (foundUser === null) {
      res.writeHead(404, corsHeaders(json_t));
      res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
    } else {
      const passwordMatch = await bcrypt.compare(body_password, foundUser.password);
      if (!passwordMatch) {
        res.writeHead(401, corsHeaders(json_t));
        return res.end(JSON.stringify({ Outcome: "Username or password invalid" }));
      }
      const token = generate_token(foundUser, expiry_time);
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

async function quick_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: "Fast",
    },
  });

  trace(`Fast updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    var index = -chunk_size_env + 1;
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
async function full_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: "Full",
    },
  });
  trace(`Full updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    try {
      trace(
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
      trace(`Done processing playlist ${playlist.playlist_url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err_log(
        `error processing playlist ${playlist.playlist_url}\n${error.message}`
      );
    }
  }
}

// Download functions
async function download_lister(body, res) {
  try {
    const download_list = [],
      in_download_list = new Set(),
      // remember to send this from the frontend
      play_list_url = body["url"] !== undefined ? body["url"] : "None";
    for (const id_str of body["id"]) {
      if (!in_download_list.has(id_str)) {
        debug(id_str);
        const video_item = await video_list.findOne({
          where: { video_id: id_str },
        });
        var save_dir = "";
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
        debug(save_dir);
        download_list.push([
          video_item.video_url,
          video_item.title,
          save_dir,
          id_str,
        ]);
        in_download_list.add(id_str);
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
  var count = 1;
  for (const [url_str, title, save_dir, id_str] of items) {
    try {
      // yeah, this needs a join too from the playlists now to get the save directory and stuff
      trace(`Downloading Video: ${count++}, Url: ${url_str}, Progress:`);
      var hold = null;
      // check if the trim is actually necessary
      debug(save_dir);
      const save_path = path_fs.join(save_location, save_dir.trim());
      // if save_dir == "",  then save_path == save_location
      if (save_path != save_location && !fs.existsSync(save_path)) {
        fs.mkdirSync(save_path, { recursive: true });
      }
      sock.emit("download-start", { message: "" });
      const yt_dlp = spawn("yt-dlp", options.concat([save_path, url_str]));
      yt_dlp.stdout.on("data", async (data) => {
        try {
          // Keeping these just so it can be used to maybe add a progress bar
          const percentage = +/(\d{1,3}\.\d)/.exec(`${data}`)[0];
          if (percentage !== null) {
            if (Math.floor(percentage / 10) == 0 && hold === null) {
              hold = 0;
              trace(`${data}`);
            } else if (Math.floor(percentage / 10) > hold) {
              hold = Math.floor(percentage / 10);
              trace(`${data}`);
            }
            sock.emit("listing-or-downloading", { percentage: percentage });
          }
        } catch (error) {
          // this is done so that the toasts do not go crazy
          if (!error instanceof TypeError) {
            sock.emit("error", { message: `${error}` });
          }
        }
      });
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
          entity.set({
            downloaded: true,
          });
          await entity.save();
          sock.emit("download-done", {
            message: `${entity.title}`,
            id: id_str,
          });
        } else {
          sock.emit("download-failed", {
            message: `${entity.title}`,
            id: id_str,
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
async function list_func(body, res) {
  try {
    const start_num = body["start"] !== undefined ?
      +body["start"] === 0 ? 1 : +body["start"] : 1,
      chunk_size = +body["chunk_size"] >= +chunk_size_env ? +body["chunk_size"] : +chunk_size_env,
      stop_num = +chunk_size + 1,
      sleep_before_listing = body["sleep"] !== undefined ? body["sleep"] : false,
      monitoring_type = body["monitoring_type"] !== undefined ? body["monitoring_type"] : "N/A";
    //verbose(`body: ${JSON.stringify(body)}`);
    //verbose(`start_num: ${start_num}, stop_num: ${stop_num}, chunk_size: ${chunk_size}, sleep_before_listing: ${sleep_before_listing}, monitoring_type: ${monitoring_type}`);
    var play_list_index = -1,
      already_indexed = false;
    if (body["url"] === undefined) {
      throw new Error("url is required");
    }
    var body_url = body["url"],
      last_item_index = start_num > 0 ? start_num - 1 : 0; // index must start from 0 so start_num needs to subtracted by 1
    //debug(`payload: ${JSON.stringify(body)}`);
    trace(
      `list_func:  body_url: ${body_url}, start_num: ${start_num}, index: ${last_item_index}, ` +
      `stop_num: ${stop_num}, chunk_size: ${chunk_size}, ` +
      `sleep_before_listing: ${sleep_before_listing}, monitoring_type: ${monitoring_type}`
    );
    body_url = fix_common_errors(body_url);
    if (sleep_before_listing) { await sleep(); }
    const response_list = await list_spawner(body_url, start_num, stop_num);
    debug(
      `response_list:\t${JSON.stringify(
        response_list,
        null,
        2
      )}, response_list.length: ${response_list.length}`
    );
    // Checking if the response qualifies as a playlist
    const play_list_exists = new Promise(async (resolve, reject) => {
      if (response_list.length > 1 || playlistRegex.test(body_url)) {
        const is_already_indexed = await playlist_list.findOne({
          where: { playlist_url: body_url },
        });
        try {
          trace(
            `Playlist: ${is_already_indexed.title.trim()} is indexed at ${is_already_indexed.playlist_index}`
          );
          already_indexed = true;
          // Now that this is obtained setting the playlist index in front end is do able only need to figure out how
          play_list_index = is_already_indexed.playlist_index;
          resolve(last_item_index);
        } catch (error) {
          err_log(
            "playlist or channel not encountered earlier, saving in playlist"
          );
          // Its not an error, but the title extraction,
          // will only be done once the error is raised
          // then is used to find the index of the previous playlist
          await add_playlist(body_url, monitoring_type)
            .then(() =>
              playlist_list.findOne({
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
        try {
          body_url = "None";
          // If the url is determined to be an unlisted video
          // (i.e: not belonging to a playlist)
          // then the last unlisted video index is used to increment over.
          const video_already_unlisted = await video_indexer.findOne({
            where: {
              video_url: response_list[0].split("\t")[2],
              playlist_url: body_url,
            },
          });
          debug(
            JSON.stringify(response_list) +
            "\n " +
            response_list[0].split("\t")[2] +
            "\n " +
            JSON.stringify(video_already_unlisted)
          );
          if (video_already_unlisted !== null) {
            debug("Video already saved as unlisted");
            reject(video_already_unlisted);
          } else {
            debug("Adding a new video to the unlisted videos list");
            const last_item = await video_indexer.findOne({
              where: {
                playlist_url: body_url,
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
          res.writeHead(status, corsHeaders(json_t));
          res.end(JSON.stringify({ error: error.message }));
          sock.emit("playlist-done", {
            message: "done processing playlist or channel",
            id: body_url === "None" ? body["url"] : body_url,
          });
        }
      }
    });
    await play_list_exists.then(
      (last_item_index) => {
        // debug("last_item_index: " + last_item_index);
        process_response(response_list, body_url, last_item_index, false)
          .then((init_resp) => {
            try {
              init_resp["prev_playlist_index"] = play_list_index + 1;
              init_resp["already_indexed"] = already_indexed;
              res.writeHead(200, corsHeaders(json_t));
              res.end(JSON.stringify(init_resp));
            } catch (error) {
              err_log(`${error.message}`);
            }
          })
          .then(() => {
            list_background(
              body_url,
              start_num,
              stop_num,
              chunk_size,
              true
            ).then(() => {
              trace(`Done processing playlist: ${body_url}`);
              sock.emit("playlist-done", {
                message: "done processing playlist or channel",
                id: body_url === "None" ? body["url"] : body_url,
              });
            });
          });
      },
      (video_already_unlisted) => {
        trace("Video already saved as unlisted");
        try {
          res.writeHead(200, corsHeaders(json_t));
          res.end(
            JSON.stringify({
              message: "Video already saved as unlisted",
              count: 1,
              resp_url: body_url,
              start: video_already_unlisted.index_in_playlist,
            })
          );
          sock.emit("playlist-done", {
            message: "done processing playlist or channel",
            id: body_url === "None" ? body["url"] : body_url,
          });
        } catch (error) {
          err_log(`${error.message}`);
        }
      }
    );
  } catch (error) {
    err_log(`${error.message}`);
    console.error(error.stack);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
    sock.emit("playlist-done", {
      message: "done processing playlist or channel",
      id: body_url === "None" ? body["url"] : body_url,
    });
  }
}
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
async function list_background(
  body_url,
  start_num,
  stop_num,
  chunk_size,
  is_update_operation
) {
  // yes a playlist on youtube atleast can only be 5000 long  && stop_num < 5000
  // var max_size = 5000;
  // var loop_num = max_size / chunk_size;
  var count = 0;
  while (body_url != "None") {
    start_num = start_num + chunk_size;
    stop_num = stop_num + chunk_size;
    // ideally we can set it to zero but that would get us rate limited by the services
    trace(
      `list_background: URL: ${body_url}, Chunk: ${chunk_size},` +
      `Start: ${start_num}, Stop: ${stop_num}, Iteration: ${count}`
    );
    await sleep();
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
async function add_playlist(url_var, monitoring_type_var) {
  var title_str = "",
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

// List function that send data to frontend
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
          res.end(JSON.stringify(result, null, 2));
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
          res.end(JSON.stringify(result, null, 2));
        });
    }
  } catch (error) {
    err_log(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function sublist_to_table(body, res) {
  try {
    const playlist_url = body["url"] !== undefined ? body["url"] : "None",
      start_num = body["start"] !== undefined ? +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? body["stop"] : chunk_size_env,
      query_string = body["query"] !== undefined ? body["query"] : "",
      sort_downloaded =
        body["sortDownloaded"] !== undefined ? body["sortDownloaded"] : false,
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
            res.end(JSON.stringify(result, null, 2));
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
            res.end(JSON.stringify(result, null, 2));
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
const html = "text/html; charset=utf-8";
const corsHeaders = (type) => {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": 2592000,
    "Content-Type": type,
  };
};

const types = {
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

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
    console.error("Error reading secret files:", error);
    process.exit(1);
  }
}

const server = http.createServer(server_options, (req, res) => {
  if (req.url.startsWith(url_base) && req.method === "GET") {
    try {
      const get = req.url; //.replace(url_base, "");
      res.writeHead(200, corsHeaders(staticAssets[get].type));
      res.write(staticAssets[get].file);
    } catch (error) {
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
  } else if (req.url === url_base + "/register" && req.method === "POST") {
    //register(req, res);
    rate_limiter(req, res, register, (req, res, next) => next(req, res),
      max_requests_per_ip_in_stdTTL, global_stdTTL);
  } else if (req.url === url_base + "/login" && req.method === "POST") {
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

const MAX_CLIENTS = 10;
var connectedClients = 0;
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
    `Download Options:\n\tyt-dlp ${options.join(" ")} "${save_location.endsWith("/") ? save_location : save_location + "/"
    }{playlist_dir}" "{url}"`
  );
  verbose(
    `List Options:\n\t` +
    "yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
    `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {body_url}`
  );
  job.start();
});
