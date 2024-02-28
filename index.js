"use strict";
const { Sequelize, DataTypes, Op } = require("sequelize");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const color = require("cli-color");
const CronJob = require("cron").CronJob;
const fs = require("fs");
const http = require("http");
const path_fs = require("path");

const { Server } = require("socket.io");

const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = +process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || "localhost";
const db_user = process.env.db_user || "ytdiff";
const db_pass = process.env.db_password_file
  ? fs.readFileSync(process.env.db_password_file, "utf8").trim()
  : process.env.db_password && process.env.db_password.trim()
    ? process.env.db_password
    : "ytd1ff"; // Do remember to change this
const save_loc = process.env.save_loc || "/home/sagnik/Videos/yt-dlp/";
const sleep_time = process.env.sleep ?? 3; // Will accept zero seconds, not recommended though.
const chunk_size_env = +process.env.chunk_size_env || 10; // From my research, this is what youtube uses
const scheduled_update_string = process.env.scheduled || "*/5 * * * *";
// "0 */1 * * *";
//"0 */12 * * *"; // Default: Every 12 hours
const time_zone = process.env.time_zone || "Asia/Kolkata";

const get_subs = process.env.subtitles !== "false";
const get_description = process.env.description !== "false";
const get_comments = process.env.comments !== "false";
const get_thumbnail = process.env.thumbnail !== "false";

const MAX_LENGTH = 255; // this is what sequelize used for postgres
const not_needed = ["", "pornstar", "model", "videos"];
const playlistRegex = /(?:playlist|list=)\b/i;
// spankbang lists playlists as playlist/1,2 so need to add a way to integrate it
const options = [
  "--embed-metadata",
  get_subs ? "--write-subs" : "",
  get_subs ? "--write-auto-subs" : "",
  get_description ? "--write-description" : "",
  get_comments ? "--write-comments" : "",
  get_thumbnail ? "--write-thumbnail" : "",
  "--paths",
].filter(Boolean);

// Logging methods
const msg_trimmer = (msg) => {
  try {
    return msg.trim();
  } catch (error) {
    return msg;
  }
};
const info = (msg) => {
  console.log(
    color.blueBright(`[${new Date().toLocaleString()}] INFO: ${msg}\n`)
  );
};
const verbose = (msg) => {
  console.log(
    color.greenBright(`[${new Date().toLocaleString()}] VERBOSE: ${msg}\n`)
  );
};
const debug = (msg) => {
  console.log(
    color.magentaBright(`[${new Date().toLocaleString()}] DEBUG: ${msg}\n`)
  );
};
const err_log = (msg) => {
  console.log(
    color.redBright(`[${new Date().toLocaleString()}] ERROR: ${msg}\n`)
  );
};
const warn = (msg) => {
  console.log(
    color.yellowBright(`[${new Date().toLocaleString()}] WARN: ${msg}\n`)
  );
};
const trace = (msg) => {
  console.log(
    color.cyanBright(`[${new Date().toLocaleString()}] TRACE: ${msg}\n`)
  );
};

