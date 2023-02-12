const { spawn } = require("child_process");
const http = require('http');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');
const { Server } = require("socket.io");
var sock = null;
const regex = /(\d{1,3}\.\d)%/;
const url_base = '/ytdiff'; // get this form env in docker config

var port = process.argv[2] || 8888; // get this form env in docker config
const sequelize = new Sequelize('vidlist', 'ytdiff', 'ytd1ff', {
    //host: 'yt-db',
    host: 'localhost',
    dialect: 'postgres'
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
    }, reference: {
        type: DataTypes.STRING,
        allowNull: false,
    },
});


const play_lists = sequelize.define('list_of_play_lists', {
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
    console.log('vid_list table created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

async function download_background_parallel(url_list) {
    console.log('Downloading in background')
    var i = 0;
    var save_loc = 'yt-dlp';
    for (const url_str of url_list) {
        console.log(`Downloading video ${++i}`);
        try {
            const yt_dlp = spawn("yt-dlp", ["-P", save_loc, url_str]);
            yt_dlp.stdout.on("data", async data => {
                console.log(`${data}`);
            });
            yt_dlp.stderr.on("data", data => {
                console.log(`stderr: ${data}`);
            });
            yt_dlp.on('error', (error) => {
                console.error(`error: ${error.message}`);
                throw 'Error Skipping';
            });
            yt_dlp.on("close", async (code) => {
                console.log(`child process exited with code ${code}`);
                if (code == 0) {
                    console.log("Updating");
                    var entity = await vid_list.findOne({ where: { url: url_str } });
                    console.log(entity.downloaded);
                    entity.set({
                        downloaded: true
                    });
                    await entity.save();
                    console.log(entity.downloaded);
                }
            });
        } catch (error) {
            console.error(error);
        }
    }
}

async function download_background_sequential(url_list) {
    console.log('Downloading in background');
    var i = 0;
    var save_loc = 'yt-dlp';
    for (const url_str of url_list) {
        console.log(`Downloading video ${++i}`);
        try {
            const yt_dlp = spawn("yt-dlp", ["-P", save_loc, url_str]);
            yt_dlp.stdout.on("data", async data => {
                console.log(`${data}`);
                try {
                    let m;
                    if ((m = regex.exec(`${data}`)) !== null) {
                        // The result can be accessed through the `m`-variable.\
                        sock.emit('progress', { message: m[0] });
                    }
                } catch (error) {
                    console.log(`${error}`);
                    sock.emit('error', { message: `${error}` });
                }
            });
            yt_dlp.stderr.on("data", data => {
                console.log(`stderr: ${data}`);
            });
            yt_dlp.on("error", error => {
                console.error(`error: ${error.message}`);
                throw "Error Skipping";
            });
            yt_dlp.on("close", async (code) => {
                console.log(`child process exited with code ${code}`);
                // add the db update here
                if (code == 0) {
                    console.log("Updating");
                    var entity = await vid_list.findOne({ where: { url: url_str } });
                    console.log(entity.downloaded);
                    entity.set({
                        downloaded: true
                    });
                    await entity.save();
                    console.log(entity.downloaded);
                    console.log(entity.title);
                    sock.emit('done', { message: `${entity.title}` });
                }
            });
            await new Promise((resolve) => yt_dlp.on("close", resolve));
        } catch (error) {
            console.error(error);
        }
    }
}

async function list(req, res) {
    var body = '', response = '', end = '';
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            request.connection.destroy();
    });
    req.on('end', function () {
        body = JSON.parse(body);
        console.log('body_url: ' + body['url'], 'start_num: ' + body['start'],
            'stop_num:', body['stop'])//, 'single:', body['single']);
        var body_url = body['url'];
        var start_num = body['start'] || 1;
        var stop_num = body['stop'] || 10; // add a way to send -1 to list it all in one go
        // as it seems these options are depricated `--playlist-start ${start_num}`, `--playlist-end ${stop_num}`, but still work
        console.log("url: ", body_url);
        const yt_list = spawn("yt-dlp", ["--playlist-start", start_num, "--playlist-end", stop_num, "--flat-playlist",
            "--print", '%(title)s\t%(id)s\t%(webpage_url)s', body_url]);
        yt_list.stdout.on("data", async data => {
            response += data;
        });
        yt_list.stderr.on("data", data => {
            response = `stderr: ${data}`;
        });
        yt_list.on('error', (error) => {
            response = `error: ${error.message}`;
        });
        yt_list.on("close", code => {
            end = `child process exited with code ${code}`;
            response_list = response.split("\n");
            // remove the "" from the end of the list
            response_list.pop();
            console.log(response_list, response_list.length);
            // Check if this is indeed a playlist then add or update the play_lists
            if ((response_list.length > 1) || body_url.includes('playlist')) {
                let title_str = "";
                const get_title = spawn("yt-dlp", ["--playlist-end", 1, "--flat-playlist", "--print", '%(playlist_title)s', body_url]);
                get_title.stdout.on("data", async (data) => {
                    title_str += data;
                });
                get_title.on("close", code => {
                    play_lists.findOrCreate({
                        where: { url: body_url },
                        defaults: { title: title_str }
                    });
                });
            }
            response_list.forEach(async element => {
                var items = element.split("\t");
                console.log(items, items.length);
                try {
                    const video = await vid_list.create({
                        url: items[2],
                        id: items[1],
                        reference: body_url,
                        title: items[0],
                        downloaded: false,
                        available: true
                    }).then(function () {
                        console.log(items[0], "saved");
                    });
                } catch (error) {
                    console.error(error);
                    // do better here, later
                }
            });
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(response + end);
        });
    });
}

async function db_to_table(req, res) {
    var body = '';
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            request.connection.destroy();
    });
    req.on('end', function () {
        body = JSON.parse(body);
        //console.log('start_num: ', body['start'], 'stop_num:', body['stop']);
        var start_num = body['start'] || 0;
        var stop_num = body['stop'] || 10;
        console.log('start_num: ' + start_num + ' stop_num: ' + stop_num);
        play_lists.findAndCountAll({
            limit: stop_num - start_num,
            offset: start_num
        }).then(result => {
            //console.log("Here");
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(result, null, 2));
        });
    });
}

