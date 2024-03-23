# Todo
1. [ ] Use [lru-cache](https://www.npmjs.com/package/lru-cache) or redis for caching
2. [ ] Test and fix the progress bar
3. [ ] Authentication for the api
   1. [x] Add login and sign up in api
   2. [x] add api coverage to all important actions, like listing, downloading and changing the states of play lists
   3. [x] add a sign up component to the web application
   4. [x] Find out if using local storage is good enough or if I should go the cookies way
   5. [ ] Get the token expiry time from the sign in form
   6. [ ] Add a sign-up form and make it un-exploitable
   7. [x] Add caching of user data, and subsequent cleanup of it if implemented
      1. [ ] Move to better caching system
4. [ ] Test and find out why full update is bugging out
5. [ ] Add a rate limiter to the socket.io, docs [here](https:github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
6. [ ] Implement a global process limit and queue so that spawned processes can be kept in control and then killed when they go wrong [They often do]
7.  [ ] Implement download_background_parallel()
8.  [x] Write the readme.md
