# Todo
1. [x] use play_list_index to show the section where the playlist got added in the front end
2. [x] add a persistent theme saving using local storage
3. [ ] Api auth action items
   1. [x] Add login and sign up in api
   2. [ ] add api coverage to all important actions, like listing, downloading and changing the states of play lists
   3. [ ] add a login and sign up component to the web application
   4. [ ] Find out if using local storage is good enough or if I should go the cookies way
   5. [ ] Get the token expiry time from the sign in form
   6. [ ] Add caching of user data, and subsequent cleanup of it if implemented [I don't think I will]
4. [ ] Test and find out why full update is bugging out
5. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
6. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
7.  [ ] Implement download_background_parallel()
8.  [ ] Write the readme.md
