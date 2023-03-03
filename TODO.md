# Todo

1. [x] Make the code more organized and easier to find and rewrite.
2. [ ] Add a way to add videos to multiple playlists, way harder to than it needs to be, really.
3. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
4. [ ] Lastly add the way to schedule the updates to the playlist by adding a watch property and it's schduling
   1. [x] To do this the playlist table will need to updated such that it can addcomodate the changes
   2. [x] The presentaion in DBI needs to be updated
   3. [ ] Make the fucntions that will bind to `update-makers` class check boxes and trigger XHR requests to backend to update the playlist watch status
   4. [ ] Need to make sure that the playlist that will be updated have two modes
      1. [ ] Writing the code is easy, getting the input form front end is the hard part, I just can't figure out how to make a intuitive way to ask the user to select the choices for watching, among the choices of not watching for updates, only looking for updatesm or updating the full playlist
      2. [ ] TBH manually updating the full playlist seems better than haveing a full playlist update every scheduled update, the performance will suffer too, I will debate in my mind if removing the full_update seems like a better solution or not.
      3. [ ] Maybe adding them to the main page wouldn't be such a bad idea
      4. [ ] On that note the option to keep chunk empty and thus only list the url from the start to stop and no more could be a good addition
      5. [ ] Look for new (ie: will start listing from the last index that's saved in DB) / quick_update
      6. [ ] Update all / full_update
   5. [ ] The cron npm package works fine and can be used as the main timer to periodicallly look for lists that are marked to be updated
      1. [x] Based on the cron expression and updatedAt it can update them [Rejected]
      2. [ ] Or it can update the lists every time it's triggered, it won't have the granular control but then again it's such a hassle to run a timer for very playlist
5. [ ] Figure out why some vidoes are being marked as duplicate despite being not the case. (Happens only on some sites)
6. [ ] Implement download_background_parallel()
7. [ ] Rewrite the frontend in vue (learning it currently)

## Watcher

Now I have an Idea that is to add an event listener to the class of update-makers
whenever one of them is checked or uncheck the playlist url is sent as an xhr request
that will be recieved and consequently mark the playlist to be updated whenever the
next scheduled update is, but I still have no idea how to handle the full update thing.

```javascript
const CronJob = require("cron").CronJob;
new CronJob(
  "0 */12 * * *",
  function () {
    console.log(new Date().toLocaleTimeString());
    /* 
      This funtion could serve as the main watcher,
      where all the playlists that have a watch field set to true will
      be updated based on the field fill_update, if it's set to true the
      whole playlist will be updated else only the newest vidoes will be looked for.
    */
  },
  null,
  true,
  process.env.time_zone || "Asia/Kolkata"
).start();
```
