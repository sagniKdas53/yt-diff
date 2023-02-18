async function list(req, res) {
    var body = "",
        resp_json = { count: 0, rows: [] };
    req.on("data", function (data) {
        body += data;

        if (body.length > 1e6) req.connection.destroy();
    });
    req.on("end", async function () {
        body = JSON.parse(body);
        console.log(
            "body_url: " + body["url"],
            "start_num: " + body["start"],
            "stop_num:",
            body["stop"]
        );
        var body_url = body["url"];
        var start_num = body["start"] || 1;
        var stop_num = body["stop"] || 10;
        var chunk_size = body["chunk_size"] || 10;
        const response_list = await spawnYtDlp(body_url, start_num, stop_num);
        if (response_list.length > 1 && body_url.includes("playlist")) {
            let title_str = "";
            var is_alredy_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_alredy_indexed.changed("updatedAt", true);
                await is_alredy_indexed.save();
                console.log("playlist updated");
                title_str = is_alredy_indexed.title;
            } catch (error) {
                console.log("playlist not encountered");
            }
            if (title_str == "") {
                const get_title = spawn("yt-dlp", [
                    "--playlist-end",
                    1,
                    "--flat-playlist",
                    "--print",
                    "%(playlist_title)s",
                    body_url,
                ]);
                get_title.stdout.on("data", async (data) => {
                    title_str += data;
                });
                get_title.on("close", (code) => {
                    play_lists.findOrCreate({
                        where: { url: body_url },
                        defaults: { title: title_str },
                    });
                });
            }
        } else if (response_list == "") {
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify({ count: 0, rows: "" }, null, 2));
        } else {
            body_url = "None";
        }

        Promise.all(
            response_list.map(async (element) => {
                var items = element.split("\t");

                try {
                    var available_var = true;
                    if (
                        items[0] === "[Deleted video]" ||
                        items[0] === "[Private video]"
                    ) {
                        available_var = false;
                    }
                    const [found, made] = await vid_list.findOrCreate({
                        where: { url: items[2] },
                        defaults: {
                            id: items[1],
                            reference: body_url,
                            title: items[0],
                            downloaded: false,
                            available: available_var,
                        },
                    });

                    if (found) {
                        console.log("Updating entry");
                        resp_json["count"] += 1;
                        resp_json["rows"].push(found);

                        found.changed("updatedAt", true);
                    } else if (made) {
                        resp_json["count"] += 1;
                        resp_json["rows"].push(made, null, 2);
                    }
                } catch (error) {
                    console.error(error);
                }
            })
        ).then(function () {
            res.writeHead(200, { "Content-Type": "text/json" });
            res.end(JSON.stringify(resp_json, null, 2));
        }).then(function () {
            yt_dlp_spawner_promised(body_url, start_num, stop_num, chunk_size).then(
                () => {
                    console.log("done fr");
                }
            );
        });
    });
}
