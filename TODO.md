# Todo

1. [ ] Found an edge case error when an unlisted video is added and the index is divisible by 10 it causes the video to load the next page and not the page with the video itself.
2. [x] Extract and save the size of videos too in the db this will make things easier to debug and prcoess
       see. [#test](/readme.md) [Doesn't work for most cases]
3. [ ] Add a way to add videos to multiple playlists
   1. [x] Remodel the DB, to have a playlist_video_indexer that hold how the videos are related to the playlist.
   2. [ ] Adding to the playlist_video_indexer with the unique constraint ["video_url", "playlist_url", "index_in_playlist"] doesn't work, needs more testing
   3. [ ] Doing a join in the sublist to table is not working, needs more testing
4. [ ] Downloading functionality needs some work too
5. [ ] Get help for the react virtuiso
6. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
7. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
8. [ ] Implement download_background_parallel()
9. [ ] Write the readme.md
