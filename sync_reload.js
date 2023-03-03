"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { Server } = require("socket.io");

const protocol = process.env.protocol || 'http';
const host = process.env.host || 'localhost';
const port = process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || 'localhost';
const save_loc = process.env.save_loc || "yt-dlp";
const sleep_time = process.env.sleep || 3;
const subs_enabled = process.env.subs || true;
var options = ["--embed-metadata", "-P", save_loc]

if (subs_enabled) {
    options = ["--write-subs", "--sleep-subtitles", sleep_time, "--embed-metadata", "-P", save_loc];
}

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
    host: db_host,
    dialect: "postgres",
    logging: false,
});

try {
    sequelize.authenticate().then(() => {
        console.log("Connection has been established successfully.");
    });
} catch (error) {
    console.error("Unable to connect to the database:", error);
}

const vid_list = sequelize.define("vid_list", {
    url: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    id: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true,
    },
    title: {
        type: DataTypes.STRING,
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
    reference: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    list_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
});

const play_lists = sequelize.define("play_lists", {
    title: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true,
    },
    order_added: {
        type: DataTypes.INTEGER,
        allowNull: false,
        autoIncrement: true,
    },
    watch: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    },
    full_update: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    },
});

sequelize.sync().then(() => {
    console.log('vid_list and play_lists tables exist or are created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

async function download_lister(req, res) {
    var body = "";
    req.on("data", async function (data) {
        body += data;
        if (body.length > 1e6) {
            req.connection.destroy();
            res.writeHead(413, { "Content-Type": html });
            res.write("Content Too Large");
            res.end();
        }
    });
    req.on("end", async function () {
        body = JSON.parse(body);
        //console.log(body);
        const response_list = { item: [] };
        for (const id_str of body["id"]) {
            const entry = await vid_list.findOne({ where: { id: id_str } });
            response_list['item'].push([entry.url, entry.title]);
        }
        download_sequential(response_list['item']);
        res.writeHead(200, { "Content-Type": json_t });
        res.end(JSON.stringify(response_list));
    });
}

async function download_sequential(items) {
    //console.log(items);
    for (const [url_str, title] of items) {
        try {
            sock.emit('download-start', { message: title });
            const yt_dlp = spawn("yt-dlp", options.concat(url_str));
            yt_dlp.stdout.on("data", async (data) => {
                try {
                    // Keeing these just so it can be used 
                    // to maybe add a progress bar
                    const percentage = /(\d{1,3}\.\d)%/.exec(`${data}`);
                    if (percentage !== null) {
                        sock.emit("progress", { message: percentage[0] });
                    }
                } catch (error) {
                    sock.emit("error", { message: `${error}` });
                }
            });
            yt_dlp.stderr.on("data", (data) => {
                console.error(`stderr: ${data}`);
            });
            yt_dlp.on("error", (error) => {
                console.error(`error: ${error.message}`);
            });
            yt_dlp.on("close", async (code) => {
                // add the db update here
                if (code == 0) {
                    const entity = await vid_list.findOne({ where: { url: url_str } });
                    entity.set({
                        downloaded: true,
                    });
                    await entity.save();
                    sock.emit("download-done", { message: `${entity.title}` });
                }
            });
            // this holds the for loop, preventing the next iteration from happening
            await new Promise((resolve) => yt_dlp.on("close", resolve));
        } catch (error) {
            console.error(error);
        }
    }
}

// Add a parallel downloader someday

async function list_init(req, res) {
    var body = "",
        init_resp = { count: 0, rows: [] };
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) {
            req.connection.destroy();
            res.writeHead(413, { "Content-Type": html });
            res.write("Content Too Large");
            res.end();
        }
    });
    req.on("end", async function () {
        body = JSON.parse(body);
        //console.log("body_url: " + body["url"], "start_num: " + body["start"], "stop_num:", body["stop"]);
        var body_url = body["url"];
        var start_num = +body["start"] || 1;
        var stop_num = +body["stop"] || 10;
        var index = start_num - 1;
        var chunk_size = +body["chunk"] || 10;
        var watch_var = body["watch"] || false;
        var full_update = body["full_update"] || false;
        const response_list = await ytdlp_spawner(body_url, start_num, stop_num);
        //console.log(response_list, response_list.length);
        if (response_list.length > 1 || body_url.includes("playlist")) {
            let title_str = "";
            if (body_url.includes('youtube') && body_url.includes('/@')) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, '') + '/videos';
                }
                //console.log(`${body_url} is a youtube channel`);
            }
            if (body_url.includes('pornhub') && body_url.includes('/model/')) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, '') + '/videos';
                }
                //console.log('Pornhub channel url: ' + body_url);
            }
            var is_alredy_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_alredy_indexed.changed("updatedAt", true);
                await is_alredy_indexed.save();
                title_str = is_alredy_indexed.title;
            } catch (error) {
                // It's not an error, TBH but the spawn 
                // will only be done once the error is raised
                //console.error("playlist or channel not encountered earlier");
                if (title_str == "") {
                    const get_title = spawn("yt-dlp", [
                        "--playlist-end",
                        1,
                        "--flat-playlist",
                        "--print",
                        "%(playlist_title)s",
                        body_url,
                    ]);
                    get_title.stdout.on("data", async (data) => {
                        title_str += data;
                    });
                    get_title.on("close", (code) => {
                        //console.log(title_str, title_str == "NA\n", title_str.trimEnd() == "NA");
                        if (title_str == "NA\n") {
                            title_str = body_url;
                        }
                        play_lists.findOrCreate({
                            where: { url: body_url },
                            defaults: {
                                title: title_str,
                                watch: watch_var,
                                full_update: full_update
                            },
                        });
                    });
                }
            }
        } else {
            body_url = "None";
        }

        Promise.all(
            response_list.map(async (element) => {
                var items = element.split("\t");

                try {
                    var available_var = true;
                    if (
                        items[0] === "[Deleted video]" ||
                        items[0] === "[Private video]"
                    ) {
                        available_var = false;
                    }
                    else if (items[0] === "NA") {
                        items[0] = items[1];
                    }
                    if (body_url == "None") {
                        const last_item = await vid_list.findOne({
                            where: {
                                reference: 'None',
                            },
                            order: [
                                ['createdAt', 'DESC'],
                            ],
                            attributes: ['list_order'],
                            limit: 1,
                        });
                        //console.log(last_item.list_order);
                        index = last_item.list_order;
                    }
                    const [found, created] = await vid_list.findOrCreate({
                        where: { url: items[2] },
                        defaults: {
                            id: items[1],
                            reference: body_url,
                            title: items[0],
                            downloaded: false,
                            available: available_var,
                            list_order: ++index,
                        },
                    });
                    if (!created) {
                        // The object was found and not created
                        //console.log("Found object: ", found);
                        if (found.id !== items[1] ||
                            found.reference !== body_url ||
                            found.title !== items[0] ||
                            found.available !== available_var ||
                            found.list_order !== index - 1) {
                            // At least one property is different, update the object
                            found.id = items[1];
                            found.reference = body_url;
                            found.title = items[0];
                            found.available = available_var;
                            found.list_order = index - 1;
                            //console.log("Found object updated: ", found);
                        } else {
                            found.changed("updatedAt", true);
                        }
                        await found.save();
                    }
                    // finally updating the object to send to frontend
                    init_resp["count"] += 1;
                    init_resp["rows"].push(found);

                } catch (error) {
                    console.error(error);
                }
            })
        ).then(function () {
            try {
                res.writeHead(200, { "Content-Type": json_t });
                res.end(JSON.stringify(init_resp, null, 2));
            } catch (error) {
                console.error(error);
            }
        }).then(function () {
            list_background(body_url, start_num, stop_num, chunk_size).then(
                () => {
                    //console.log("done processing playlist");
                    sock.emit("playlist", { message: "done processing playlist or channel" });
                }
            );
        });
    });
}

