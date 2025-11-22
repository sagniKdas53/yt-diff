# Todo

1. [ ] Split this giant script into smaller blocks, and then import functions so that it's more manageable.
2. [x] Add delete APIs
   1. [x] One for video objects, it will have a boolean attribute to delete from disk if true. Now that other file are tracked we can safely delete those as well
   2. [x] And one for playlists, it can have two booleans to delete the videos in it as well as to delete the downloaded files in it
3. [x] Add a way to sync metadata from the disk to the video_metadata table like say use the filename to glob the subs file(.vtt), the thumbnail and the description and then mark that the data has been synced
4. [x] Need to add confirmations for deletes
5. [x] Add context action on front-end to get the thumbnail, subs and also download ~~all of the content as a zip~~.
6. [ ] Re-create the scheduled updates thingy and also make the cron-job for it
7. [x] ~~Remove the sortOrder from playlist_metadata table, replace it with the createdAt field, for the "None" playlist we can set the createdAt to be unix epoch so that the existing filtering logic doesn't break~~
8. [x] Find a way to test out the cleanup CronJob, since most things don't get stuck and even if they do they keep working on the back this is hard to test, the only thing that works is downloading [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) don't know how to simulate listing getting stuck
   1. [x] Download Cleanup - Works
   2. [x] Listing Cleanup - Works, tested with a playlist haveing 4897 entries, it got stuck after 3056 entries.
9. [x] Add an exception for x.com posts being treated as playlists (even if a post has multiple videos we can't list them as their IDs are same and this breaks listing so the best way is to make them a single unlisted item, when downloaded by yt-dlp we will get all the items anyway)
10. [x] Fix the docker image, we need pip so that we can install yt-dlp from pip and also add the [recommended packages](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#dependencies)
11. [x] Fix [#35](https://github.com/sagniKdas53/yt-diff/issues/35), from my initial tests it looks like the page switching mechanism on the front-end is broken (I think I have a fix for this but haven't tested it yet)
12. [x] Need to add deno because soon we will need it for youtube extractors, see [yt-dlp#14404](https://github.com/yt-dlp/yt-dlp/issues/14404)
13. [x] Fix the issue where if you are on the same page where the new playlist is supposed to appear it doesn't until the the page is changed, this happens because the re-fetch trigger for playlists is the index of the playlist so when a new one is added and a web hook event is recieved it check that we are on the same page and there is no need to change the page so it doen't re-fetch the playlists
14. [x] Fix the issue where there is a descripency in the number of items to list, in the dialog box it says 50 but it's actually 64 (2^6), the progression should be 2^0,2^3,2^5,2^6 (maybe 2^7 would be better as we are going in a series of 2^(odd numbers))
15. [x] Fix the issue where meta data update is not clear log line `2025-11-16T04:55:38.811395865Z level=trace msg="Checking video metadata for updates" ts=2025-11-16T04:55:38.811Z videoId="NA" newData=[object Object]` use the videoUrl insted of ID is it's not always unque
16. [x] Add an option to use the --proxy URL option of yt-dlp so that we don't need to mount the entire stack on gluetun insted we can expose a port though gluetun+squid so that we can do something like `--proxy http://proxy_user:proxy_pass@proxy_server:proxy_port`
