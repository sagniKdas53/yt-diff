# Todo

1. [x] Make the code more organized and easier to find and rewrite.
2. [x] In bulk-listing mode, adding playlists makes their `list_order` not update properly, fix it.
3. [x] Lastly add the way to schedule the updates to the playlist by adding a watch property and it's schduling
   1. [x] To do this the playlist table will need to updated such that it can accomodate the changes
   2. [x] The presentaion in DBI needs to be updated
   3. [x] Make the fucntions that will bind to `update-makers` class check boxes and trigger XHR requests to backend to update the playlist watch status
   4. [x] Need to make sure that the playlist that will be updated
   5. [x] The cron npm package works fine and can be used as the main timer to periodicallly look for lists that are marked to be updated
      1. [x] Based on the cron expression and updatedAt it can update them [Rejected]
      2. [x] Or it can update the lists every time it's triggered, it won't have the granular control but then again it's such a hassle to run a timer for very playlist
4. [ ] Figure out why some vidoes are being marked as duplicate despite being not the case. (Happens only on some sites)
   1. [ ] It's a site specific problem, nothing can be done for now
5. [x] Rewrite the backend in express.js [Rejected]
   1. [x] The api is served by express 
   2. [x] The static files from the react app are also served by express
    [ ] Write the readme.md and usage.
6. [ ] Add a way to add videos to multiple playlists, way harder to than it needs to be, really.
7. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
8. [ ] As it stands now just clean up the httpServer code
9. [ ] Implement a healtch check
10. [ ] Implement download_background_parallel()
11. [ ] Add an api end point where the video (yes this will only be for single videos) is sent as a POST request and is indexed and downloaded.

## Watcher

I plan on adding, auto downloading but I am not feelin "it" so I will do it someday.
