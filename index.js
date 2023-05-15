"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path_fs = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { Server } = require("socket.io");
const CronJob = require("cron").CronJob;
const color = require("cli-color");
const { v4: uuidv4 } = require("uuid");

const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || "localhost";
const save_loc = process.env.save_loc || "/home/sagnik/Videos/yt-dlp/";
const sleep_time = process.env.sleep ?? 3; // Will accept zero seconds, not recommended though.
const scheduled_update_string = process.env.scheduled || "0 */12 * * *"; // Default: Every 12 hours
const time_zone = process.env.time_zone || "Asia/Kolkata";

const get_subs = process.env.subtitles !== "false";
const get_description = process.env.description !== "false";
const get_comments = process.env.comments !== "false";
const get_thumbnail = process.env.thumbnail !== "false";

const MAX_LENGTH = 255; // this is what sequelize used for postgres
const not_needed = ["", "pornstar", "model", "videos"];
// spankbang lists playlits as playlist/1,2 so need to add a way to integarte it
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
const info = (msg) => {
  console.log(
    color.blueBright(`[${new Date().toLocaleString()}] INFO: ${msg}\n`)
  );
};
const verbose = (msg) => {
  console.log(
    color.greenBright(
      `[${new Date().toLocaleString()}] VERBOSE: ${msg}\n`
    )
  );
};
const debug = (msg) => {
  console.log(
    color.magentaBright(
      `[${new Date().toLocaleString()}] DEBUG: ${msg}\n`
    )
  );
};
const err = (msg) => {
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
  logging: true,
  username: "ytdiff",
  password: "ytd1ff",
  database: "vidlist",
});

try {
  sequelize.authenticate().then(() => {
    info("Connection to server has been established successfully");
  });
} catch (error) {
  err(`Unable to connect to the server: ${error}`);
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
  /* putting these here works only if each video belongs to one and only one playlist,
  else there will be multiple instances of the same video belonnging to different playlist 
  that have different available and downloaded statuses
  playlist_url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  index_in_playlist: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },*/
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
  // this is the order in which the playlists are added not the vidoes
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

/*  video_url is the forign keys from video_list, 
    playlist_url is forign key from playlist_list

    The plan here is to make a way such that a video can have a video associated with
    multiple playlist_url and index_in_playlist for that given playlist_url  
    
    This is a junction table
*/
const playlist_video_indexer = sequelize.define(
  "playlist_video_indexer",
  {
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
      // references: {
      //   model: video_list,
      //   key: "video_url",
      // },
      // onUpdate: "CASCADE",
      // onDelete: "CASCADE",
    },
    // linked to the primary key of the playlist_list
    playlist_url: {
      type: DataTypes.STRING,
      allowNull: false,
      // references: {
      //   model: playlist_list,
      //   key: "playlist_url",
      // },
      // onUpdate: "CASCADE",
      // onDelete: "CASCADE",
    },
    /*
    index_in_playlist exists to provide order to the relation of  video primary key with a playlist primary key.
    if index_in_playlist were added to the video_list table there would be a ton of duplicates of the
    video in the table each having different playlist url and indexes, this table seems like a good compromise
    */
    index_in_playlist: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    /*
    The same video can appear in multiple playlists, and can appear multiple times in the same playlist so the 
    only way to get an index is through the below 
    */
    indexes: [
      {
        unique: true,
        fields: ["video_url", "playlist_url", "index_in_playlist"],
        name: 'unique_playlist_video_index'
      },
    ],
  }
);

// Define the foreign key constraints
playlist_video_indexer.belongsTo(playlist_list, { foreignKey: 'playlist_url', onUpdate: 'CASCADE', onDelete: 'CASCADE' });
playlist_video_indexer.belongsTo(video_list, { foreignKey: 'video_url', onUpdate: 'CASCADE', onDelete: 'CASCADE' });


