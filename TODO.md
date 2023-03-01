# Todo

1. [ ] Fix the issue with unlisted vidoes being so hard to find, they need proper indexing to not be a mess
   1. The idea is simple either make the indexing increase every time or
   2. Make a separate table for the unlisted videos there they can have autoincrementing indexes and if they are infact added to any playlist they can just be removed leaving a blank index
   3. Which during manintaincance can be fixed
   4. Alternatively just sort the table by updatedAt in DESC mode
2. [x] Added search function to both the pages
3. [ ] Make the table header text cenetered and the search bar better integarted
4. [x] Make sure that listing on the main page which disable download on database interface is corrected when listing is done
5. [ ] Figure out why some vidoes are being marked as duplicate despite being not the case.
6. [ ] Add a rate limiter to the socket.io, docs [here](https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#websocket-single-connection-prevent-flooding)
7. [x] The nav-icon and text are not properly aligned.
8. [x] Test to see if regex can be more effecient at identifying urls
   1. Something like this /https:\/\/www\.youtube\.com\/@.\*\/videos/gm perhaps
   2. Yes it is infact better but regex hard
9. [x] Handle youtube channels
10. [x] Test if chunking is working properly
    1. It wasn't, i had made a stupid mistake as usual
11. [ ] Add a way to add videos to multiple playlists
12. [ ] Use webpack or glup to pack the project up
13. [ ] I don't really like it as webpack more about form over function, too much coad for too little work
14. [ ] Add a way to search for strings in the sub_lists in the database page and even the main page
15. [ ] Lastly add the way to schedule the updates to the playlist by adding a watch property and it's schduling
16. [ ] Maybe add the table sorting feature using bootstrap-table js
