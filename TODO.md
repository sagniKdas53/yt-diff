# Todo

1. [ ] Split this giant script into smaller blocks, and then import functions so that it's more manageable.
   1. [ ] Now that we have moved to deno we can use ES modules to import/export functions and classes.
   2. [ ] Make sure to keep the main.ts file as the entry point, and have it import functions from other files.
   3. [ ] Make sure to keep the database related functions in a separate file, the API related functions in another file, and the utility functions in another file.
   4. [ ] Make sure to keep the cron job related functions in another file.
2. [ ] Fix the login issue, where the token validation takes so long (due to the new bcryptjs library) that the request shows as not logged in.
3. [ ] Recreate the update playlist functionality, which was broken during the migration to the new database structure (I forgot how it worked exactly).
4. [ ] Add a retry mechanism for videos, It will work something like this
   1. [ ] A video is submitted for listing or downloading
   2. [ ] If it fails, because it needs login
   3. [ ] Then we check if we have valid login or netrc details
   4. [ ] If we do, we refresh the login token and retry the operation
   5. [ ] If it fails again, we mark it as failed and log the error
   6. [ ] If we don't have valid login or netrc details, we mark it as failed and log the error
5. [x] Add delete APIs
   1. [x] One for video objects, it will have a boolean attribute to delete from disk if true. Now that other file are tracked we can safely delete those as well
   2. [x] And one for playlists, it can have two booleans to delete the videos in it as well as to delete the downloaded files in it
6. [x] Add a way to sync metadata from the disk to the video_metadata table like say use the filename to glob the subs file(.vtt), the thumbnail and the description and then mark that the data has been synced
7. [x] Need to add confirmations for deletes
8. [x] Add context action on front-end to get the thumbnail, subs and also download ~~all of the content as a zip~~.
9. [ ] Re-create the scheduled updates thingy and also make the cron-job for it
10. [x] ~~Remove the sortOrder from playlist_metadata table, replace it with the createdAt field, for the "None" playlist we can set the createdAt to be unix epoch so that the existing filtering logic doesn't break~~
11. [x] Find a way to test out the cleanup CronJob, since most things don't get stuck and even if they do they keep working on the back this is hard to test, the only thing that works is downloading [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) don't know how to simulate listing getting stuck
12. [x] Download Cleanup - Works
13. [x] Listing Cleanup - Works, tested with a playlist haveing 4897 entries, it got stuck after 3056 entries.
14. [x] Add an exception for x.com posts being treated as playlists (even if a post has multiple videos we can't list them as their IDs are same and this breaks listing so the best way is to make them a single unlisted item, when downloaded by yt-dlp we will get all the items anyway)
15. [x] Fix the docker image, we need pip so that we can install yt-dlp from pip and also add the [recommended packages](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#dependencies)
16. [x] Fix [#35](https://github.com/sagniKdas53/yt-diff/issues/35), from my initial tests it looks like the page switching mechanism on the front-end is broken (I think I have a fix for this but haven't tested it yet)
17. [x] Need to add deno because soon we will need it for youtube extractors, see [yt-dlp#14404](https://github.com/yt-dlp/yt-dlp/issues/14404)
18. [x] Fix the issue where if you are on the same page where the new playlist is supposed to appear it doesn't until the the page is changed, this happens because the re-fetch trigger for playlists is the index of the playlist so when a new one is added and a web hook event is recieved it check that we are on the same page and there is no need to change the page so it doen't re-fetch the playlists
19. [x] Fix the issue where there is a descripency in the number of items to list, in the dialog box it says 50 but it's actually 64 (2^6), the progression should be 2^0,2^3,2^5,2^6 (maybe 2^7 would be better as we are going in a series of 2^(odd numbers))
20. [x] Fix the issue where meta data update is not clear log line `2025-11-16T04:55:38.811395865Z level=trace msg="Checking video metadata for updates" ts=2025-11-16T04:55:38.811Z videoId="NA" newData=[object Object]` use the videoUrl insted of ID is it's not always unque
21. [x] Add an option to use the --proxy URL option of yt-dlp so that we don't need to mount the entire stack on gluetun insted we can expose a port though gluetun+squid so that we can do something like `--proxy http://proxy_user:proxy_pass@proxy_server:proxy_port`