sequelize
  .sync()
  .then(() => {
    info(
      "video_list and playlist_list tables exist or are created successfully"
    );
  })
  .catch((error) => {
    err(`Unable to create table : ${error}`);
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
    err(`${error.message}`);
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
    debug(`${body_url} is a youtube channel`);
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
      err(`stderr: ${data}`);
    });
    yt_list.on("error", (error) => {
      err(`${error.message}`);
    });
    yt_list.on("close", (code) => {
      if (code !== 0) {
        err(`yt-dlp returned code: ${code}`);
      }
      resolve(response.split("\n").filter((line) => line.length > 0));
    });
  });
}
async function process_response(response, body_url, index) {
  // I forgot why but this index--; makes the whole thing work okey
  if (body_url !== "None") {
    index--;
  }
  trace(`process_response: Index: ${index}, Url: ${body_url}`);
  const init_resp = { count: 0, resp_url: body_url, start: index };
  sock.emit("listing-or-downloading", { percentage: 101 });
  await Promise.all(
    response.map(async (element) => {
      const element_arr = element.split("\t");
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
        //debug(JSON.stringify([foundVid, createdVid]));
        if (!createdVid) {
          update_vid_entry(foundVid, vid_data);
        }
        const junction_data = {
          video_url: vid_url,
          playlist_url: body_url,
          index_in_playlist: ++index
        };
        debug(JSON.stringify(junction_data));
        const [foundJunc, createdJunc] =
          await playlist_video_indexer.findOrCreate({
            where: junction_data
          });
        debug(JSON.stringify([foundJunc, createdJunc]))
        if (!createdJunc) {
          verbose(`Found junc_table_entry: ${JSON.stringify(foundJunc)}`);
        }
        init_resp["count"]++;
      } catch (error) {
        err(`${error.stack}`);
      }
    })
  );
  return init_resp;
}
async function update_vid_entry(found, data) {
  // The object was found and not created
  // Doesn't change the downloaded state
  // I have a sneaking suspecion that this
  // will fail when there is any real change
  // in the video, lets see when that happens
  if (
    found.video_id !== data.video_id ||
    found.approximate_size !== data.approximate_size ||
    found.title !== data.title ||
    found.available !== data.available
  ) {
    const differences = [];
    if (found.id !== data.id) {
      differences.push(`id: ${found.id} (found) vs. ${data.id} (expected)`);
    }
    if (found.approximate_size !== data.approximate_size) {
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
    found.approximate_size = data.approximate_size;
    found.title = data.title;
    found.available = data.available;
    await found.save();
  } else if (found.downloaded !== data.downloaded) {
    verbose("This proprty doesn't need modification");
  }
}
async function sleep(sleep_seconds = sleep_time) {
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
  trace(`Updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    var index = 0;
    const last_item = await playlist_video_indexer.findOne({
      where: {
        playlist_url: playlist.url,
      },
      order: [["index_in_playlist", "DESC"]],
      attributes: ["index_in_playlist"],
      limit: 1,
    });
    try {
      trace(
        `Playlist: ${playlist.title.trim()} being updated from index ${last_item.index_in_playlist
        }`
      );
      index = last_item.index_in_playlist;

      await sleep();
      await list_background(playlist.url, index, index + 10, 10);
      trace(`Done processing playlist ${playlist.url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err(`error processing playlist ${playlist.url}, ${error.message}`);
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
  trace(`Updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    try {
      trace(`Playlist: ${playlist.title.trim()} being updated fully`);

      await sleep();
      await list_background(playlist.url, 0, 10, 10);
      trace(`Done processing playlist ${playlist.url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err(`error processing playlist ${playlist.url}\n${error.message}`);
    }
  }
}

// Download functions
async function download_lister(req, res) {
  try {
    const body = await extract_json(req),
      download_list = [],
      // remember to send this from the frontend
      play_list_url =
        body["reference"] !== undefined ? body["reference"] : "None";
    for (const id_str of body["id"]) {
      const video_item = await video_list.findOne({
        where: { video_id: id_str },
      });
      var save_dir = "";
      try {
        const play_list = await playlist_list.findOne({
          where: { url: play_list_url },
        });
        save_dir = play_list.save_dir;
      } catch (error) {
        if (save_dir !== "") err(`${error.message}`);
      }
      download_list.push([video_item.url, video_item.title, save_dir, id_str]);
    }
    download_sequential(download_list);
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify({ Downloading: download_list }));
  } catch (error) {
    err(`${error.message}`);
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
      trace(`Downloading Video: ${count++}, Url: ${url_str}, Progress:`);
      var hold = null;
      // check if the trim is actually necessary
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
          // this is done so that the toasts don't go crazy
          if (!error instanceof TypeError) {
            sock.emit("error", { message: `${error}` });
          }
        }
      });
      yt_dlp.stderr.on("data", (data) => {
        err(`stderr: ${data}`);
      });
      yt_dlp.on("error", (error) => {
        err(`${error.message}`);
      });
      yt_dlp.on("close", async (code) => {
        const entity = await video_list.findOne({ where: { url: url_str } });
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
      err(`${error.message}`);
    }
  }
}

