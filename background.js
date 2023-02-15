const { Sequelize, DataTypes } = require('sequelize');
const { spawn } = require("child_process");

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

async function list_background(body_url, start_num, stop_num, chunk_size) {
    // sleep just to make it possible to catch
    await sleep(2 * 1000);
    console.log('\nlisting in background');
    // put this in a loop where start_num and stop_num will be updated every iteration
    {
        // prepare an empty string to append all the data to
        var response = '';
        // make the start and stop numbers
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;

        console.log("\nsupplied data:\nbody_url:", body_url, "\nstart_num:", start_num, "\nstop_num:", stop_num, "\nchunk_size", chunk_size);
        // actually spawn the thing
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
            // get the status at the end
            console.log("\ndata after processing\nresponse:", response, "\nresponse_list:", response_list, "\nresponse_list.length:", response_list.length, "\n");
            if (response_list == '') {
                // basically when the resonse is empty it means that all 
                // the items have been listed and the function can just return 
                // this should then break the outer listing loop
                console.log("done");
            } else {
                // adding the items to db
                console.log("adding items to db");
                await Promise.all(response_list.map(async element => {
                    var items = element.split("\t");
                    console.log(items, items.length);
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
                        // remember to uncomment this later, the sequelize erros are not relevant here now
                        // console.error(error);
                    }
                }));
            }
        });
    }
}

async function yt_dlp_spawner(body_url, start_num, stop_num, chunk_size) {
    // can be a viable idea 
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


const eleven_vidoes = "https://www.youtube.com/playlist?list=PL4Oo6H2hGqj1wSTOvmygaZyWtJ86g4ucr";
const seventy6 = "https://www.youtube.com/playlist?list=PLOO4NsmB3T4eli11PYPyaGYGV0JLveI18";
list_background(seventy6, 1, 10, 10);