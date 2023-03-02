# Todo

1. [ ] Make the code more organized and easier to find and rewrite.
2. [ ] Figure out why some vidoes are being marked as duplicate despite being not the case.
3. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
4. [ ] Add a way to add videos to multiple playlists
5. [ ] Use webpack or glup to pack the project up
6. [ ] I don't really like it as webpack more about form over function, too much coad for too little work
7. [ ] Lastly add the way to schedule the updates to the playlist by adding a watch property and it's schduling
   1. [ ] To do this the playlist table will need to updated such that it can addcomodate the changes
   2. [ ] The presentaion in DBI needs to be updated too
   3. [ ] The cron npm package works fine and can be used as the main timer to periodicallly look for lists that are marked to be updated
      1. [x] then based on the cron expression and updatedAt it can update them
      2. [ ] Or it can update the lists every time it's triggered, it won't have the granular control but then again it's such a hassle to run a timer for very playlist
   4. [ ] Need to make sure that the playlist that will be updated have two modes
      1. [ ] Look for new
      2. [ ] Update all
   5. [ ] Implement download_background_parallel()

## Watcher

```javascript
const CronJob = require("cron").CronJob;
new CronJob(
  "0 */12 * * *",
  function () {
    console.log(new Date().toLocaleTimeString());
    /* This funtion could serve as the main watcher */
  },
  null,
  true,
  process.env.time_zone || "Asia/Kolkata"
).start();
```
