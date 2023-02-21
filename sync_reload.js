const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const { Sequelize, DataTypes } = require("sequelize");
const { Server } = require("socket.io");

const regex = /(\d{1,3}\.\d)%/;
const protocol = 'http';
const host = 'localhost';
const url_base = "/ytdiff"; // get this form env in docker config
const save_loc = "yt-dlp"; // get this form env in docker config
const sleep_time = 3; // get this form env in docker config
const subs = ["--write-subs", "--sleep-subtitles", sleep_time];
const port = process.argv[2] || 8888; // get this form env in docker config

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
    host: "localhost",
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
});

sequelize.sync().then(() => {
    console.log('vid_list and play_lists tables exist or are created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

// livestreams can be downloaded but no progress is shown
async function download_init(req, res) {
    var body = "";
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) req.connection.destroy();
    });
    req.on("end", async function () {
        body = JSON.parse(body);
        var urls = [];
        for (const id_str of body["ids"]) {
            const entry = await vid_list.findOne({ where: { id: id_str } });
            urls.push([entry.url, entry.title]);
        }
        download_background_sequential(urls);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("[" + urls.join(" , ") + "]");
    });
}

// update this to downlaod parallelly with a limit, this may or may not be a good idea
async function download_background_parallel(url_list) {
    // TODO
}

async function download_background_sequential(url_list) {
    for (const [url_str, title] of url_list) {
        try {
            sock.emit('download-start', { message: title });
            const yt_dlp = spawn("yt-dlp", [
                "-P",
                save_loc,
                url_str,
                "--embed-metadata",
            ]);
            yt_dlp.stdout.on("data", async (data) => {
                try {
                    if ((percentage = regex.exec(`${data}`)) !== null) {
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
                    var entity = await vid_list.findOne({ where: { url: url_str } });
                    entity.set({
                        downloaded: true,
                    });
                    await entity.save();
                    sock.emit("done", { message: `${entity.title}` });
                }
            });
            // this holds the for loop, preventing the next iteration from happening
            await new Promise((resolve) => yt_dlp.on("close", resolve));
        } catch (error) {
            console.error(error);
        }
    }
}

// divide this function using the functions below
async function list_init(req, res) {
    var body = "",
        init_resp = { count: 0, rows: [] };
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) req.connection.destroy();
    });
    req.on("end", async function () {
        body = JSON.parse(body);
        console.log(
            "body_url: " + body["url"],
            "start_num: " + body["start"],
            "stop_num:",
            body["stop"]
        );
        var body_url = body["url"];
        var start_num = body["start"] || 1;
        var stop_num = body["stop"] || 10;
        var i = start_num - 1;
        var chunk_size = body["chunk_size"] || 10;
        const response_list = await ytdlp_spawner(body_url, start_num, stop_num);
        console.log(response_list, response_list.length);
        if (response_list.length > 1 && body_url.includes("playlist")) {
            let title_str = "";
            var is_alredy_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_alredy_indexed.changed("updatedAt", true);
                await is_alredy_indexed.save();
                title_str = is_alredy_indexed.title;
            } catch (error) {
                console.error("playlist not encountered");
            }
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
                    play_lists.findOrCreate({
                        where: { url: body_url },
                        defaults: { title: title_str },
                    });
                });
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
                    const [found, _] = await vid_list.findOrCreate({
                        where: { url: items[2] },
                        defaults: {
                            id: items[1],
                            reference: body_url,
                            title: items[0],
                            downloaded: false,
                            available: available_var,
                            list_order: ++i,
                        },
                    });

                    if (found) {
                        init_resp["count"] += 1;
                        init_resp["rows"].push(found);
                        found.changed("updatedAt", true);
                    }
                } catch (error) {
                    console.error(error);
                }
            })
        ).then(function () {
            try {
                res.writeHead(200, { "Content-Type": "text/json" });
                res.end(JSON.stringify(init_resp, null, 2));
            } catch (error) {
                console.error(error);
            }
        }).then(function () {
            list_background(body_url, start_num, stop_num, chunk_size).then(
                () => {
                    console.log("done processing playlist");
                }
            );
        });
    });
}

function sleep(s) {
    return new Promise((resolve) => setTimeout(resolve, s * 1000));
}

async function list_background(body_url, start_num, stop_num, chunk_size) {
    while (true) {
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        // getting this form docker compose isn't a bad idea either
        // I plan on using sockets to communicate that this is still working
        await sleep(sleep_time);
        const response = await ytdlp_spawner(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        await processResponse(response, body_url, start_num);
    }
}

function ytdlp_spawner(body_url, start_num, stop_num) {
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
            console.log(`stderr: ${data}`);
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
    var i = start_num;
    await Promise.all(response.map(async (element) => {
        const [title, id, url] = element.split("\t");
        if (title === "[Deleted video]" || title === "[Private video]") {
            return;
        }
        const item_available = title !== "[Unavailable video]";
        const [found, _] = await vid_list.findOrCreate({
            where: { url: url },
            defaults: {
                id: id,
                reference: body_url,
                title: title,
                downloaded: false,
                available: item_available,
                list_order: i++,
            },
        });
        if (found && found.reference === "None") {
            found.reference = body_url;
            found.changed("updatedAt", true);
        }
    })
    );
}

async function playlists_to_table(req, res) {
    var body = "";
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) req.connection.destroy();
    });
    req.on("end", function () {
        body = JSON.parse(body);
        var start_num = body["start"] || 0;
        var stop_num = body["stop"] || 10;
        play_lists.findAndCountAll({
            limit: stop_num - start_num,
            offset: start_num,
        }).then((result) => {
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(result, null, 2));
        });
    });
}

async function sublist_to_table(req, res) {
    var body = "";
    req.on("data", function (data) {
        body += data;
        if (body.length > 1e6) req.connection.destroy();
    });
    req.on("end", function () {
        body = JSON.parse(body);
        var body_url = body["url"];
        var start_num = body["start"] || 0;
        var stop_num = body["stop"] || 10; // add a way to send -1 to list it all in one go
        vid_list.findAndCountAll({
            where: {
                reference: body_url,
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [["list_order"]],
        }).then((result) => {
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(result, null, 2));
        });
    });
}

const css = "text/css; charset=utf-8";
const html = "text/html; charset=utf-8";
const js = "text/javascript; charset=utf-8";
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
    '/assets/client.js': { obj: (__dirname + '/client.js'), type: js },
    '/assets/dbi.client.js': { obj: (__dirname + '/dbi.client.js'), type: js }
};

const server_sync = http.createServer((req, res) => {
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
        download_init(req, res);
    } else {
        res.writeHead(404, { "Content-Type": html });
        res.write("Not Found");
        res.end();
    }
});

const io = new Server(server_sync, { path: url_base + "/socket.io/" });
const sock = io.on("connection", (socket) => {
    socket.emit("init", { message: "Connected", id: socket.id });
    socket.on("acknowledge", console.log);
    return socket;
});

server_sync.listen(port, () => {
    console.log(`Server listening on ${protocol}://${host}:${port}${url_base}`);
});