if (!fs.existsSync(save_loc)) {
  fs.mkdirSync(save_loc, { recursive: true });
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
    type: DataTypes.SMALLINT,
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

// Define the relationships
video_indexer.belongsTo(video_list, {
  foreignKey: "video_url",
});
video_list.hasMany(video_indexer, {
  foreignKey: "video_url",
});

//Define the hook on the video_indexer model
// video_indexer.addHook("beforeCreate", async (videoIndexer, options) => {
//   try {
//     verbose(`videoIndexer: ${videoIndexer}`);
//     // Find the maximum index_in_playlist for the given playlist_url
//     const maxIndex = await video_indexer.max("index_in_playlist",{
//       where: { playlist_url: videoIndexer.playlist_url }
//     });

//     // If there are existing videos in the playlist, increment the index by 1
//     if (maxIndex !== null) {
//       videoIndexer.index_in_playlist = maxIndex + 1;
//     } else {
//       // If no videos exist in the playlist, set index to 0
//       videoIndexer.index_in_playlist = 0;
//     }
//     verbose("Setting index to " + videoIndexer.index_in_play);
//   } catch (error) {
//     err_log("Error updating index_in_playlist:", error);
//     throw error;
//   }
// });

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
        monitoring_type: 1,
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
  // if (is_update_operation) {
  // Query to check if all items already exist in the video_list table
  const allItemsExistInVideoList = await Promise.all(
    response.map(async (element) => {
      const element_arr = element.split("\t");
      const vid_url = element_arr[2];
      const foundItem = await video_list.findOne({
        where: { video_url: vid_url },
      });
      debug(`found item: ${JSON.stringify(foundItem)} for url: ${vid_url}`);
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
        )} for url: ${vid_url} and playlist_url ${playlist_url}`
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
    debug(`allItemsExistInVideoList: ${JSON.stringify(
      allItemsExistInVideoList
    )}\n
      allItemsExistInVideoIndexer: ${JSON.stringify(
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
        const element_arr = element.split("\t");
        debug(`element_arr: ${element_arr}`);
        var title = element_arr[0].trim(),
          item_available = true;
        const [vid_id, vid_url, vid_size_temp] = element_arr.slice(1);
        const vid_size = vid_size_temp === "NA" ? -1 : vid_size_temp;
        if (
          title === "[Deleted video]" ||
          title === "[Private video]" ||
          title === "[Unavailable video]"
        ) {
          item_available = false;
        } else if (title === "NA") {
          title = vid_id.trim();
        }
        // Title is processed here
        const title_processed = await string_slicer(title, MAX_LENGTH);
        try {
          if (allItemsExistInVideoList[map_idx] === false) {
            // its pre-incrementing index here so in the listers it starts from 0
            const vid_data = {
              video_id: vid_id,
              title: title_processed,
              approximate_size: vid_size,
              downloaded: false,
              available: item_available,
            };
            //debug(JSON.stringify(vid_data));
            const [foundVid, createdVid] = await video_list.findOrCreate({
              where: { video_url: vid_url },
              defaults: vid_data,
            });
            debug(
              "Result of video add " + JSON.stringify([foundVid, createdVid])
            );
            if (!createdVid) {
              update_vid_entry(foundVid, vid_data);
            }
          }
          if (allItemsExistInVideoIndexer[map_idx] === false) {
            const junction_data = {
              video_url: vid_url,
              playlist_url: body_url,
              index_in_playlist: index + map_idx,
            };
            debug(JSON.stringify(junction_data));
            const [foundJunction, createdJunction] =
              await video_indexer.findOrCreate({
                // I am not sure but I think this is getting updated before
                // it is saved if I make and pass it as an object
                where: junction_data,
              });
            debug(
              "Result of video_playlist_index add " +
              JSON.stringify([foundJunction, createdJunction])
            );
            if (!createdJunction) {
              // this seems like a good place to mention that
              // I should check the update functions too
              verbose(`Found video_indexer: ${JSON.stringify(foundJunction)}`);
            }
          }
        } catch (error) {
          err_log(`${error.message}\n${error.stack}`);
        }
        init_resp["count"]++;
      } catch (error) {
        err_log(`${error.message}\n${error.stack}`);
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
    verbose("This property does not need modification");
  }
}
async function sleep(sleep_seconds = sleep_time) {
  debug("Sleeping for " + sleep_seconds + " seconds");
  return new Promise((resolve) => setTimeout(resolve, sleep_seconds * 1000));
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
      monitoring_type: 3,
    },
  });
  /*
  The quick_updates logic is wrong, because in order to fetch the newest
  videos we need to just fetch the videos from 0 through to the chunk_size
  once all the videos that we have fetched are already in the database
  then it can stop, this function will need to be rewritten and tested.
  */
  trace(`Fast updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    var index = -chunk_size_env + 1;
    /*const last_item = await video_indexer.findOne({
      where: {
        playlist_url: playlist.playlist_url,
      },
      order: [["index_in_playlist", "DESC"]],
      attributes: ["index_in_playlist"],
      limit: 1,
    });*/
    try {
      /*trace(
        `Playlist: ${playlist.title.trim()} being updated from index ${
          last_item.index_in_playlist
        }`
      );
      index = last_item.index_in_playlist;*/

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
      monitoring_type: 2,
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
async function download_lister(req, res) {
  try {
    const body = await extract_json(req),
      download_list = [],
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
      const save_path = path_fs.join(save_loc, save_dir.trim());
      // if save_dir == "",  then save_path == save_loc
      if (save_path != save_loc && !fs.existsSync(save_path)) {
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
async function list_func(req, res) {
  try {
    const body = await extract_json(req),
      start_num =
        body["start"] !== undefined
          ? +body["start"] === 0
            ? 1
            : +body["start"]
          : 1,
      // The chunk size is sent from the frontend as it is the
      // number of videos requested for the initial request
      // The rest of the program uses the environment values
      // If not specified environment variable will be used to determine the chunk size
      // chunk_size = body["chunk"] !== undefined ? +body["chunk"] : +chunk_size_env,
      // // Setting this after chunk_size is determined is the right thing to do
      // stop_num = body["stop"] !== undefined ? +body["stop"] : +chunk_size,
      chunk_size = +chunk_size_env,
      stop_num = +chunk_size,
      sleep_before_listing =
        body["sleep"] !== undefined ? body["sleep"] : false,
      monitoring_type =
        body["monitoring_type"] !== undefined ? body["monitoring_type"] : 1;
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
    if (sleep_before_listing) await sleep();
    // looking up if the playlist or video is already indexed is a pain
    const response_list = await list_spawner(body_url, start_num, stop_num);
    verbose(
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
          is_already_indexed.title.trim();
          trace(
            `Playlist: ${is_already_indexed.title} is indexed at ${is_already_indexed.playlist_index}`
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
          // Although it does not really matter if a video is added many times, to the unlisted "None" playlist
          // I think it should not be done, so add a check here to find out if it is being added multiple times.
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
            debug(JSON.stringify(last_item));
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
        debug("last_item_index: " + last_item_index);
        process_response(response_list, body_url, last_item_index, false)
          .then(function (init_resp) {
            try {
              init_resp["prev_playlist_index"] = play_list_index + 1;
              init_resp["already_indexed"] = already_indexed;
              res.writeHead(200, corsHeaders(json_t));
              res.end(JSON.stringify(init_resp));
            } catch (error) {
              err_log(`${error.message}`);
            }
          })
          .then(function () {
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
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
    sock.emit("playlist-done", {
      message: "done processing playlist or channel",
      id: body_url === "None" ? body["url"] : body_url,
    });
  }
}
async function monitoring_type_func(req, res) {
  try {
    const body = await extract_json(req),
      body_url = body["url"],
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
async function playlists_to_table(req, res) {
  try {
    const body = await extract_json(req),
      start_num = body["start"] !== undefined ? +body["start"] : 0,
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
async function sublist_to_table(req, res) {
  try {
    const body = await extract_json(req),
      playlist_url = body["url"] !== undefined ? body["url"] : "None",
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
const server_options = protocol === "http" ? {} : {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("certificate.pem")
};

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
    list_func(req, res);
  } else if (req.url === url_base + "/download" && req.method === "POST") {
    download_lister(req, res);
  } else if (req.url === url_base + "/watch" && req.method === "POST") {
    monitoring_type_func(req, res);
  } else if (req.url === url_base + "/getplay" && req.method === "POST") {
    playlists_to_table(req, res);
  } else if (req.url === url_base + "/getsub" && req.method === "POST") {
    sublist_to_table(req, res);
  } else {
    res.writeHead(404, corsHeaders(html));
    res.write("Not Found");
    res.end();
  }
});

const io = new Server(server, {
  path: url_base + "/socket.io/",
  cors: {
    origin: [
      "https://ideapad.tail9ece4.ts.net",
      "http://localhost:5173",
      "http://192.168.0.103:5173",
      "http://192.168.0.106:5173",
      "http://localhost:8888",
      "http://192.168.0.103:8888",
      "http://192.168.0.106:8888",
    ],
  },
});

const clientConnected = ({ data, id }) => {
  info(`${data} to client id ${id}`);
};
const sock = io.on("connection", (socket) => {
  socket.emit("init", { message: "Connected", id: socket.id });
  socket.on("acknowledge", clientConnected);
  return socket;
});

server.listen(port, async () => {
  if (process.env.hide_ports === "true") {
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
    `Download Options:\n\tyt-dlp ${options.join(" ")} "${save_loc.endsWith("/") ? save_loc : save_loc + "/"
    }{playlist_dir}" "{url}"`
  );
  verbose(
    `List Options:\n\t` +
    "yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist " +
    `--print "%(title)s\\t%(id)s\\t%(webpage_url)s\\t%(filesize_approx)s" {body_url}`
  );
  job.start();
});
