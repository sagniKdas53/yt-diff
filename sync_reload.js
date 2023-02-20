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

// Need to figure out how to only load the server form this file not that one
const { download_init, download_background_sequential, list_init, sleep,
    list_background, ytdlp_spawner, processResponse, playlists_to_table, sublist_to_table } = require("./index.js")

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

const server_reload = http.createServer((req, res) => {
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

const io = new Server(server_reload, { path: url_base + "/socket.io/" });
const sock = io.on("connection", (socket) => {
    ////console.log('connection', socket);
    socket.emit('init', { message: "Connected", id: socket.id });
    socket.on('acknowledge', console.log);
    return socket;
});

server_reload.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});