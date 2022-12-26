const { spawn } = require("child_process");
const http = require('http');
const fs = require('fs');
const path = require('path');
var qs = require('querystring');
const { Sequelize, DataTypes } = require('sequelize');

var port = process.argv[2] || 8888;
const sequelize = new Sequelize('vidlist', 'ytdiff', 'ytd1ff', {
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
            const yt_list = spawn("yt-dlp", ["-P", save_loc, url_str]);
            yt_list.stdout.on("data", async data => {
                console.log(`${data}`);
            });
            yt_list.stderr.on("data", data => {
                console.log(`stderr: ${data}`);
            });
            yt_list.on('error', (error) => {
                console.log(`error: ${error.message}`);
                throw 'Error Skipping';
            });
            yt_list.on("close", async (code) => {
                console.log(`child process exited with code ${code}`);
                
                console.log("Updating");
                var entity = await vid_list.findOne({ where: { url: url_str } });
                console.log(entity.downloaded);
                entity.set({
                    downloaded: true
                });
                await entity.save();
                console.log(entity.downloaded);
                
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
    for (const url of url_list) {
        console.log(`Downloading video ${++i}`);
        try {
            const yt_list = spawn("yt-dlp", ["-P", save_loc, url]);
            yt_list.stdout.on("data", async data => {
                console.log(`${data}`);
            });
            yt_list.stderr.on("data", data => {
                console.log(`stderr: ${data}`);
            });
            yt_list.on("error", error => {
                console.log(`error: ${error.message}`);
                throw "Error Skipping";
            });
            yt_list.on("close", code => {
                console.log(`child process exited with code ${code}`);
                // add the db update here
            });
            await new Promise((resolve) => yt_list.on("close", resolve));
        } catch (error) {
            console.error(error);
        }
    }
}


var server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    }
    else if (req.url === '/list' && req.method === 'POST') {
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
            var stop_num = body['stop'] || 10; // send these from the clinet too, add a way to loop and list
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
                response_list = response.slice(0, -2).split("\n");
                console.log(response_list, response_list.length);
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
                        }).then(function () { console.log(items[0], 'saved'); });
                    } catch (error) {
                        console.log(error);
                        // do better here, later
                    }
                });
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(response + end);
            });
        });
    }
    else if (req.url === '/download' && req.method === 'POST') {
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
    else {
        //console.log("This: ",res.url);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
    }
});

server.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});