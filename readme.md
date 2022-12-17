# yt-dlp-diff-maker

yt-dlp packed in together with my little script to regularly keep dowining vidoes from youtube and some other site

## How to start?

  1. docker build -t purevert/diff-maker .
  2. docker container run -d  -v /home/sagnik/Projects/diff-maker-yt-dlp/yt-dlp:/home --name diff-test purevert/diff-maker
  3. docker exec -it diff-test /bin/bash
  4. yt-dlp_linux --flat-playlist --print "%(title)s [%(id)s](%(webpage_url))" <https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b>
  5. yt-dlp_linux --flat-playlist --print "%(title)s [%(id)s]-{%(webpage_url)s}" <https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b> >> test2.tx
  6. TODO

## TODO

- [ ] Add the rest of the functionality of diff-maker.ipynb
  - [ ] Find soething better faster and smaller than python
  - [ ] Maybe rust
- [ ] Test if cURLing form github is viable or not
  - [ ] Else build form the git clone
- [ ] Make a docker-compose.yml
- [ ] Push to docker hub
- [ ] Make a usable readme file
- [ ] [OPTIONAL] Make a web-ui
- [ ] Make the conatiner a manually triggered one such that passing the url will make it download it and keep track of the downloads
  - [ ] Add a db
- [ ] Since the current version runs all the time making it a service that runs in the background and checks if new vidoes are available and then downloads it.
