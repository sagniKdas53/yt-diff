const { Sequelize, DataTypes } = require('sequelize');
const { spawn } = require("child_process");
const { once } = require('events');

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
        allowNull: false,
    },
});

sequelize.sync().then(() => {
    console.log('vid_list and play_lists tables exist or are created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});

async function yt_dlp_spawner_promised(body_url, start_num, stop_num, chunk_size) {
    while (true) {
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;
        const response = await spawnYtDlp(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        await processResponse(response, body_url);
    }
}

const bangers = { url: "https://www.youtube.com/playlist?list=PL4Oo6H2hGqj22U9EzJEdlIwNbsUAikFN9", size: 34 }
const daft_punk_essentials = { url: "https://www.youtube.com/playlist?list=PLSdoVPM5WnneERBKycA1lhN_vPM6IGiAg", size: 22 }
yt_dlp_spawner_promised(bangers['url'], -9, 0, 10).then(() => { console.log('done fr'); });

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
            reject(`stderr: ${data}`);
        });
        yt_list.on('error', (error) => {
            reject(`error: ${error.message}`);
        });
        yt_list.on("close", (code) => {
            resolve(response.split("\n").filter(line => line.length > 0));
        });
    });
}

async function processResponse(response, body_url) {
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
                available: item_available
            }
        });
        if (found && found.reference === 'None') {
            found.reference = body_url;
            found.changed('updatedAt', true);
        }
    }));
}
