# Concurrent Downloading and Semaphore Logic

`yt-diff` implements a robust **Semaphore-based Concurrency Control** system to
limit hardware stress, restrict network bandwidth, and prevent duplicate
identical spawns when physically downloading video files via `yt-dlp`.

## 1. Triggering the Download

When the client UI fires a physical download request natively (via `/download`
API endpoint), it provides an array of `videoUrl`s belonging to a specific
playlist context.

1. **DB Verification**: The server iteratively checks the `VideoMetadata` table
   to confirm the videos actually exist in the database system.
2. **Path Association**: The server fetches the `saveDirectory` from the
   associated `PlaylistMetadata` so it knows physically where on disk the file
   needs mapping to.
3. The queue pushes the assembled task objects into an array `videosToDownload`
   and feeds them straight into the **Concurrent Orchestrator**
   `downloadItemsConcurrently()`.

## 2. The Concurrency Orchestrator (`downloadItemsConcurrently`)

This function dynamically throttles how many child processes are executed by
leveraging a custom class-based Semaphore (`DownloadSemaphore`).

1. **Dynamic Config**: It forces the semaphore's maximum concurrent limit via
   `DownloadSemaphore.setMaxConcurrent(maxConcurrent)` mapped directly to the
   server environment's config `config.queue.maxDownloads` limit.
2. **Duplicate Filtration**: It sweeps the internal map tracker
   (`downloadProcesses`) to filter out URLs that are _already actively in the
   queue_ (`"running"` or `"pending"` status). This blocks eager users pushing
   the download button on the UI ten times successively and generating 10
   parallel overlapping subprocesses targeting the same file.
3. **Promise Aggregation**: It fires a mapped `Promise.all()` passing remaining
   unique items into the `downloadWithSemaphore()` wrapper function.

## 3. The Semaphore Lock (`downloadWithSemaphore`)

This serves as the atomic lock handler controlling process creation timing.

1. **Acquiring the Lock**: The thread calls `await DownloadSemaphore.acquire()`.
   If 2 active downloads are running, and the limit is 2, the thread halts its
   execution linearly right here until a previous download finishes and releases
   its lock token.
2. **Tracking Initialization**: Once a lock token is acquired, a unique
   `entryKey` is generated using the URL and timestamp
   (`pending_http..._1701241...`).
3. An entry is pushed to the global `downloadProcesses` Map setting the download
   to a `"pending"` state.
4. The system invokes the actual physical downloader via `executeDownload()`.
5. **Always Release**: Inside a strict `try/finally` block, regardless of if the
   video succeeded, errored out due to IP blocks, or crashed—the code will
   **always** call `DownloadSemaphore.release()`. The pending entry is safely
   deleted from the map, freeing up space globally for the next video waiting in
   line.

## 4. The Subprocess Executor (`executeDownload`)

This is where the child shells are instantiated interacting with `yt-dlp`.

1. **Spawn**: `spawn("./yt-dlp", args)` initializes. The global tracking map
   updates the entry to `"running"` and specifically attaches the raw
   `ChildProcess` object into the Map. This allows cleanup workers to target and
   defensively kill stalled/zombie `yt-dlp` instances directly using
   `.kill('SIGTERM')` calls in the future.
2. **WebSocket Notifications**: `safeEmit("download-started", data)` shoots a
   real-time WebSocket event back to the client UI bridging the network.
3. **Standard Out (stdout)**: The system reads stdout data chunks on the fly
   from the subprocess. A regex stream `(\d{1,3}\.\d)` consistently pulls the
   progress percentage tracking from `yt-dlp`.
4. **Metadata Overwrite**: Finally, upon successful process `close` with a `0`
   code exit, `yt-diff` automatically updates `VideoMetadata` explicitly
   flagging `downloadStatus` as `true` and saving the exact strings of generated
   filenames (e.g., `fileName`, `thumbNailFile`) directly to the relational
   database.
