# Listing and Updating Behaviors in yt-diff

This document details how `yt-diff` parses playlists/channels, manages
individual videos, and handles automated background updates.

## 1. Initial Listing Behavior

When a user submits a URL via the UI (using the Add Dialog) or through the
`/list` API, the system initiates a **Listing** process.

### Detection

- **Single Video vs Playlist/Channel**: The URL is analyzed using a regex and
  site-specific rules (`isSiteXDotCom`). If the link naturally points to a
  single video without a playlist context, it's processed as a single video
  payload. If it's a playlist or channel, it progresses to playlist extraction.
- **Deduplication**: If the playlist already exists in the database, the system
  will update the `monitoringType` (if applicable) and trigger an update scan.

### The Extraction Process

- The system spawns `yt-dlp` using the `--flat-playlist` argument to stream the
  videos sequentially as fast as possible.
- Videos are output as JSON/Tab-separated lines containing `title`, `id`, `url`,
  and `approximateSize`.
- As the video items are returned line-by-line, they are grouped into **chunks**
  (default size defined in `config.ts`).

### Metadata and Indexing

- **Placeholder Handling**: In certain cases (e.g., specific platforms using
  flat-playlist), `yt-dlp` does not provide an immediate title, returning
  `"NA"`. In this case, `yt-diff` temporarily saves the video's identifier
  (`videoId`) as its title.
- **Index Mapping**: `yt-diff` creates a relational mapping between the video
  and the playlist by saving the exact index (`positionInPlaylist`) at which the
  video was discovered. This index tracks the order of videos inside a playlist.

---

## 2. Background Updating Behaviors

`yt-diff` uses a background scheduler (`node-cron`) to routinely sweep for new
additions to saved playlists. The behavior of the update completely depends on
the configured **Monitoring Type**.

### `Start` Mode (Incremental Update)

- **Best Use Case**: Playlists or Channels where new videos are added to the
  **top** (index 1).
- **Behavior**: The scheduler spawns `yt-dlp` to read from `--playlist-start 1`.
- **Optimization**: To avoid scanning a massive channel perpetually, `yt-diff`
  watches for completely duplicate chunks. If the scanner encounters **two
  consecutive chunks** where every single video parsed already exists exactly at
  those indices in the database, the process cleanly aborts.

### `End` Mode (Incremental Append)

- **Best Use Case**: Playlists where new videos are added to the **bottom**
  (e.g., standard generic playlists you continually append to).
- **Behavior**: The system queries the database to find the total number of
  videos (based on the highest index) known to exist in the playlist. It then
  configures `yt-dlp` to start scanning exactly at
  `(Highest Index) - chunkSize + 1`. This safely creates a slight overlap
  backward to ensure no videos were missed.
- **Integrity Validation**:
  - If the scanner picks up a video, and its new index is actually _less_ than
    what the database previously saved, a `logger.warn()` is triggered notifying
    the administrator that videos higher up in the playlist were likely deleted,
    shifting the index down.
  - If the scanner fetches the chunk and it returns absolutely zero results when
    it shouldn't have, it aborts the process and logs an error about severe
    playlist deletions.

### `Full` Mode (Full Re-scan)

- **Best Use Case**: Playlists where videos could be added, removed, or
  reordered anywhere within the playlist, and you need a complete
  synchronization.
- **Behavior**: The scheduler spawns `yt-dlp` to process the entire playlist
  from beginning to end, ignoring any duplicate chunk early-exit optimizations.
  This acts similarly to `Refresh`, but runs automatically on the scheduled
  interval.
- **Performance Consideration**: Due to its high bandwidth usage and processing
  time, `Full` mode updates are triggered in the background only after all
  `Start` and `End` updates have completed, preventing queue blockages.

### `N/A` Mode (Disabled)

- **Best Use Case**: Completed archival playlists or single videos.
- **Behavior**: The background scheduler ignores the playlist entirely. It will
  never be automatically queried.

---

## 3. Manual Refresh Mode

The `Refresh` mode exists exclusively as a manual override to force a
comprehensive re-index of an entire playlist.

- **Trigger**: Can only be executed from the "Watch mode" dropdown during the
  Add Dialog in the UI.
- **Behavior**: The server queries the items exactly as if it were doing a full
  end-to-end trace natively. It ignores the "duplicate chunk" early-exit
  optimizations applied to `Start` mode.
- **Metadata Verification**: Because it forces a raw sweep, any videos
  possessing placeholder data (like `"NA"` titles) are forcefully evaluated
  against the new chunk data. If real titles now exist, the `"NA"` placeholders
  are correctly overwritten.
- **Auto-Fallback**: After the API request completes, the system intercepts the
  `Refresh` monitoring type and forcefully falls back the database record to
  `"N/A"`. This guarantees an expensive full-scan does not become permanently
  trapped in the persistent background queue loops.
