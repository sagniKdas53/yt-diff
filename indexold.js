const { spawn } = require("child_process");
const http = require('http');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');
const { Server } = require("socket.io");
const regex = /(\d{1,3}\.\d)%/;
const url_base = '/ytdiff'; // get this form env in docker config
const port = process.argv[2] || 8888; // get this form env in docker config
// maybe use try catch to fix this
const sequelize = new Sequelize('vidlist', 'ytdiff', 'ytd1ff', {
    //host: 'yt-db',
    host: 'localhost',
    dialect: 'postgres'
    , logging: false
});

try {
    sequelize.authenticate().then(() => {
        console.log('Connection has been established successfully.');
    })
} catch (error) {
    console.error('Unable to connect to the database:', error);
}

const vid_list = sequelize.define('vid_list', {
    // Model attributes are defined here
    url: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    id: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
    },
    title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    downloaded: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    available: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    reference: {
        type: DataTypes.STRING,
        allowNull: false
    },
    list_order: {
        type: DataTypes.INTEGER,
        allowNull: false
    }
});


const play_lists = sequelize.define('play_lists', {
    // Model attributes are defined here
    title: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
    },
    order_added: {
        type: DataTypes.INTEGER,
        allowNull: false,
        autoIncrement: true
    }
});

sequelize.sync().then(() => {
    console.log('vid_list and play_lists tables exist or are created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

// livestreams can be downloaded but no progress is shown
async function download_stuff(req, res, next) {
    var body = '', response = '';
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            req.connection.destroy();
    });
    req.on('end', async function () {
        body = JSON.parse(body);
        var urls = [];
        //console.log('Recieved: ' + body['ids']);
        var i = 0;
        for (const id_str of body['ids']) {
            //console.log(`Finding the url of the video ${++i}`);
            const entry = await vid_list.findOne({ where: { id: id_str } });
            urls.push(entry.url);
        }

        //console.log(urls);
        download_background_sequential(urls);
        response = 'Downloading started, it will take a while ...';
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('[' + urls.join(' , ') + ']');
    });
}

// update this to downlaod parallely with a limit
// this may or may not be a good idea
async function download_background_parallel(url_list) {
    // TODO
}

async function download_background_sequential(url_list) {
    //console.log('Downloading in background');
    var i = 0;
    var save_loc = 'yt-dlp';
    // make a way to append this if needed
    const subs = ["--write-subs", "--sleep-subtitles", 1];
    for (const url_str of url_list) {
        //console.log(`Downloading video ${++i}`);
        try {
            const yt_dlp = spawn("yt-dlp", ["-P", save_loc, url_str, "--embed-metadata"]);
            yt_dlp.stdout.on("data", async data => {
                //console.log(`${data}`);
                try {
                    let m;
                    if ((m = regex.exec(`${data}`)) !== null) {
                        // The result can be accessed through the `m`-variable.\
                        sock.emit('progress', { message: m[0] });
                    }
                } catch (error) {
                    //console.log(`${error}`);
                    sock.emit('error', { message: `${error}` });
                }
            });
            yt_dlp.stderr.on("data", data => {
                console.log(`stderr: ${data}`);
            });
            yt_dlp.on("error", error => {
                //console.error(`error: ${error.message}`);
                throw "Error Skipping";
            });
            yt_dlp.on("close", async (code) => {
                //console.log(`child process exited with code ${code}`);
                // add the db update here
                if (code == 0) {
                    //console.log("Updating");
                    var entity = await vid_list.findOne({ where: { url: url_str } });
                    //console.log(entity.downloaded);
                    entity.set({
                        downloaded: true
                    });
                    await entity.save();
                    //console.log(entity.downloaded);
                    //console.log(entity.title);
                    sock.emit('done', { message: `${entity.title}` });
                }
            });
            await new Promise((resolve) => yt_dlp.on("close", resolve));
        } catch (error) {
            console.error(error);
        }
    }
}

// divide this function using the functions below
async function list(req, res) {
    var body = "",
        init_resp = { count: 0, rows: [] }, i = 0;
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
        var chunk_size = body["chunk_size"] || 10;
        const response_list = await spawnYtDlp(body_url, start_num, stop_num);
        console.log(response_list);
        if (response_list.length > 1 && body_url.includes("playlist")) {
            let title_str = "";
            var is_alredy_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_alredy_indexed.changed("updatedAt", true);
                await is_alredy_indexed.save();
                console.log("playlist updated");
                title_str = is_alredy_indexed.title;
            } catch (error) {
                console.log("playlist not encountered");
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
                            list_order: ++i
                        },
                    });

                    if (found) {
                        // console.log("Updating entry");
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
            yt_dlp_spawner_promised(body_url, start_num, stop_num, chunk_size).then(
                () => {
                    console.log("done processing playlist");
                }
            );
        });
    });
}

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

