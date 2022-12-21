# yt-dlp-diff-maker

yt-dlp packed in together with my little script to regularly keep dowining vidoes from youtube and some other site

## How to start?

  1. ```` docker build -t purevert/yt-diff . ````
  2. ```` docker-compose up -d ````
  3. ```` docker exec -it yt-diff /bin/bash ````
  4. ```` yt-dlp_linux --flat-playlist --print "%(title)s [%(id)s]-{%(webpage_url)s}" https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b >> test2.tx ````
  5. TODO
  6. Test VPN by using ```` docker exec -it vpn-proton wget -qO- https://ipinfo.io ````
  7. ```` yt-dlp --playlist-start 1 --playlist-end 10 --flat-playlist --print "%(title)s [%(id)s]-{%(webpage_url)s}" https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b ````

## TODO

- [x] Add a VPN to download without geo restriction.
- [ ] Add the rest of the functionality of diff-maker.ipynb
  - [x] Find soething better faster and smaller than python
  - [x] Maybe rust
  - [ ] Nodjs it is
- [x] Test if cURLing form github is viable or not
  - [x] wget is better
  - [x] Else build form the git clone
- [x] Make a docker-compose.yml
- [ ] Push to docker hub
- [x] Make a usable readme file
- [ ] [OPTIONAL] Make a web-ui
- [ ] Make the conatiner a manually triggered one such that passing the url will make it download it and keep track of the downloads
  - [ ] Add a db {postgresql is the choice for now}
- [ ] Since the current version runs all the time making it a service that runs in the background and checks if new vidoes are available and then downloads it.
