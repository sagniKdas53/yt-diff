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

        console.log("\nsupplied data:\nbody_url:", body_url, "\nstart_num:", start_num, "\nstop_num:", stop_num, "\nchunk_size", chunk_size);
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
            console.log("\ndata after processing\nresponse:\n", response, "\nresponse_list:", response_list, "\nresponse_list.length:", response_list.length, "\n");
            // Check if this is indeed a playlist then add or update the play_lists
            if ((response_list.length > 1) && body_url.includes('playlist')) { // change this && to || later when the errosr messages can be filtered out
                let title_str = "";
                var is_alredy_indexed = await play_lists.findOne({
                    where: { url: body_url }
                });
                try {
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
                console.log(items, items.length);
                // update the vidoes too here by looking for any changes that could have been made
                if (items.length == 3) {
                    try {
                        if (items[0] == "[Deleted video]" || items[0] == "[Private video]") {
                            item_available = false;
                        } else {
                            item_available = true;
                        }
                        const [found, made] = await vid_list.findOrCreate({
                            where: { url: items[2] },
                            defaults: {
                                id: items[1],
                                reference: body_url,
                                title: items[0],
                                downloaded: false,
                                available: item_available
                            }
                        })
                        // update if found
                        if (found) {
                            console.log("Updating entry");
                            resp_json['count'] += 1;
                            if (!item_available) {
                                found.available = false;
                                console.log("\nfound", items[0], "updated");
                            }
                            else {
                                console.log("\nfound", items[0], "no changes");
                                // need to do this to show it was processed
                                found.changed('updatedAt', true);
                            }
                            // make sure this only gets pushed after the value is updated
                            resp_json['rows'].push(found);
                        }
                        // okey if it's made
                        else if (made) {
                            resp_json['count'] += 1;
                            resp_json['rows'].push(made, null, 2);
                        }
                    } catch (error) {
                        // remember to uncomment this later
                        console.error(error);
                        // do better here, later
                    }
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
    // sleep just to make it possible to catch
    await sleep(2 * 1000);
    console.log('\nlisting in background');
    // put this in a loop where start_num and stop_num will be updated every iteration
    var i = 0;
    var stop_plz = true;
    // need to find a way to make the loop work only until the time we get a 
    // it will be something like this:
    // while (stop_plz) {
    while (i < 10) {
        // prepare an empty string to append all the data to
        var response = '';
        // make the start and stop numbers
        start_num = parseInt(start_num) + chunk_size;
        stop_num = parseInt(stop_num) + chunk_size;

        console.log("\nsupplied data:", "\ni:", i, "\nbody_url:", body_url, "\nstart_num:", start_num, "\nstop_num:", stop_num, "\nchunk_size", chunk_size);
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
        // apparently await has no effect on this expression
        // but then how are we supposed to know when to stop?
        // the listing only ends when stop_plz is false
        stop_plz = yt_list.on("close", async (code) => {
            end = `child process exited with code ${code}`;
            response_list = response.split("\n");
            // remove the "" from the end of the list
            response_list.pop();
            // get the status at the end
            console.log("\ndata after processing\ni:", i, "response:\n", response, "\nresponse_list:", response_list, "\nresponse_list.length:", response_list.length, "\n");
            if (response_list == '') {
                // basically when the resonse is empty it means that all 
                // the items have been listed and the function can just return 
                // this should then break the outer listing loop
                console.log("no vidoes found", "\ni:", i, "\n");
                // break wont work as `Jump target cannot cross function boundary.ts(1107)`
                // so I am returning false to stop_plz and if stop_plz is is true then the loop 
                // should stop in the next iteration
                return false;
            } else {
                // adding the items to db
                console.log("adding items to db", "\ni:", i, "\n");
                await Promise.all(response_list.map(async (element) => {
                    var items = element.split("\t");
                    console.log(items, items.length, "\ni:", i, "\n");
                    // update the vidoes too here by looking for any changes that could have been made
                    // use find or create here to update the entries
                    if (items.length == 3) {
                        try {
                            if (items[0] == "[Deleted video]" || items[0] == "[Private video]") {
                                item_available = false;
                            } else {
                                item_available = true;
                            }
                            const [found, created] = await vid_list.findOrCreate({
                                where: { url: items[2] },
                                defaults: {
                                    id: items[1],
                                    reference: body_url,
                                    title: items[0],
                                    downloaded: false,
                                    available: item_available
                                }
                            })
                            if (created)
                                console.log("\nsaved", items[0], "\ni:", i, "\n");
                            else if (found) {
                                if (!item_available) {
                                    found.available = false;
                                    console.log("\nfound", items[0], "updated", "\ni:", i, "\n");
                                }
                                else {
                                    console.log("\nfound", items[0], "no changes", "\ni:", i, "\n");
                                }
                                found.changed('updatedAt', true);
                            }
                        } catch (error) {
                            // remember to uncomment this later, the sequelize erros are not relevant here now
                            // console.error(error);
                        }
                    }
                }));
                return true;
            }
        });
        // this return a <ref *1> thing I don't know how to do it anymore
        console.log('\n\n\nwill stop', stop_plz, "\ni:", i, "\n");
        i++;
    }
    console.log('\noutside the loop, and persumably done', "\ni:", i, "\n");
}

async function yt_dlp_spawner(body_url, start_num, stop_num, chunk_size) {
    // can be a viable idea 
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const nine = "https://www.youtube.com/playlist?list=PLcfzFNUhrNS0HMtlayzQfOSJVaaAta7U6";
const eleven = "https://www.youtube.com/playlist?list=PL4Oo6H2hGqj1wSTOvmygaZyWtJ86g4ucr";
const twenty5 = "https://www.youtube.com/playlist?list=PLNWGkqCSwkOHznnLAMzwpy-pO0pR7Wr6r"
const seventy6 = "https://www.youtube.com/playlist?list=PLOO4NsmB3T4eli11PYPyaGYGV0JLveI18";
const thirty = "https://www.youtube.com/playlist?list=PL4Oo6H2hGqj22U9EzJEdlIwNbsUAikFN9";
//const fin_talk = "https://www.youtube.com/playlist?list=PLsRkc9JvTV2EacmW7CrV8HBSgEc8Jq5yp"

const contains_private = "https://www.youtube.com/playlist?list=PL4j9sdcFKwqkNj4WRREQ9sEB9AYmzQBdH";
const contains_deleted = "https://www.youtube.com/playlist?list=PLpHbno9djTOSaBHKTrtbsKkn6MDUujQxX";

const hunderd_n_2 = "https://www.youtube.com/playlist?list=PLlPDaLsfKPbK9BAbmG7s4b4ClUHDYNW3B"

// first 10 will be listed by the main method so the number of vidoes that we should get here is total-10
list_background(seventy6, 1, 10, 10);

