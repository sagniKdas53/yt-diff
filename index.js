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
        primaryKey: true
    },
    reference: {
        type: DataTypes.STRING,
        allowNull: false,
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
    }
});

sequelize.sync().then(() => {
    console.log('vid_list table created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

var server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    }
    else if (req.url === '/list' && req.method === 'POST') {
        var body = '', body_url = '', response = '';
        req.on('data', function (data) {
            body += data;
            // Too much POST data, kill the connection!
            // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
            if (body.length > 1e6)
                request.connection.destroy();
        });
        req.on('end', function () {
            var body_url = qs.parse(body);
            var start_num = body_url['start'] || 1;
            var stop_num = body_url['stop'] || 10; // send these from the clinet too, add a way to loop and list
            // as it seems these options are depricated `--playlist-start ${start_num}`, `--playlist-end ${stop_num}`, but still work
            console.log("url: ", body_url['url_input']);
            const yt_list = spawn("yt-dlp", ["--playlist-start", start_num, "--playlist-end", stop_num, "--flat-playlist",
                "--print", '%(title)s \t %(id)s \t %(webpage_url)s', body_url['url_input']]);
            yt_list.stdout.on("data", data => {
                response += data;
                data = '' + data;
                console.log(data);
                var items = data.split("\t");
                console.log(items);
                vid_list.create({
                    url: items[2],
                    reference: body_url['url_input'],
                    title: items[0],
                    downloaded: false,
                    available: true
                });
                //return (`stdout: ${data}`);
            });
            yt_list.stderr.on("data", data => {
                response = `stderr: ${data}`;
                //return (`stderr: ${data}`);
            });
            yt_list.on('error', (error) => {
                response = `error: ${error.message}`;
                //return (`error: ${error.message}`);
            });
            yt_list.on("close", code => {
                response += `child process exited with code ${code}`;
                //console.log(`child process exited with code ${code}`);
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(response);
            });
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