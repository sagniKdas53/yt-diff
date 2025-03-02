# Todo

1. [ ] Split this giant script into smaller blocks, and then import fucntions so that it's more managebale.
1. [ ] Make a global config object that can be used to better enapsualte the functionality of this project.
1. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
1. [ ] Implement download_background_parallel()
1. [ ] Make the logging logfmt compatible so that it can be used in Loki
1. [ ] Add a mertics endpoint so that metrics can be exposed to Prometheus.
   1. [ ] How long listing and downloading actions take
   1. [ ] Memory and CPU usage of the spawned processes
   1. [ ] Number of times a endpoint is hit
   1. [ ] Number of auth requests both failed and successful along side with IP addresses
   1. [ ] Satus of the different caches used in the script
