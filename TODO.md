# Todo

1. [ ] Split this giant script into smaller blocks, and then import functions so that it's more manageable.
2. [ ] Add a delete API for playlists and videos
   1. [ ] make sure that there is a distinction that we can delete a playlist and the videos in it separately or together
3. [ ] Add a way to sync metadata from the disk to the video_metadata table like say use the filename to glob the subs file(.vtt), the thumbnail and the description and then mark that the data has been synced
4. [ ] Find a way to test out the cleanup CronJob, since most things don't get stuck and even if they do they keep working on the back this is hard to test, the only thing that works is downloading [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) don't know how to simulate listing getting stuck
   1. [x] Download Cleanup - Works
   2. [ ] Listing Cleanup - Can't replicate
5. [ ] Also in the same way need to add a menu to each item so that we do context action on them like fetch the thumbnail, download the file, get the subtitle and also delete the file from disk (and mark as undownloaded, so that we can download again)
6. [x] Add an exception for x.com posts being treated as playlists (even if a post has multiple videos we can't list them as their IDs are same and this breaks listing so the best way is to make them a single unlisted item, when downloaded by yt-dlp we will get all the items anyway)
7. [ ] Fix the docker image, we need pip so that we can install yt-dlp from pip and also add the [recommended packages](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#dependencies)
8. [ ] Fix [#35](https://github.com/sagniKdas53/yt-diff/issues/35)