async function yt_dlp_spawner_promised(body_url, start_num, stop_num, chunk_size) {
    while (true) {
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        // getting this form docker compose isn't a bad idea either
        // I plan on using sockets to communicate that this is still working
        await sleep(3);
        const response = await spawnYtDlp(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        await processResponse(response, body_url, start_num);
    }
}

function spawnYtDlp(body_url, start_num, stop_num) {
    return new Promise((resolve, reject) => {
        const yt_list = spawn("yt-dlp", [
            "--playlist-start",
            start_num,
            "--playlist-end",
            stop_num,
            "--flat-playlist",
            "--print",
            '%(title)s\t%(id)s\t%(webpage_url)s',
            body_url
        ]);
        let response = '';
        yt_list.stdout.on("data", data => {
            response += data;
        });
        yt_list.stderr.on("data", data => {
            // maybe use sockets to send the stderr to the 
            console.log(`stderr: ${data}`);
        });
        yt_list.on('error', (error) => {
            console.log(`error: ${error.message}`);
        });
        yt_list.on("close", (code) => {
            resolve(response.split("\n").filter(line => line.length > 0));
        });
    });
}

async function processResponse(response, body_url, start_num) {
    // adding an index to the database column could be viable so that due to the
    // ingerent asynchronousity of the database opertions do not mess up the order in which
    // data is presented to the frontend
    var i = start_num
    await Promise.all(response.map(async element => {
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
                list_order: i++
            }
        });
        if (found && found.reference === 'None') {
            found.reference = body_url;
            found.changed('updatedAt', true);
            //console.log("Updating entry");
        }
    }));
}

async function db_to_table(req, res) {
    var body = '';
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            req.connection.destroy();
    });
    req.on('end', function () {
        body = JSON.parse(body);
        ////console.log('start_num: ', body['start'], 'stop_num:', body['stop']);
        var start_num = body['start'] || 0;
        var stop_num = body['stop'] || 10;
        //console.log('start_num: ' + start_num + ' stop_num: ' + stop_num);
        play_lists.findAndCountAll({
            limit: stop_num - start_num,
            offset: start_num
        }).then(result => {
            ////console.log("Here");
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(result, null, 2));
        });
    });
}

async function sub_list(req, res) {
    var body = '';
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            req.connection.destroy();
    });
    req.on('end', function () {
        body = JSON.parse(body);
        //console.log('body_url: ' + body['url'], 'start_num: ' + body['start'],
        //    'stop_num:', body['stop'])//, 'single:', body['single']);
        var body_url = body['url'];
        var start_num = body['start'] || 0;
        var stop_num = body['stop'] || 10; // add a way to send -1 to list it all in one go
        //console.log("url: ", body_url, "Start: ", start_num, "Stop: ", stop_num);
        vid_list.findAndCountAll({
            where: {
                reference: body_url
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [['list_order']]
        }).then(result => {
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(result, null, 2));
        })
    });

}

const server = http.createServer((req, res) => {
    if (req.url === url_base) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    }
    else if (req.url === url_base + '/dbi' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/dbi.html'));
        res.end();
    }
    else if (req.url === url_base + '/list' && req.method === 'POST') {
        list(req, res);
    }
    else if (req.url === url_base + '/dbi' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/show.html'));
        res.end();
    }
    else if (req.url === url_base + '/dbi' && req.method === 'POST') {
        db_to_table(req, res);
    }
    else if (req.url === url_base + '/getsub' && req.method === 'POST') {
        sub_list(req, res);
    }
    else if (req.url === url_base + '/download' && req.method === 'POST') {
        download_stuff(req, res);
    }
    else if (req.url === url_base + '/assets/bootstrap.min.css' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/bootstrap/dist/css/bootstrap.min.css'));
        res.end();
    }
    else if (req.url === url_base + '/assets/bootstrap.min.css.map' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/bootstrap/dist/css/bootstrap.min.css.map'));
        res.end();
    }
    else if (req.url === url_base + '/assets/bootstrap.bundle.min.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js'));
        res.end();
    }
    else if (req.url === url_base + '/assets/bootstrap.bundle.min.js.map' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map'));
        res.end();
    }
    else if (req.url === url_base + '/assets/favicon.ico' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/vnd.microsoft.icon' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/favicon.ico'));
        res.end();
    }
    else if (req.url === url_base + '/assets/socket.io.min.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/socket.io/client-dist/socket.io.min.js'));
        res.end();
    }
    else if (req.url === url_base + '/assets/socket.io.min.js.map' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/node_modules/socket.io/client-dist/socket.io.min.js.map'));
        res.end();
    }
    else if (req.url === url_base + '/assets/client.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/client.js'));
        res.end();
    }
    else if (req.url === url_base + '/assets/dbi.client.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/dbi.client.js'));
        res.end();
    }
    else if (req.url === url_base + '/assets/nav.png' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/nav.png'));
        res.end();
    }
    else {
        ////console.log("This: ",res.url);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
    }
});

const io = new Server(server, { path: url_base + "/socket.io/" });
const sock = io.on("connection", (socket) => {
    ////console.log('connection', socket);
    socket.emit('init', { message: "Connected", id: socket.id });
    socket.on('acknowledge', console.log);
    return socket;
});

server.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});