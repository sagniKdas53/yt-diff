Add a TODO about how sometimes playlist may not be able to return details as they are not designed to do so case in point

https://archive.org/details/neongenesisevangelionIIflac

Make sure in those cases if the video's are multiple in number we need to use 
the url to make a playlist entry so that the listing doesn't fail



-----------------------------------------

level=warn msg="makeSignedUrl missing parameters" ts=2026-04-02T21:44:53.113Z requestBody="{\"saveDirectory\":\"\",\"fileName\":null}"
level=trace msg="Rate limit check for IP 127.0.0.1" ts=2026-04-02T21:44:59.846Z
level=debug msg="Rate limiting disabled (maxRequestsPerWindow is 0)" ts=2026-04-02T21:44:59.846Z
level=trace msg="Processing URL list" ts=2026-04-02T21:44:59.848Z urlCount=1 chunkSize=10 monitoringType="N/A"
level=debug msg="Checking URL in database" ts=2026-04-02T21:44:59.849Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="Video found in database" ts=2026-04-02T21:44:59.853Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="Video already downloaded" ts=2026-04-02T21:44:59.853Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=trace msg="Listing 0 items concurrently (chunk size: 10)" ts=2026-04-02T21:44:59.854Z
level=trace msg="No items to list" ts=2026-04-02T21:44:59.854Z
level=debug msg="Listing processes started" ts=2026-04-02T21:44:59.855Z itemCount=0
level=trace msg="Rate limit check for IP 127.0.0.1" ts=2026-04-02T21:45:23.403Z
level=debug msg="Rate limiting disabled (maxRequestsPerWindow is 0)" ts=2026-04-02T21:45:23.403Z
level=trace msg="Processing URL list" ts=2026-04-02T21:45:23.405Z urlCount=1 chunkSize=10 monitoringType="Refresh"
level=debug msg="Checking URL in database" ts=2026-04-02T21:45:23.405Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="Video found in database" ts=2026-04-02T21:45:23.428Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="Video already downloaded" ts=2026-04-02T21:45:23.428Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=trace msg="Listing 0 items concurrently (chunk size: 10)" ts=2026-04-02T21:45:23.428Z
level=trace msg="No items to list" ts=2026-04-02T21:45:23.428Z
level=debug msg="Listing processes started" ts=2026-04-02T21:45:23.428Z itemCount=0
level=debug msg="Received video delete request" ts=2026-04-02T21:45:53.731Z requestBody="{\"playListUrl\":\"None\",\"videoUrls\":[\"https://archive.org/details/neongenesisevangelionIIflac\"],\"cleanUp\":true,\"deleteVideoMappings\":true,\"deleteVideosInDB\":true}"
level=debug msg="Removing files for video" ts=2026-04-02T21:45:53.757Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" filesToRemove="{\"fileName\":null,\"thumbNailFile\":null,\"subTitleFile\":null,\"commentsFile\":null,\"descriptionFile\":null}"
level=trace msg="Fetching playlist videos" ts=2026-04-02T21:45:53.987Z startIndex=32 endIndex=40 searchQuery="" sortBy="positionInPlaylist" sortDirection="ASC" playlistUrl="None"
level=trace msg="Rate limit check for IP 127.0.0.1" ts=2026-04-02T21:46:00.375Z
level=debug msg="Rate limiting disabled (maxRequestsPerWindow is 0)" ts=2026-04-02T21:46:00.375Z
level=trace msg="Processing URL list" ts=2026-04-02T21:46:00.382Z urlCount=1 chunkSize=10 monitoringType="N/A"
level=debug msg="Checking URL in database" ts=2026-04-02T21:46:00.383Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="URL not found in database, adding to list" ts=2026-04-02T21:46:00.404Z url="https://archive.org/details/neongenesisevangelionIIflac"
level=trace msg="Listing 1 items concurrently (chunk size: 10)" ts=2026-04-02T21:46:00.406Z
level=trace msg="Starting listing with semaphore: {\"url\":\"https://archive.org/details/neongenesisevangelionIIflac\",\"type\":\"undetermined\",\"currentMonitoringType\":\"N/A\",\"reason\":\"URL not found in database\"}" ts=2026-04-02T21:46:00.406Z
level=debug msg="Listing semaphore acquired, current concurrent: 1" ts=2026-04-02T21:46:00.406Z
level=debug msg="Listing processes started" ts=2026-04-02T21:46:00.406Z itemCount=1
level=debug msg="isScheduledUpdate: false" ts=2026-04-02T21:46:00.407Z item="{\"url\":\"https://archive.org/details/neongenesisevangelionIIflac\",\"type\":\"undetermined\",\"currentMonitoringType\":\"N/A\",\"reason\":\"URL not found in database\"}" isScheduledUpdate=false
level=trace msg="Starting streaming fetch for items" ts=2026-04-02T21:46:00.408Z url="https://archive.org/details/neongenesisevangelionIIflac" processKey="pending_https://archive.org/details/neongenesisevangelionIIflac_1775166360407" startIndex=1
level=debug msg="Starting streaming listing for https://archive.org/details/neongenesisevangelionIIflac" ts=2026-04-02T21:46:00.408Z url="https://archive.org/details/neongenesisevangelionIIflac" fullCommand="yt-dlp --proxy http://proton:n436b5CXcPkrRbKADE1VUhq@192.168.0.110:3128 --playlist-start 1 --dump-json --no-download https://archive.org/details/neongenesisevangelionIIflac"
level=debug msg="List process closed" ts=2026-04-02T21:46:04.489Z pid=235699 code=0
level=trace msg="Processing video information chunk" ts=2026-04-02T21:46:04.492Z playlistUrl="None" chunkStartIndex=69 isUpdate=false itemCount=25
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.495Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="01 - Yokan.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="02 - Zankoku na Tenshi no These [TV Size Version].flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="03 - BORDERLINE CASE.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="04 - A Crystalline Night Sky.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="05 - ANGEL ATTACK II.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="06 - ANGEL ATTACK III.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="07 - Both of you, Dance Like You Want to Win!.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="08 - Waking up in the morning.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="09 - BACKGROUND MUSIC.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="10 - A Moment When Tension Breaks.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="11 - The Day Tokyo-3 Stood Still.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="12 - Spending Time in Preparation.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="13 - She said, Don't make others suffer for your personal hatred.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="14 - MAGMADIVER.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.496Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="15 - PLEASURE PRINCIPLE.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="16 - THE BEAST II.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="17 - THANATOS.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="18 - Rei III.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="19 - When I Find Peace of Mind.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="20 - FLY ME TO THE MOON [TV. Size Version].flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="21 - FLY ME TO THE MOON [Rei(#5)TV. Size Remix Version]1.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="22 - FLY ME TO THE MOON [Rei(#6)TV. Remix Version]1.flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="23 - Jikai Yokoku [15 Second Version].flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="24 - FLY ME TO THE MOON [Aya Bossa Techno Version].flac" playlistUrl="None" index=69
level=debug msg="Processed video item in memory" ts=2026-04-02T21:46:04.497Z videoUrl="https://archive.org/details/neongenesisevangelionIIflac" title="25 - FLY ME TO THE MOON [Aki Jungle Version].flac" playlistUrl="None" index=69
level=error msg="Listing failed" ts=2026-04-02T21:46:04.522Z url="https://archive.org/details/neongenesisevangelionIIflac" error="ON CONFLICT DO UPDATE command cannot affect row a second time" stack="Error\n    at Query.run (file:///home/sagnik/Projects/docker-composes/yt-diff/node_modules/.deno/sequelize@6.37.8/node_modules/sequelize/lib/dialects/postgres/query.js:50:25)\n    at file:///home/sagnik/Projects/docker-composes/yt-diff/node_modules/.deno/sequelize@6.37.8/node_modules/sequelize/lib/sequelize.js:315:28\n    at async PostgresQueryInterface.bulkInsert (file:///home/sagnik/Projects/docker-composes/yt-diff/node_modules/.deno/sequelize@6.37.8/node_modules/sequelize/lib/dialects/abstract/query-interface.js:346:21)\n    at async recursiveBulkCreate (file:///home/sagnik/Projects/docker-composes/yt-diff/node_modules/.deno/sequelize@6.37.8/node_modules/sequelize/lib/model.js:1697:25)\n    at async video_metadata.bulkCreate (file:///home/sagnik/Projects/docker-composes/yt-diff/node_modules/.deno/sequelize@6.37.8/node_modules/sequelize/lib/model.js:1786:12)\n    at async processStreamingVideoInformation (file:///home/sagnik/Projects/docker-composes/yt-diff/index.ts:3905:5)\n    at async handleSingleVideoStreaming (file:///home/sagnik/Projects/docker-composes/yt-diff/index.ts:3578:20)\n    at async executeListing (file:///home/sagnik/Projects/docker-composes/yt-diff/index.ts:3373:14)\n    at async listWithSemaphore (file:///home/sagnik/Projects/docker-composes/yt-diff/index.ts:3233:20)\n    at async Promise.all (index 0)"
level=trace msg="Listing completed" ts=2026-04-02T21:46:04.522Z result="{\"url\":\"https://archive.org/details/neongenesisevangelionIIflac\",\"title\":\"Video\",\"status\":\"failed\",\"error\":\"ON CONFLICT DO UPDATE command cannot affect row a second time\"}" listEntry="{\"url\":\"https://archive.org/details/neongenesisevangelionIIflac\",\"type\":\"undetermined\",\"lastActivity\":1775166364489,\"spawnTimeStamp\":1775166360417,\"status\":\"completed\",\"spawnedProcess\":null}"
level=debug msg="Listing semaphore released" ts=2026-04-02T21:46:04.522Z
level=error msg="Failed to list Video: {\"url\":\"https://archive.org/details/neongenesisevangelionIIflac\",\"title\":\"Video\",\"status\":\"failed\",\"error\":\"ON CONFLICT DO UPDATE command cannot affect row a second time\"}" ts=2026-04-02T21:46:04.522Z
^CWatcher Waiting for graceful termination...