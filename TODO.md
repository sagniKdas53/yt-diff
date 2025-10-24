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
8. [ ] Find a way to test out the cleanup CronJob, since most things don't get stuck and even if they do they keep working on the back this is hard to test, the only thing that works is downloading [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) don't know how to simulate listing getting stuck
   1. [x] Download Cleanup - Works
   2. [ ] Listing Cleanup - Can't replicate
9. [x] Add an exception for x.com posts being treated as playlists (even if a post has multiple videos we can't list them as their IDs are same and this breaks listing so the best way is to make them a single unlisted item, when downloaded by yt-dlp we will get all the items anyway)
10. [ ] Fix the docker image, we need pip so that we can install yt-dlp from pip and also add the [recommended packages](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#dependencies)
11. [ ] Fix [#35](https://github.com/sagniKdas53/yt-diff/issues/35), from my initial tests it looks like the page switching mechanism on the front-end is broken (I think I have a fix for this but haven't tested it yet)
12. [ ] Need to add deno because soon we will need it for youtube extractors, see [yt-dlp#14404](https://github.com/yt-dlp/yt-dlp/issues/14404)
