# Deletion Behavior in yt-diff

This document describes the complete deletion flows available in `yt-diff`,
covering playlist deletion, video deletion, and the automated prune job.

---

## 1. Playlist Deletion (`/delplay`)

Triggered when a user deletes a playlist from the UI (`PlayList.jsx`) or calls
the `/delplay` endpoint directly.

### Request Parameters

| Parameter                   | Type      | Default | Description                                              |
| :-------------------------- | :-------- | :------ | :------------------------------------------------------- |
| **`playListUrl`**           | `string`  | —       | **(Required)** URL of the playlist to act on.            |
| **`deleteAllVideosInPlaylist`** | `boolean` | `false` | Remove all video mappings from this playlist.        |
| **`deletePlaylist`**        | `boolean` | `false` | Delete the playlist record itself from `PlaylistMetadata`.|
| **`cleanUp`**               | `boolean` | `false` | Physically remove the playlist's directory from disk.    |

### Guard Rails

- The **"None" playlist** (the built-in unlisted bucket) **cannot be deleted**.
  The server returns a `400` error if `playListUrl === "None"`.
- If the playlist URL doesn't exist in the database, a `404` is returned.

### Execution Flow

The entire operation runs inside a **database transaction** so it either fully
succeeds or fully rolls back.

1. **Mapping Removal** (`deleteAllVideosInPlaylist = true`):
   - All rows in `PlaylistVideoMapping` where `playlistUrl` matches are
     destroyed.
   - This does **not** delete the videos themselves — they remain in
     `VideoMetadata`. If those videos are no longer referenced by any playlist,
     the [Prune Job](#3-automatic-pruning-prune-job) will handle them on its
     next run.

2. **Playlist Destruction** (`deletePlaylist = true`):
   - The `PlaylistMetadata` row is destroyed.
   - All remaining playlists with a higher `sortOrder` have their `sortOrder`
     decremented by 1, keeping the display order compact and gap-free.
   - The internal `pendingPlaylistSortCounter` cache is invalidated so the next
     `addPlaylist` call re-reads the counter from the database.

3. **Disk Cleanup** (`cleanUp = true`):
   - The playlist's `saveDirectory` is recursively deleted using
     `fs.rmSync(path, { recursive: true, force: true })`.
   - After deletion, any videos in `VideoMetadata` that shared the same
     `saveDirectory` are **reset to un-downloaded state**: `downloadStatus` is
     set to `false` and all file references (`fileName`, `thumbNailFile`,
     `subTitleFile`, `commentsFile`, `descriptionFile`, `saveDirectory`) are
     cleared to `null`.
   - If the directory removal fails (e.g., permissions), the error is logged but
     the transaction still commits — the database changes are preserved.

4. **No-op**: If neither `deleteAllVideosInPlaylist` nor `deletePlaylist` is
   `true`, the server returns a `200` with a message indicating no deletion was
   performed.

---

## 2. Video Deletion (`/delsub`)

Triggered when a user deletes specific videos from the SubList panel
(`SubList.jsx`) or calls the `/delsub` endpoint directly.

### Request Parameters

| Parameter               | Type       | Default | Description                                                         |
| :---------------------- | :--------- | :------ | :------------------------------------------------------------------ |
| **`playListUrl`**       | `string`   | —       | **(Required)** URL of the playlist context.                         |
| **`videoUrls`**         | `string[]` | —       | **(Required)** Array of video URLs to process.                      |
| **`cleanUp`**           | `boolean`  | `false` | Physically delete downloaded files from disk.                       |
| **`deleteVideoMappings`** | `boolean` | `false` | Remove the playlist-video mapping for this playlist.               |
| **`deleteVideosInDB`**  | `boolean`  | `false` | Permanently delete the video record from `VideoMetadata` (cascade). |

### Execution Flow

All operations run inside a **database transaction** with batched SQL for
performance.

1. **Validation**: The server verifies the playlist exists and the `videoUrls`
   array is non-empty.

2. **Per-Video Processing**: For each URL in `videoUrls`:

   a. **File Cleanup** (`cleanUp = true` and video is downloaded):
      - Each associated file is individually unlinked:
        - `fileName` — the video file
        - `thumbNailFile` — the thumbnail
        - `subTitleFile` — the subtitle file
        - `commentsFile` — the comments JSON
        - `descriptionFile` — the description text
      - File paths are resolved using `saveLocation + saveDirectory + filename`.
      - If any file fails to delete, the video is marked as failed and skipped.

   b. **Database Destruction** (`deleteVideosInDB = true`):
      - The entire `VideoMetadata` row is destroyed. Due to `CASCADE` rules on
        the foreign key, **all mappings across every playlist** are
        automatically removed.
      - This is the most aggressive option.

   c. **Metadata Reset** (`cleanUp = true`, `deleteVideosInDB = false`):
      - The video stays in the database but is reset to un-downloaded state:
        `downloadStatus = false`, all file fields set to `null`.

   d. **Mapping Removal** (`deleteVideoMappings = true`,
      `deleteVideosInDB = false`):
      - Only the `PlaylistVideoMapping` row linking this video to the specified
        playlist is removed. The video remains in `VideoMetadata` and may still
        be mapped to other playlists.

3. **Response**: Returns a JSON object with `deleted` (success list) and
   `failed` (list with reasons) arrays.

### Operation Priority

When multiple flags are set, `deleteVideosInDB` takes precedence:

```
deleteVideosInDB = true  →  destroys video + all mappings (ignores other flags)
deleteVideosInDB = false →  cleanUp resets metadata, deleteVideoMappings removes mapping
```

---

## 3. Automatic Pruning (Prune Job)

The prune job runs on a cron schedule (see
[AUTOMATED_JOBS.md](AUTOMATED_JOBS.md)) and cleans up orphaned videos — videos
that exist in `VideoMetadata` but have **no entries** in
`PlaylistVideoMapping`.

This situation arises when:
- A playlist is deleted but its videos were shared with other playlists that
  were also deleted.
- Video mappings were removed manually via `/delsub` with
  `deleteVideoMappings = true`.
- Platform-side playlist removals during a re-scan cause mappings to go stale.

### Pruning Logic

For each unreferenced video:

| Condition | Action |
| :-------- | :----- |
| `downloadStatus = true` (file exists on disk) | **Move** to the "None" playlist by creating a new mapping with the next available `positionInPlaylist` index. |
| `downloadStatus = false` (not downloaded) | **Destroy** the `VideoMetadata` row entirely. |

This ensures downloaded content is never silently deleted — it's always
preserved under the "None" bucket where the user can find and manage it.

### Configuration

| Env Var | Default | Description |
| :------ | :------ | :---------- |
| `PRUNE_INTERVAL` | `*/30 * * * *` | Cron expression for prune frequency |
| `TZ_PREFERRED` | `Asia/Kolkata` | Timezone for scheduling |