var server = http.createServer((req, res) => {
    if (req.url === url_base) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    }
    else if (req.url === url_base + '/showdb' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/show.html'));
        res.end();
    }
    else if (req.url === url_base + '/list' && req.method === 'POST') {
        list(req, res);
    }
    else if (req.url === url_base + '/showdb' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/show.html'));
        res.end();
    }
    else if (req.url === url_base + '/showdb' && req.method === 'POST') {
        db_to_table(req, res);
    }
    else if (req.url === url_base + '/download' && req.method === 'POST') {
        var body = '', response = '';
        req.on('data', function (data) {
            body += data;
            // Too much POST data, kill the connection!
            // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
            if (body.length > 1e6)
                request.connection.destroy();
        });
        req.on('end', async function () {
            body = JSON.parse(body);
            var urls = [];
            console.log('Recieved: ' + body['ids']);
            //download here
            //setup websocket if i feel like it
            //the idea here is simple query the id form the db get the url
            //pass the url to a spwan instance and then download if error occures
            //pass the error to the client as a notification or if websocket is added then via 
            //that, now once the download is done update the db that the video is saved
            //finally notify the client if the window is still open
            var i = 0;
            for (const id_str of body['ids']) {
                console.log(`Finding the url of the video ${++i}`);
                const entry = await vid_list.findOne({ where: { id: id_str } });
                urls.push(entry.url);
            }

            console.log(urls);
            download_background_sequential(urls);
            response = 'Downloading started, it will take a while ...';
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('[' + urls.join(' , ') + ']');
        });
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
    else if (req.url === url_base + '/assets/favicon.ico' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/vnd.microsoft.icon' });
        // don't forget to remove this sync method
        res.write(fs.readFileSync(__dirname + '/favicon.ico'));
        res.end();
    }
    else {
        //console.log("This: ",res.url);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
    }
});

const io = new Server(server, { /* options */ });
io.on("connection", (socket) => {
    //console.log('connection', socket);
    sock = socket;
    socket.emit('init', { message: "Connected", id: socket.id });
    socket.on('acknowledge', console.log);
});

server.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});