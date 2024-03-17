async function list_background_download(
  body_url,
  start_num,
  stop_num
) {
  trace(
    `list_background: URL: ${body_url},` +
    `Start: ${start_num}, Stop: ${stop_num}`
  );
  const response = await list_spawner(body_url, start_num, stop_num);
  debug(`response length: ${response.length}`);
  if (response.length === 0) {
    trace(
      `Listing exited at Start: ${start_num}, Stop: ${stop_num}`
    );
  }
  // yt-dlp starts counting from 1 for some reason so 1 needs to be subtracted here.
  await process_response(
    response,
    "None",
    start_num - 1,
    true
  );
  await sleep();
  const video_item = await video_list.findOne({
    where: { video_url: body_url },
  });
  await download_sequential([[
    body_url,
    video_item.title,
    "",
    video_item.video_id,
  ]]);
}