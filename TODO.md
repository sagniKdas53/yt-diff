# Todo

1. [ ] Split this giant script into smaller blocks, and then import functions so that it's more manageable.
2. [ ] Add delete APIs
   1. [ ] One for video objects, it will have a boolean attribute to delete from disk if true. Now that other file are tracked we can safely delete those as well
   2. [ ] And one for playlists, it can have two booleans to delete the videos in it as well as to delete the downloaded files in it
3. [ ] Add a way to sync metadata from the disk to the video_metadata table like say use the filename to glob the subs file(.vtt), the thumbnail and the description and then mark that the data has been synced
4. [ ] Once we can sync the meta data add a context action on front-end to get the thumbnail, subs and also download all of the content as a zip.
5. [ ] Re-create the scheduled updates thingy and also make the cron-job for it
6. [ ] Need
7. [ ] Find a way to test out the cleanup CronJob, since most things don't get stuck and even if they do they keep working on the back this is hard to test, the only thing that works is downloading [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) don't know how to simulate listing getting stuck
   1. [x] Download Cleanup - Works
   2. [ ] Listing Cleanup - Can't replicate
8. [ ] Also in the same way need to add a menu to each item so that we do context action on them like fetch the thumbnail, download the file, get the subtitle and also delete the file from disk (and mark as undownloaded, so that we can download again)
9. [x] Add an exception for x.com posts being treated as playlists (even if a post has multiple videos we can't list them as their IDs are same and this breaks listing so the best way is to make them a single unlisted item, when downloaded by yt-dlp we will get all the items anyway)
10. [ ] Fix the docker image, we need pip so that we can install yt-dlp from pip and also add the [recommended packages](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#dependencies)
11. [ ] Fix [#35](https://github.com/sagniKdas53/yt-diff/issues/35)
