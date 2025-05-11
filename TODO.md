# Todo

1. [ ] Split this giant script into smaller blocks, and then import functions so that it's more manageable.
1. [x] Make a global config object that can be used to better encapsulate the functionality of this project.
1. [x] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
1. [x] Implement download_background_parallel()
1. [x] Make Listing parallel as well using semaphores {Priority}
1. [x] Update the front-end to have a notification drawer so that when listing happens in parallel the events can be sent over web-sockets so that the user doesn't miss the entire thing
1. [x] Make the logging logfmt compatible so that it can be used in Loki
1. [ ] Fix the error message for failed login in front-end
1. [ ] Make the notifications better, like clicking on them makes them navigable and also add a way to make it scrollable and less ugly to look at.
1. [ ] Add a dismiss all button to the notification tab.
1. [x] Fix the username an user_name problem between DB and frontend
1. [ ] Return 11 or chunkSize+1 elements so that the pagination is activated
1. [ ] Fix the issue where after the full playlist is listed the sub list is going all the way to the end. This also happens sometimes when the querying is done (Probably need better clearing of indexes/pages in subList) [issue #35](https://github.com/sagniKdas53/yt-diff/issues/35)
1. [ ] Add ws handlers for the events where playlist listing doesn't change so the listing is skipped (in these cases the indeterminate is not changes so the loading effect persists, making it look like something is happening when it isn't)
1. [ ] Add the scheduled updater back.

## Very Long Term

1. [ ] Add a metrics endpoint so that metrics can be exposed to Prometheus.
   1. [ ] How long listing and downloading actions take
   1. [ ] Memory and CPU usage of the spawned processes
   1. [ ] Number of times a endpoint is hit
   1. [ ] Number of auth requests both failed and successful along side with IP addresses
   1. [ ] Status of the different caches used in the script