function sleep(s) {
    return new Promise((resolve) => setTimeout(resolve, s * 1000));
}

async function list_background(body_url, start_num, stop_num, chunk_size) {
    //console.log('In list_background', "body_url", body_url, "start_num", start_num, "stop_num", stop_num, "chunk_size", chunk_size);
    while (true && (body_url != 'None')) {
        start_num = start_num + chunk_size;
        stop_num = stop_num + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        // getting this form docker compose isn't a bad idea either
        // I plan on using sockets to communicate that this is still working
        //console.log("In background lister", "Chunk:", chunk_size, "Start:", start_num, "Stop:", stop_num);
        await sleep(sleep_time);
        const response = await ytdlp_spawner(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        await processResponse(response, body_url, start_num);
    }
}

function ytdlp_spawner(body_url, start_num, stop_num) {
    //console.log("In spawner", "Start:", start_num, "Stop:", stop_num);
    return new Promise((resolve, reject) => {
        const yt_list = spawn("yt-dlp", [
            "--playlist-start",
            start_num,
            "--playlist-end",
            stop_num,
            "--flat-playlist",
            "--print",
            "%(title)s\t%(id)s\t%(webpage_url)s",
            body_url,
        ]);
        let response = "";
        yt_list.stdout.on("data", (data) => {
            response += data;
        });
        yt_list.stderr.on("data", (data) => {
            // maybe use sockets to send the stderr to the
            console.error(`stderr: ${data}`);
        });
        yt_list.on("error", (error) => {
            console.error(`error: ${error.message}`);
        });
        yt_list.on("close", (code) => {
            resolve(response.split("\n").filter((line) => line.length > 0));
        });
    });
}

async function processResponse(response, body_url, start_num) {
    var index = start_num;
    //console.log("In processResponse", "Start:", start_num);
    sock.emit("progress", { message: `Processing: ${body_url} from ${index}` });
    await Promise.all(response.map(async (element) => {
        var [title, id, url] = element.split("\t");
        if (title === "[Deleted video]" || title === "[Private video]") {
            return;
        } else if (title === "NA") {
            title = id;
        }
        const item_available = title !== "[Unavailable video]";
        try {
            const [found, created] = await vid_list.findOrCreate({
                where: { url: url },
                defaults: {
                    id: id,
                    reference: body_url,
                    title: title,
                    downloaded: false,
                    available: item_available,
                    list_order: index++,
                },
            });
            if (!created) {
                // The object was found and not created
                //console.log("Found object: ", found);
                if (found.id !== id ||
                    found.reference !== body_url ||
                    found.title !== title ||
                    found.available !== item_available ||
                    found.list_order !== index - 1) {
                    // At least one property is different, update the object
                    found.id = id;
                    found.reference = body_url;
                    found.title = title;
                    found.available = item_available;
                    found.list_order = index - 1;
                    //console.log("Found object updated: ", found);
                } else {
                    found.changed("updatedAt", true);
                }
                await found.save();
            }
        } catch (error) {
            console.error(error);
        }
    })
    );
}

async function playlists_to_table(req, res) {
    var body = "";
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) {
            req.connection.destroy();
            res.writeHead(413, { "Content-Type": html });
            res.write("Content Too Large");
            res.end();
        }
    });
    req.on("end", function () {
        body = JSON.parse(body);
        var row = "order_added";
        var type = "ASC";
        var start_num = body["start"] || 0;
        var stop_num = body["stop"] || 10;
        var sort_with = body["sort"] || 1;
        var order = body["order"] || 1;
        if (order == 2) {
            type = "DESC";
        }
        if (sort_with == 2) {
            row = "createdAt";
        } else if (sort_with == 3) {
            row = "updatedAt";
        }
        play_lists.findAndCountAll({
            limit: stop_num - start_num,
            offset: start_num,
            order: [[row, type]],
        }).then((result) => {
            res.writeHead(200, { "Content-Type": json_t });
            res.end(JSON.stringify(result, null, 2));
        });
    });
}

