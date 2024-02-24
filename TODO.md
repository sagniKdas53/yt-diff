# Todo

## Current:

1. [x] use play_list_index to show the section where the playlist got added in the front end
2. [x] add a persistent theme saving using local storage
3. [ ] add a login to the webpage and auth to the api
4. [ ] Test and find out why fast update is bugging out
5. [ ] Make a cleanup script that can remove the duplicates that were erroneously made by the fast update


# Old version:
3. [ ] Found an edge case error when the index(start) value of the list request is divisible by 10 it causes the sublist to load the next page and not the page with the video itself. [Needs more testing]
4. [ ] Add an update endpoint, I don't know if it's a good idea to do it though.
5. [ ] Is adding an endpoint where sending a url as a post request, saved it to db and then downloads it a good idea? I can do it but is it really okay to do it?
6. [ ] Get help for the react virtuoso. This if for my reference:
   1. [ ] The error that I am facing is whenever a button is clicked or a checkbox is checked the state of the table gets updated
   2. [ ] This causes the table to re-render, although all if the data is preserved due to state, the scroll position is not retained.
   3. [ ] I have tried saving the position of the table scroll bar and using the scrollbar ref to just to the last position but capturing the last position and scrolling is not working as expected.
7. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
8. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
9.  [ ] Implement download_background_parallel()
10. [ ] Write the readme.md
