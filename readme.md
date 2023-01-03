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
  8. ```` yt-dlp -f "bv*[height<=480]+ba/b[height<=480] / wv*+ba/w" https://www.youtube.com/watch?v=C6aCCp-Umcw --sponsorblock-remove sponsor ````
  9. ```` docker run -it -p 8888:8888 -v /home/sagnik/Projects/yt-diff/yt-dlp:/home purevert/yt-diff  /bin/bash ````

## TODO

- [x] Add a VPN to download without geo restriction.
- [x] Add the rest of the functionality of diff-maker.ipynb
  - [x] Find soething better faster and smaller than python
  - [x] Maybe rust
  - [x] Nodjs it is
- [x] Test if cURLing form github is viable or not
  - [x] wget is better
  - [x] Else build form the git clone
- [x] Make a docker-compose.yml
- [ ] Push to docker hub
- [x] Make a usable readme file
- [x] Make a web-ui
- [ ] Finsih the web-ui
  - [ ] Add a way to see the db from the webui, ie see if the files are downloaded or not, Not via adminer.
  - [ ] Like if you put in a playlist it will show you how much you have, if you have files that were downloaded they would be listed as such.
  - [ ] If you have files and db entries for vidoes that were taken down then the db will be updated to set the availability as false and the files will be maked as not available online.
  - [ ] Lastly a way to download all the files that aren't downloaded as shown by the db.
- [x] Make the conatiner a manually triggered one such that passing the url will make it download it and keep track of the downloads
- [ ] Make a container stack that works together using docker-compose
  - [x] Add a db {postgresql is the choice for now}
  - [ ] Convert the ubuntu container to a node container that will have
    - [ ]  ability to execute cURL commands to get yt-dlp and ffmpeg
    - [ ]  use the binaries
    - [ ]  Connect to the db
    - [ ]  Connect via VPN if getting throttled
- [ ] Since the current version runs all the time making it a service that runs in the background and checks if new vidoes are available and then downloads it.
- [ ] Add support for sponcer blocking
- [ ] Add a system to show the progress of the download using socket io if the page is kept open
- [ ] Add a way to select the quality and formats that yt-dlp can download
  - [ ] Idea: in the list of the listed vidoes displayed after posting to the /list
  - [ ] clicking on any list item will open a new tab
  - [ ] It can be an end point like /check/uid
  - [ ] The format and thumbnail of the vidoes will be shown along with the ways to  specify the quality and formats that will be saved
  - [ ] These details will be saved to the db
  - [ ] The db schema will thus need to be updated
  - [ ] When downloading we already are querying the item from db so finding out the format and adding the necessary flags would be doable
- [ ] Find out if listings the vidoes can be improved
- [ ] Add a navlink that will take the user to a page where they can see the URLs that have been added to the db and downloaded
  - [ ] Similarly add another navlink for vidoes that have been added but not downloaded
  - [ ] Lastly add a link to page where we can see the vidoes that are downloaded but no longer available online
  - [ ] To make this possible add a link in the pages makes the system look up changes
  - [ ] All the parent URLs will be queried with the start and stop numbers
  - [ ] Yes the start and stop numbers also need to be saved in the db
- [ ] When the lookup is done each and every entry is fetched again and will be evaluated for the download status
  - [ ] If unavailable the available will be set to false then the entry will be listed in this section.
