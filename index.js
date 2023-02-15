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
    //,logging: false
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
        allowNull: false,
    },
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

async function download_background_parallel(url_list) {
    //console.log('Downloading in background')
    var i = 0;
    var save_loc = 'yt-dlp';
    for (const url_str of url_list) {
        //console.log(`Downloading video ${++i}`);
        try {
            const yt_dlp = spawn("yt-dlp", ["-P", save_loc, url_str]);
            yt_dlp.stdout.on("data", async data => {
                //console.log(`${data}`);
            });
            yt_dlp.stderr.on("data", data => {
                //console.log(`stderr: ${data}`);
            });
            yt_dlp.on('error', (error) => {
                //console.error(`error: ${error.message}`);
                throw 'Error Skipping';
            });
            yt_dlp.on("close", async (code) => {
                //console.log(`child process exited with code ${code}`);
                if (code == 0) {
                    //console.log("Updating");
                    var entity = await vid_list.findOne({ where: { url: url_str } });
                    //console.log(entity.downloaded);
                    entity.set({
                        downloaded: true
                    });
                    await entity.save();
                    //console.log(entity.downloaded);
                }
            });
        } catch (error) {
            //console.error(error);
        }
    }
}

async function download_background_sequential(url_list) {
    //console.log('Downloading in background');
    var i = 0;
    var save_loc = 'yt-dlp';
    for (const url_str of url_list) {
        //console.log(`Downloading video ${++i}`);
        try {
            const yt_dlp = spawn("yt-dlp", ["-P", save_loc, url_str]);
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
                //console.log(`stderr: ${data}`);
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

async function list(req, res) {
    var body = '', response = '', end = '', resp_json = { count: 0, rows: [] };
    req.on('data', function (data) {
        body += data;
        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            req.connection.destroy();
    });
    req.on('end', async function () {
        body = JSON.parse(body);
        console.log('body_url: ' + body['url'], 'start_num: ' + body['start'],
            'stop_num:', body['stop'])//, 'single:', body['single']);
        var body_url = body['url'];
        var start_num = body['start'] || 1;
        var stop_num = body['stop'] || 10;
        var chunk_size = body['chunk_size'] || 10;
        //console.log("url: ", body_url);
        // as it seems these options are depricated `--playlist-start ${start_num}`, `--playlist-end ${stop_num}`, but still work
        // lsiting the playlists in parts is actually wasteful, considering the time it takes query stuff
        // ["--playlist-start", start_num, "--playlist-end", stop_num, "--flat-playlist", "--print", '%(title)s\t%(id)s\t%(webpage_url)s', body_url]
        // alternatively a loop can be used to process the list in parts a d when there are no more vidoes returned it can stop

        // creating the response first
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
        yt_list.on("close", async code => {
            end = `child process exited with code ${code}`;
            response_list = response.split("\n");
            // remove the "" from the end of the list
            response_list.pop();
            console.log(response_list, response_list.length);
            // Check if this is indeed a playlist then add or update the play_lists
            if ((response_list.length > 1) && body_url.includes('playlist')) { // change this && to || later when the errosr messages can be filtered out
                let title_str = "";
                var is_alredy_indexed = await play_lists.findOne({
                    where: { url: body_url }
                });
                try {
                    // this isn't updating the field, need to look into it
                    is_alredy_indexed.changed('updatedAt', true);
                    await is_alredy_indexed.save();
                    console.log("playlist updated");
                    title_str = 'No need to update'
                } catch (error) {
                    console.log("playlist not enocuntered");
                }
                if (title_str === "") {
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
            } else {
                body_url = "None";
            }

            // making the response 
            // the idea here is to make a response form the data we have at our disposal now
            // since we may be sending the list to background for further listing so the database 
            // might be busy with that and not able to handle the request in time.
            Promise.all(response_list.map(async element => {
                var items = element.split("\t");
                //console.log(items, items.length);
                // update the vidoes too here by looking for any changes that could have been made
                try {
                    const [found, made] = await vid_list.findOrCreate({
                        where: { url: items[2] },
                        defaults: {
                            id: items[1],
                            reference: body_url,
                            title: items[0],
                            downloaded: false,
                            available: true
                        }
                    })
                    // update if found
                    if (found) {
                        console.log("Updating entry");
                        resp_json['count'] += 1;
                        resp_json['rows'].push(found);
                        //console.log("resp_json", resp_json);
                        found.changed('updatedAt', true);
                        // if found doesn't have the same data then it needs to be updated
                        // list_background also needs this to be implemented
                    }
                    // okey if it's made
                    else if (made) {
                        resp_json['count'] += 1;
                        resp_json['rows'].push(made, null, 2);
                        //console.log("resp_json", resp_json);
                    }
                } catch (error) {
                    // remember to uncomment this later
                    console.error(error);
                    // do better here, later
                }
            })).then(function () {
                //console.log('here');
                //console.log("resp_json: " + resp_json);
                res.writeHead(200, { "Content-Type": "text/json" });
                res.end(JSON.stringify(resp_json, null, 2));
            });
            // sending it to the background to do the rest
            list_background(body_url, start_num, stop_num, chunk_size);
        });
    });
}

async function list_background(body_url, start_num, stop_num, chunk_size) {
    // SELECT * FROM "vid_lists" WHERE "reference" = 'https://www.youtube.com/playlist?list=PLNWGkqCSwkOH1ebNLeyqD9Avviliymkkz' ORDER BY "createdAt" LIMIT 50
    // This query shows that vidoes aren't being added to the db in order thus suggesting that this function isn't 
    // working as expected or intended, it should  divide the the massive list into chunks and then save them in order.
    // see vid_lists.csv for snapshot of the data and how the function messed it up.
    var response = 'None';
    var i = 0;
    console.log('\nlisting in background\n');
    console.log("body_url", body_url, "start_num", start_num, "stop_num", stop_num, "chunk_size", chunk_size);
    // use a for loop instead of do loop
    listing: while (response != 'done') {
        console.log('response', response);
        console.log("resposne != 'done': ", response != 'done');
        response = '';
        if (i == 3) {
            console.log('breaking to not crash and burn');
            break;
        }
        i++;
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;
        console.log('start_num:', start_num, 'stop_num:', stop_num, 'chunk_size:', chunk_size);
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
        yt_list.on("close", async code => {
            end = `child process exited with code ${code}`;
            response_list = response.split("\n");
            // remove the "" from the end of the list
            response_list.pop();
            console.log(start_num, stop_num, response, response_list, response_list.length);
            if (response_list == '') {
                // basically when the resonse is empty it means that all 
                // the items have been listed and the function can just return 
                // this should then break the outer listing loop
                console.log("done");
            } else {
                // adding the items to db
                await Promise.all(response_list.map(async element => {
                    var items = element.split("\t");
                    // console.log(items, items.length);
                    // update the vidoes too here by looking for any changes that could have been made
                    // use find or create here to update the entries
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
                        // remember to uncomment this later
                        console.error(error);
                        // do better here, later
                    }
                }));
            }
        });
    }
    console.log('================================\nOutside loop');
    console.log('response', response);
    console.log("resposne != 'done': ", response != 'done');
    console.log('done listing');
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
            offset: start_num
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
    else {
        ////console.log("This: ",res.url);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
    }
});

const io = new Server(server, { /* options */ });
const sock = io.on("connection", (socket) => {
    ////console.log('connection', socket);
    socket.emit('init', { message: "Connected", id: socket.id });
    socket.on('acknowledge', console.log);
    return socket;
});

server.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});