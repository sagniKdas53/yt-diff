# Todo

1. [ ] Found an edge case error when an unlisted video is added and the index is divisible by 10 it causes the video to load the next page and not the page with the video itself.
2. [ ] Although it doesn't really matter if a video is added many times, to the unlisted "None" playlist. I think it's shouldn't be done, so add a check here to find out if it's being added multiple times.
3. [ ] Add the way to get and process the download_list attribute for the list_and_download function
4. [x] Extract and save the size of videos too in the db this will make things easier to debug and prcoess
       see. [#test](/readme.md) [Doesn't work for most cases]
5. [x] Add a way to add videos to multiple playlists
   1. [x] Remodel the DB, to have a playlist_video_indexer that hold how the videos are related to the playlist.
   2. [x] Adding to the playlist_video_indexer with the unique constraint ["video_url", "playlist_url", "index_in_playlist"] doesn't work, needs more testing
   3. [x] Doing a join in the sublist to table is not working, needs more testing
6. [ ] Downloading functionality needs some work too
7. [ ] Get help for the react virtuiso
8. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
9. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
10. [ ] Implement download_background_parallel()
11. [ ] Write the readme.md