async function sublist_to_table(req, res) {
    var body = "";
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) {
            req.connection.destroy();
            res.writeHead(413, { "Content-Type": html });
            res.write("Content Too Large");
            res.end();
        }
    });
    req.on("end", function () {
        body = JSON.parse(body);
        var body_url = body["url"];
        var start_num = +body["start"] || 0;
        var stop_num = +body["stop"] || 10;
        var query_string = body["query"] || "";
        var order = "list_order", type = "ASC";
        // This is a rough solution to a bigger problem, need more looking into
        // if (body_url == "None") { order = "updatedAt", type = "DESC"; }
        //console.log(`body_url: ${body_url}\nquery_string: "${query_string}"\nstart_num: ${start_num}\nstop_num: ${stop_num}\n`);
        try {
            if (query_string == "") {
                vid_list.findAndCountAll({
                    where: {
                        reference: body_url,
                    },
                    limit: stop_num - start_num,
                    offset: start_num,
                    order: [[order, type]],
                }).then((result) => {
                    res.writeHead(200, { "Content-Type": json_t });
                    res.end(JSON.stringify(result, null, 2));
                });
            } else {
                vid_list.findAndCountAll({
                    where: {
                        reference: body_url,
                        title: {
                            [Op.iLike]: `%${query_string}%`
                        }
                    },
                    limit: stop_num - start_num,
                    offset: start_num,
                    order: [[order, type]],
                }).then((result) => {
                    res.writeHead(200, { "Content-Type": json_t });
                    res.end(JSON.stringify(result, null, 2));
                });
            }
        } catch (error) {
            console.error(error);
        }
    });
}

