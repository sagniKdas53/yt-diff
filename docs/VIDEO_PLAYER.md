# Video Player Architecture & Features

The `yt-diff` video player seamlessly blends an uninterrupted, high-performance streaming backend with a modern, feature-rich React frontend. The player replaces the standard browser HTML5 controls with a customized user interface that delivers continuous playback, queue management, and network resiliency.

## Frontend UI Features

- **Custom Styled UI:** The browser's default media controls are fully disabled. `yt-diff` uses a custom Material-UI overlay integrating a glassmorphism aesthetic that auto-hides during active playback.
- **Playlist & Queue Drawer:** The player features an integrated frosted-glass side drawer that displays all tracks currently in the active page or queue. Un-downloaded entries are visually dimmed and unclickable, preventing broken playback.
- **Smart Navigation:** The "Next" and "Previous" playback buttons dynamically scan through the current active playlist array, gracefully leaping over non-downloaded items until they find the next playable track.
- **Seamless Pagination:** If the user presses "Next" at the end of the currently loaded page, the player issues an asynchronous backend instruction to fetch `page + 1` from the database. It then automatically hooks into the new data and instantly begins playing the first available track on that new page.
- **Auto-Play:** A toggle switch in the UI allows users to enable continuous playback. When enabled, hitting the end of a video triggers the Smart Navigation flow to proceed automatically to the next downloaded track.

## Backend Streaming & Resiliency 

- **Streaming Implementation:** The backend (`index.ts`) streams video using range requests on a fast HTTP layer serving `video/mp4` MIME types, solving earlier issues with browser auto-downloading files incorrectly flagged as `application/octet-stream`.
- **Sliding-Window Timed Sessions:** Standard signed video URLs ordinarily expire within 30 minutes in `yt-diff` to maintain backend security. However, to support uninterrupted long-movie viewing or pause-and-resume workflows, the frontend implements a sliding window session strategy.
- **Silent Refresh Polling:** While the player is active, the frontend silently polls the `/refreshfile` endpoint before the current signed URL expires. This action extends the validity of the active token in the backend memory cache by another 30 minutes seamlessly.
- **Graceful Error Recovery:** Should the player remain paused for an extended duration causing a network disconnect or URL token timeout (code 3/4 errors), the React UI catches the `onError` event passively. Rather than breaking, it memorizes the exact `currentTime`, securely requests a fresh signed URL, and auto-seeks back to your position without significant manual intervention. 

## State Persistence

- **Environment Consistency:** The player writes your Volume level, Mute preference, and Auto-Play enable state individually to the browser's `localStorage`. Opening a player instantly recovers this configuration across reloads.
