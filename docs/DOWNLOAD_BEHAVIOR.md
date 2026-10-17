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
2. **Queue Position Tracking**: It assigns a `queuePosition` to each item being
   queued, allowing clients to fetch exactly where their items are in the queue
   via `/queuestatus` and socket updates.
3. **Duplicate Filtration**: It sweeps the internal map tracker
   (`downloadProcesses`) to filter out URLs that are _already actively in the
   queue_ (`"running"` or `"pending"` status). This blocks eager users pushing
   the download button on the UI ten times successively and generating 10
   parallel overlapping subprocesses targeting the same file.
4. **Promise Aggregation**: It fires a mapped `Promise.all()` passing remaining
   unique items into the `downloadWithSemaphore()` wrapper function.

## 3. The Semaphore Lock (`downloadWithSemaphore`)

This serves as the atomic lock handler controlling process creation timing.

1. **Tracking Initialization**: A unique `entryKey` is generated using the URL
   and timestamp (`pending_http..._1701241...`).
2. An entry is pushed to the global `downloadProcesses` Map setting the download
   to a `"pending"` state, along with its calculated `queuePosition`.
3. **Acquiring the Lock**: The thread calls `await DownloadSemaphore.acquire()`.
   If 1 active download is running, and the limit is 1, the thread halts its
   execution linearly right here until a previous download finishes and releases
   its lock token.
4. The system invokes the actual physical downloader via `executeDownload()`.
5. **Always Release**: Inside a strict `try/finally` block, regardless of if the
   video succeeded, errored out due to IP blocks, or crashed—the code will
   **always** call `DownloadSemaphore.release()`. The pending entry is safely
   deleted from the map, freeing up space globally for the next video waiting in
   line. When the queue size reaches zero, the `queueSequence` counter is reset.

## 4. The Subprocess Executor (`executeDownload`)

This is where the child shells are instantiated interacting with `yt-dlp`.

1. **Spawn**: `spawn("python3", ["-c", YT_DLP_PATCHED_CMD, ...args])`
   initializes (see
   [curl_cffi_segfault_analysis.md](curl_cffi_segfault_analysis.md) for the
   monkey-patch rationale). The global tracking map updates the entry to
   `"running"` and specifically attaches the raw `ChildProcess` object into the
   Map. This allows cleanup workers to target and defensively kill
   stalled/zombie `yt-dlp` instances directly using `.kill('SIGTERM')` calls in
   the future.
2. **WebSocket Notifications**: `safeEmit("download-started", data)` shoots a
   real-time WebSocket event back to the client UI bridging the network.
3. **Standard Out (stdout)**: The system reads stdout data chunks on the fly
   from the subprocess. A regex stream `(\d{1,3}\.\d)` consistently pulls the
   progress percentage tracking from `yt-dlp`.
4. **Filesystem-Based Outcome & Partial Downloads**: Rather than relying
   strictly on exit code 0, `yt-diff` inspects the filesystem via `discoverFiles`.
   If the media file is found on disk (`syncStatus.videoFileFound`), the run is
   classified as successful even if yt-dlp exited with an error code (such as an
   `HTTP Error 429` on a sidecar). yt-dlp is spawned with `--ignore-errors` and
   `--sleep-subtitles 1` so sidecar throttling does not abort video downloads.
5. **Offered vs. Missing Extras Tracking**:
   - Before downloading, `--print "before_dl:extras:..."` reports which extras
     the platform actually offers (subtitles, chapters, comments, description,
     thumbnail).
   - `expected = configured ∩ offered`. If any expected extra is missing on disk
     after the download, it is recorded in `VideoMetadata.missingExtras` and
     `downloadFailureReason` (e.g. `"rate-limited"` or `"error"`).
   - The UI displays a warning chip for partial downloads with a button to fetch
     missing extras.
6. **Chapter Extraction**: After media discovery, `ffprobe -v error -show_chapters -of json`
   extracts embedded chapters directly from the media container into
   `VideoMetadata.chapters`.
7. **Metadata Update & Notification**: `VideoMetadata` is updated with discovered
   filenames, chapters, and sync status, and a `download-done` WebSocket event
   is emitted carrying `partial`, `missingExtras`, and `reason`.

## 5. Sidecar Recovery (`POST /syncextras`)

When sidecars are missing due to rate limiting or transient errors, they can be
recovered on demand:

- **API / Web UI**: `POST /syncextras { videoUrl }` acquires a download slot and
  runs yt-dlp with `--skip-download` and identical output paths. Whatever extras
  are successfully fetched are cleared from `missingExtras`.
- **Telegram Bot**: `/sync <id|url>` triggers the same recovery flow.
- **Automated Job**: The `extrasRetry` background cron job sweeps rate-limited
  videos hourly, retrying up to 3 times per video with a 1-second delay between
  requests.

## 6. Job Control & Cancellation

Downloads can be stopped or paused while queued or actively running:

- **`POST /cancel` / Bot `/cancel`**: Stops a running process via `SIGTERM`
  (exit code 143) or drops a queued item before it starts.
- **`POST /jobaction`**: Supports `pause`, `resume`, and `cancel`.
  - **Pause**: Terminates the active process while **preserving partial files**
    (`.part`), allowing yt-dlp to resume without redownloading transferred bytes.
  - **Cancel**: Terminates the process and cleans up partial fragments
    (`.part`, `.part-Frag*`, `.ytdl`).

---

_Last updated at: 2026-10-17_
