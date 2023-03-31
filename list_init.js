async function list_init(req, res) {
    try {
        const body = await extract_json(req),
            start_num = +body["start"] || 1,
            stop_num = +body["stop"] || 10,
            chunk_size = +body["chunk"] || 10,
            continuous = body["continuous"] || false,
            watch = body["watch"] || 1;
        var body_url = body["url"],
            index = (start_num > 0) ? start_num - 1 : 0; // index starts from 0 in this function
        console.log(`\nlist_init:\n\tbody_url: ${body["url"]}\n\tstart_num: ${body["start"]}\n\t` +
            `stop_num: ${body["stop"]}\n\tchunk_size: ${body["chunk"]}\n\t` +
            `continuous: ${body["continuous"]}\n\tindex: ${index}\n\twatch: ${body["watch"]}`);

        if (continuous) await sleep();

        const response_list = await list_spawner(body_url, start_num, stop_num);
        console.log(`\nresponse_list:\t${JSON.stringify(response_list, null, 2)}\n\tresponse_list.length: ${response_list.length}`);

        if (response_list.length > 1 || body_url.includes("playlist")) {
            await handlePlaylistOrChannel(body_url, watch);
        } else {
            body_url = "None";
            index = await getLastUnlistedVideoIndex();
        }

        processResponse(response_list, body_url, index)
            .then(function (init_resp) {
                try {
                    res.writeHead(200, corsHeaders(json_t));
                    res.end(JSON.stringify(init_resp));
                } catch (error) {
                    console.error(error);
                }
            }).then(function () {
                list_background(body_url, start_num, stop_num, chunk_size).then(
                    () => {
                        console.log(`\nDone processing playlist: ${body_url}`);
                        sock.emit("playlist-done", { message: "done processing playlist or channel" });
                    }
                );
            });
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}

async function handlePlaylistOrChannel(body_url, watch) {
    if (body_url.includes("youtube") && body_url.includes("/@")) {
        if (!/\/videos\/?$/.test(body_url)) {
            body_url = body_url.replace(/\/$/, "") + "/videos";
        }
        console.log(`\n${body_url} is a youtube channel`);
    }
    if (body_url.includes("pornhub") && body_url.includes("/model/")) {
        if (!/\/videos\/?$/.test(body_url)) {
            body_url = body_url.replace(/\/$/, "") + "/videos";
        }
        console.log(`\n${body_url} is a hub channel`);
    }

    const is_already_indexed = await play_lists.findOne({
        where: { url: body_url },
    });
    try {
        is_already_indexed.title.trim();
    } catch (error) {
        console.error("playlist or channel not encountered earlier, saving in playlist");
        await add_playlist(body_url, watch);
    }
}

async function getLastUnlistedVideoIndex() {
    try {
        const lastItem = await vid_list.findOne({
            where: { reference: "None" },
            order: [["list_order", "DESC"]],
            attributes: ["list_order"],
            limit: 1,
        });
        return lastItem?.list_order ?? 0;
    } catch (error) {
        console.error("Error getting last unlisted video index:", error);
        return 0;
    }
}

