# Todo

1. [ ] Fix the issue with unlisted vidoes being so hard to find, they need proper indexing to not be a mess
   1. The idea is simple either make the indexing increase every time or
   2. Make a separate table for the unlisted videos there they can have autoincrementing indexes and if they are infact added to any playlist they can just be removed leaving a blank index
   3. Which during manintaincance can be fixed
   4. Alternatively just sort the table by updatedAt in DESC mode
2. [x] Make sure that listing on the main page which disable download on database interface is corrected when listing is done
3. [ ] Figure out why some vidoes are being marked as duplicate despite being not the case.
4. [ ] Add a rate limiter to the socket.io, docs [here](https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
5. [x] The nav-icon and text are not properly aligned.
6. [ ] Test to see if regex can be more effecient at identifying urls
   1. Something like this /https:\/\/www\.youtube\.com\/@.\*\/videos/gm perhaps
7. [x] Handle youtube channels
8. [x] Test if chunking is working properly
   1. It wasn't, i had made a stupid mistake as usual
9. [ ] Add a way to add videos to multiple playlists
10. [ ] Use webpack or glup to pack the project up
11. [ ] I don't really like it as webpack more about form over function, too much coad for too little work
12. [ ] Add a way to search for strings in the sub_lists in the database page and even the main page
13. [ ] Lastly add the way to schedule the updates to the playlist by adding a watch property and it's schduling
14. [ ] Maybe add the table sorting feature using bootstrap-table js
