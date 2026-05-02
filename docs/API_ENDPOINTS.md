# API Endpoints and Frontend Integration

This document outlines the backend endpoints exposed by `index.ts` and how they
interact with the frontend components.

## Overview

The application uses a custom HTTP server built on `node:http`. Endpoints are
primarily accessed via `POST` requests where the payload contains data as well
as authentication tokens. This avoids heavy external server frameworks and keeps
dependencies minimal.

## Endpoints

### 1. File Listing & Playlists

- **`/getplay`**
  - **Description**: Retrieves all tracked playlists from the database for
    display.
  - **Frontend Usage**: `PlayList.jsx` fetches this on mount and after
    successful updates.
- **`/list`**
  - **Description**: Submits a new URL (playlist, channel, or video) to be
    processed, analyzed by yt-dlp, and added to the database.
  - **Frontend Usage**: `PlayList.jsx` triggers this when the user adds a new
    URL through the interface.
- **`/delplay`**
  - **Description**: Deletes a playlist from tracking and optionally removes
    associated video mappings and downloaded files on disk. See
    [DELETION_BEHAVIOR.md](DELETION_BEHAVIOR.md) for the full flow.
  - **Frontend Usage**: `PlayList.jsx` calls this when a user clicks delete on a
    playlist row.
- **`/watch`**
  - **Description**: Updates the monitoring strategy (e.g., Start, End, Full)
    for a given playlist.
  - **Frontend Usage**: `PlayList.jsx` hits this endpoint when a user changes
    the dropdown for a playlist's tracking mode.

### 2. Video Operations

- **`/getsub`**
  - **Description**: Retrieves the associated videos (sub-items) for a specific
    playlist.
  - **Frontend Usage**: `SubList.jsx` fetches these videos when a user selects
    or expands a playlist.
- **`/download`**
  - **Description**: Initiates the physical download of a specific video to disk
    via `yt-dlp`.
  - **Frontend Usage**: `SubList.jsx` calls this when a user manually triggers a
    download for an unavailable/missing video.
- **`/delsub`**
  - **Description**: Deletes metadata and physically removes downloaded files
    for specific videos. Supports granular control over file cleanup, mapping
    removal, and full DB deletion. See
    [DELETION_BEHAVIOR.md](DELETION_BEHAVIOR.md) for the full flow.
  - **Frontend Usage**: `SubList.jsx` accesses this to remove specific videos
    from the database and disk.

### 3. File Retrieval & Signed URLs

- **`/getfile`**
  - **Description**: Generates a temporary signed URL token for downloading a
    file securely. Prevents unauthenticated direct access to files on the
    server.
  - **Frontend Usage**: `SubList.jsx` calls this to retrieve a file token
    securely, which is then used in a GET request to physically stream the file
    to the user.
- **`/getfiles`**
  - **Description**: Generates signed URLs for multiple files simultaneously.
  - **Frontend Usage**: `SubList.jsx` uses this to resolve batch URLs
    efficiently instead of looping over `/getfile`.

### 4. Maintenance & Administration

- **`/reindexall`**
  - **Description**: Re-runs the listing pipeline for all tracked videos (or a filtered subset) to refresh their metadata from yt-dlp. Accepts `start`, `stop`, `siteFilter`, and `chunkSize` parameters.
  - **Request body**: `{ start?, stop?, siteFilter?, chunkSize? }`

- **`/dedup-unlisted`**
  - **Description**: Canonicalizes URLs in the `None` playlist in-place. Then scans `video_metadata` for records that share the same `videoId` but live under different `videoUrl` primary keys. In dry-run mode it only reports what would change; when `dryRun: false` it merges the duplicates and re-homes all `playlist_video_mappings` to the canonical URL.
  - **Merge priority**: prefers records that belong to a real playlist over the "None" bucket; among equals, keeps the most recently updated record.
  - **Request body**: `{ dryRun?: boolean (default true), siteFilter?: string }`
  - **Response**: `{ status, videoDuplicatesFound, videoMergedCount, videoDetails[] }`
  - **Authentication**: Required.

- **`/dedup-playlists`**
  - **Description**: Scans `playlist_metadata` for duplicate playlists via canoncialized URLs. Keeps the playlist with a non-empty `saveDirectory` or the most recently updated. Merges `playlist_video_mappings` to the canonical playlist URL.
  - **Request body**: `{ dryRun?: boolean (default true), siteFilter?: string }`
  - **Response**: `{ status, playlistDuplicatesFound, playlistMergedCount, playlistDetails[] }`
  - **Authentication**: Required.

### 5. Authentication

- **`/login`**, **`/register`**, **`/isregallowed`**
  - **Description**: Handles user authentication, registration queries, and
    determining if new signups are permitted based on server configurations.
  - **Frontend Usage**: Extensively utilized in `Login.jsx` and `Signup.jsx`.

### 6. Health Check

- **`/ping`** (GET)
  - **Description**: Returns `"pong"`. Used by the Docker healthcheck to verify
    the server is alive.
  - **Usage**: `curl -f http://127.0.0.1:8888/ytdiff/ping`

## URL Normalization

All URLs submitted via `/list` or `/download` (or discovered automatically by yt-dlp) pass through a strict canonicalization pipeline before being stored as primary keys (`videoUrl` or `playlistUrl`). This ensures the database prevents duplicate records at the point of entry when the same content is added via different URL formats.

### Canonicalization Rules

| Platform | Input Example | Canonical Stored | Note |
| :---- | :--------------- | :--------------- | :--- |
| **YouTube** | `https://youtu.be/ID?si=xxx` | `https://www.youtube.com/watch?v=ID` | Normalizes `youtu.be`, `m.youtube.com`, and `/shorts/`. Strips `list`, `index`, `si`, `pp` for videos. |
| **Iwara** | `https://www.iwara.tv/video/ID/slug` | `https://www.iwara.tv/video/ID` | Strips trailing title slug. |
| **X / Twitter**| `https://x.com/user/status/ID` | `https://x.com/user/status/ID?s=20` | Appends/retains `?s=20` as it remains structurally constant. |

The normalizer is registry-based—new sites can be added to `SITE_CANONICALIZERS` in `process-manager.ts` and `dedup.ts`.

## WebSockets

- **Socket.io Connection**: Handled at `config.urlBase + "/socket.io/"`.
- **Events**: Utilizes `connection`, `acknowledge`, and `disconnect` events.
- **Frontend Interaction**: The frontend subscribes to socket events to receive
  real-time progress updates of active background downloads and metadata listing
  processes, ensuring the UI stays fresh without constant polling.