// List functions
async function list_and_download(req, res) {
  try {
    const body = await extract_json(req),
      start_num = body["start"] !== undefined ? (+body["start"] === 0 ? 1 : +body["start"]) : 1,
      stop_num = body["stop"] !== undefined ? +body["stop"] : 10,
      chunk_size = body["chunk"] !== undefined ? +body["chunk"] : 10,
      sleep_before_listing =
        body["continuous"] !== undefined ? body["continuous"] : false,
      monitoring_type =
        body["monitoring_type"] !== undefined ? body["monitoring_type"] : 1,
      download_list = body["download"] !== undefined ? body["download"] : null,
      dnld_list = [];
    if (body["url"] === undefined) {
      throw new Error("url is required");
    }
    var body_url = body["url"],
      last_item_index = start_num > 0 ? start_num - 1 : 0; // index must start from 0 so start_num needs to subtracted by 1
    //debug(`payload: ${JSON.stringify(body)}`);
    trace(
      `list_and_download:  body_url: ${body_url}, start_num: ${start_num}, ` +
      `stop_num: ${stop_num}, chunk_size: ${chunk_size}, download_list: [${download_list}], ` +
      `sleep_before_listing: ${sleep_before_listing}, index: ${last_item_index}, monitoring_type: ${monitoring_type}`
    );
    body_url = fix_common_errors(body_url);
    if (sleep_before_listing) await sleep();
    // honest looking up if the playlist or video is already indexed is a pain
    const response_list = await list_spawner(body_url, start_num, stop_num);
    verbose(
      `response_list:\t${JSON.stringify(
        response_list,
        null,
        2
      )}, response_list.length: ${response_list.length}`
    );
    if (response_list.length > 1) {
      const is_already_indexed = await playlist_list.findOne({
        where: { playlist_url: body_url },
      });
      try {
        is_already_indexed.title.trim();
      } catch (error) {
        err("playlist or channel not encountered earlier, saving in playlist");
        // Its not an error, but the title extraction,
        // will only be done once the error is raised
        await add_playlist(body_url, monitoring_type);
      }
    } else {
      body_url = "None";
      // If the url is determined to be an unlisted video
      // (i.e: not belonging to a playlist)
      // then the last unlisted video index is used to increment over.
      const last_item = await playlist_video_indexer.findOne({
        where: {
          playlist_url: body_url,
        },
        order: [["index_in_playlist", "DESC"]],
        attributes: ["index_in_playlist"],
        limit: 1,
      });
      try {
        last_item_index = last_item.index_in_playlist;
      } catch (error) {
        // encountered an error if unlisted videos was not initialized
        last_item_index = -1; // it will become 1 in the DB
      }
    }
    process_response(response_list, body_url, last_item_index)
      .then(function (init_resp) {
        try {
          res.writeHead(200, corsHeaders(json_t));
          res.end(JSON.stringify(init_resp));
        } catch (error) {
          err(`${error.message}`);
        }
      })
      .then(function () {
        list_background(body_url, start_num, stop_num, chunk_size).then(() => {
          trace(`Done processing playlist: ${body_url}`);
          sock.emit("playlist-done", {
            message: "done processing playlist or channel",
            id: body_url === "None" ? body["url"] : body_url,
          });
        });
      });
  } catch (error) {
    err(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function monitoring_type_list(req, res) {
  try {
    const body = await extract_json(req),
      body_url = body["url"],
      monitoring_type = body["monitoring_type"];
    if (body["url"] === undefined || body["monitoring_type"] === undefined) {
      throw new Error("url and monitoring_type are required");
    }
    trace(
      `monitoring_type_list:  url: ${body_url}, monitoring_type: ${monitoring_type}`
    );
    const playlist = await playlist_list.findOne({ where: { url: body_url } });
    playlist.monitoring_type = monitoring_type;
    await playlist.update({ monitoring_type }, { silent: true });
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify({ Outcome: "Success" }));
  } catch (error) {
    error(`error in monitoring_type_list: ${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function list_background(body_url, start_num, stop_num, chunk_size) {
  while (true && body_url != "None") {
    start_num = start_num + chunk_size;
    stop_num = stop_num + chunk_size;
    // ideally we can set it to zero but that would get us rate limited by the services
    trace(
      `list_background: URL: ${body_url}, Chunk: ${chunk_size}, Start: ${start_num}, Stop: ${stop_num}`
    );
    await sleep();
    const response = await list_spawner(body_url, start_num, stop_num);
    if (response.length === 0) {
      break;
    }
    // yt-dlp starts counting from 1 for some reason so 1 needs to be subtrated here.
    await process_response(response, body_url, start_num - 1);
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
          err(`${error.message}`);
        }
      }
      title_str = await string_slicer(title_str, MAX_LENGTH);
      // no need to use found or create syntax here as this is only run the first time a playlist is made
      playlist_list.findOrCreate({
        where: { playlist_url: url_var },
        defaults: {
          title: title_str.trim(),
          monitoring_type: monitoring_type_var,
          save_dir: title_str.trim(),
          // this is coming as 0 everytime this needs fixing but I needs sleep
          playlist_index: next_item_index,
        },
      });
    } else {
      err("Playlist could not be created");
    }
  });
}

// List function that send data to frontend
async function playlists_to_table(req, res) {
  try {
    const body = await extract_json(req),
      start_num = body["start"] !== undefined ? +body["start"] : 0,
      stop_num = body["stop"] !== undefined ? +body["stop"] : 10,
      sort_with = body["sort"] !== undefined ? +body["sort"] : 1,
      order = body["order"] !== undefined ? +body["order"] : 1,
      query_string = body["query"] !== undefined ? body["query"] : "",
      type = order == 2 ? "DESC" : "ASC", // 0, 1 it will be ascending else descending
      row = sort_with == 3 ? "updatedAt" : "playlist_index";
    trace(
      `playlists_to_table: Start: ${start_num}, Stop: ${stop_num}, Order: ${order}, Type: ${type}, Query: "${query_string}"`
    );
    if (query_string == "") {
      playlist_list
        .findAndCountAll({
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
    err(`${error.message}`);
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
      stop_num = body["stop"] !== undefined ? body["stop"] : 10,
      query_string = body["query"] !== undefined ? body["query"] : "",
      sort_downloaded =
        body["sortDownloaded"] !== undefined ? body["sortDownloaded"] : false,
      field_to_sort = sort_downloaded ? "downloaded" : "index_in_playlist",
      sort_type = sort_downloaded ? "DESC" : "ASC";
    trace(
      `sublist_to_table:  Start: ${start_num}, Stop: ${stop_num}, ` +
      `Field to sort: ${field_to_sort}, Sort type: ${sort_type}, Query: "${query_string}", ` +
      `playlist_url: ${playlist_url}, sort_downloaded: ${sort_downloaded}`
    );
    try {
      if (query_string == "") {
        playlist_video_indexer
          .findAndCountAll({
            where: {
              playlist_url: playlist_url,
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [[field_to_sort, sort_type]],
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(result, null, 2));
          });
      } else {
        playlist_video_indexer
          .findAndCountAll({
            where: {
              playlist_url: playlist_url,
              title: {
                [Op.iLike]: `%${query_string}%`,
              },
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [[field_to_sort, sort_type]],
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(result, null, 2));
          });
      }
    } catch (error) {
      err(`${error.message}`);
    }
  } catch (error) {
    err(`${error.message}`);
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

const server = http.createServer((req, res) => {
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
    list_and_download(req, res);
  } else if (req.url === url_base + "/download" && req.method === "POST") {
    download_lister(req, res);
  } else if (req.url === url_base + "/watchlist" && req.method === "POST") {
    monitoring_type_list(req, res);
  } else if (req.url === url_base + "/dbi" && req.method === "POST") {
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
      "https://lenovo-ideapad-320-15ikb.tail9ece4.ts.net",
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
  // I don't really know if calling these here is a good idea, but how else can I even do it?
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
    'yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s" {body_url}'
  );
  job.start();
});
