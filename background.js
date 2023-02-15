async function list_background(body_url, start_num, stop_num, chunk_size) {
    var response = 'None';
    var i = 0;
    console.log('\nlisting in background\n');
    console.log("body_url", body_url, "start_num", start_num, "stop_num", stop_num, "chunk_size", chunk_size);
    // use a for loop instead of do loop
    while (response != 'done') {
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


async function test(){
    
}


//list_background("https://www.youtube.com/playlist?list=PL4Oo6H2hGqj2hsdtwqtESAdABg_TDAA-v",1,10,10);