const css = "text/css; charset=utf-8";
const html = "text/html; charset=utf-8";
const js = "text/javascript; charset=utf-8";
const json_t = "text/json; charset=utf-8";
const staticAssets = {
    '': { obj: (__dirname + '/index.html'), type: html },
    '/': { obj: (__dirname + '/index.html'), type: html },
    '/dbi': { obj: (__dirname + '/dbi.html'), type: html },
    '/assets/bootstrap.min.css': { obj: (__dirname + '/node_modules/bootstrap/dist/css/bootstrap.min.css'), type: css },
    '/assets/bootstrap.min.css.map': { obj: (__dirname + '/node_modules/bootstrap/dist/css/bootstrap.min.css.map'), type: css },
    '/assets/bootstrap.bundle.min.js': { obj: (__dirname + '/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js'), type: js },
    '/assets/bootstrap.bundle.min.js.map': { obj: (__dirname + '/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map'), type: js },
    '/assets/favicon.ico': { obj: (__dirname + '/favicon.ico'), type: "image/x-icon" },
    '/assets/socket.io.min.js': { obj: (__dirname + '/node_modules/socket.io/client-dist/socket.io.min.js'), type: js },
    '/assets/socket.io.min.js.map': { obj: (__dirname + '/node_modules/socket.io/client-dist/socket.io.min.js.map'), type: js },
    '/assets/nav.png': { obj: (__dirname + '/nav.png'), type: "image/png" },
    '/assets/client.js': { obj: (__dirname + '/client.js'), type: js }
};

const server = http.createServer((req, res) => {
    if (req.url.startsWith(url_base) && req.method === "GET") {
        try {
            var get = req.url.replace(url_base, '')
            res.writeHead(200, { "Content-Type": staticAssets[get].type });
            res.write(fs.readFileSync(staticAssets[get].obj));
        } catch (error) {
            res.writeHead(404, { "Content-Type": html });
            res.write("Not Found");
        }
        res.end();
    } else if (req.url === url_base + "/list" && req.method === "POST") {
        list_init(req, res);
    } else if (req.url === url_base + "/dbi" && req.method === "POST") {
        playlists_to_table(req, res);
    } else if (req.url === url_base + "/getsub" && req.method === "POST") {
        sublist_to_table(req, res);
    } else if (req.url === url_base + "/download" && req.method === "POST") {
        download_lister(req, res);
    } else {
        res.writeHead(404, { "Content-Type": html });
        res.write("Not Found");
        res.end();
    }
});

const io = new Server(server, { path: url_base + "/socket.io/" });
const sock = io.on("connection", (socket) => {
    socket.emit("init", { message: "Connected", id: socket.id });
    //socket.on("acknowledge", console.log);
    return socket;
});

server.listen(port, () => {
    if (process.env.hide_ports || process.env.hide_ports == undefined)
        console.log(`Server listening on ${protocol}://${host}:${port}${url_base}`);
    else
        console.log(`Server listening on ${protocol}://${host}${url_base}`);
});
