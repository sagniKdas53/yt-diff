# Video Player Architecture & Features

The `yt-diff` video player seamlessly blends an uninterrupted, high-performance
streaming backend with a modern, feature-rich React frontend. The player
replaces the standard browser HTML5 controls with a customized user interface
that delivers continuous playback, queue management, and network resiliency.

## Frontend UI Features

- **Custom Styled UI:** The browser's default media controls are fully disabled.
  `yt-diff` uses a custom Material-UI overlay integrating a glassmorphism
  aesthetic that auto-hides during active playback.
- **Playlist & Queue Drawer:** The player features an integrated side drawer with
  three switchable tabs:
  - **Playlist:** displays all tracks in the active page or queue. Un-downloaded
    entries are visually dimmed and unclickable, preventing broken playback.
  - **Chapters:** extracted chapter timestamps and titles with interactive
    click-to-seek navigation.
  - **Transcript:** parsed subtitle cues with interactive seek lines and a
    "Sync to video time" auto-follow toggle.
- **Chapters & Seek Bar Marks:** Videos with chapter metadata display chapter
  boundaries directly as discrete marks on the seek bar slider, along with the
  current chapter's title displayed beside the `00:00 / 00:00` time readout.
- **Subtitles & Transcript Processing:** WebVTT subtitles (`.vtt`) are parsed on
  the client. YouTube rolling auto-captions are automatically sanitized: 10 ms
  echo cues and repetitive karaoke lines are collapsed into clean, readable
  sentences. Active cues are resolved using binary search to avoid render-loop
  overhead.
- **Description Dialog:** An `(i)` button in the player control bar opens an MUI
  dialog displaying the video's title, upload date, and full description. Web
  links and timestamp references (`mm:ss` or `hh:mm:ss`) are automatically
  linkified; clicking any timestamp seeks playback directly.
- **Playback Speed Control:** A rate selector button beside the volume control
  offers speeds from 0.5x to 2x (0.5, 0.75, 1, 1.25, 1.5, 2). The selected rate
  persists in `localStorage` under `ytdiff_player_rate` and re-applies across
  track transitions.
- **Keyboard Shortcuts:**
  - `Space` / `k`: Toggle play / pause
  - `ArrowLeft` / `ArrowRight`: Skip backward / forward by 10 seconds
  - `ArrowUp` / `ArrowDown`: Adjust volume up / down by 10%
  - `m`: Toggle mute
  - `f`: Toggle fullscreen
  - `c`: Toggle subtitles on / off (when a subtitle track is available)
  - `<` / `>`: Decrease / increase playback rate
  - *Shortcuts are automatically bypassed when typing in inputs, textareas, or modal dialogs.*
- **Smart Navigation:** The "Next" and "Previous" playback buttons dynamically
  scan through the current active playlist array, gracefully leaping over
  non-downloaded items until they find the next playable track.
- **Seamless Pagination:** If the user presses "Next" at the end of the
  currently loaded page, the player issues an asynchronous backend instruction
  to fetch `page + 1` from the database. It then automatically hooks into the
  new data and instantly begins playing the first available track on that new
  page.
- **Auto-Play:** A toggle switch in the UI allows users to enable continuous
  playback. When enabled, hitting the end of a video triggers the Smart
  Navigation flow to proceed automatically to the next downloaded track.
- **Resume at Timestamp (`t=`):** The router supports a `t=<seconds>` query
  parameter in `#/playlist/<url>?v=...&t=...` and `#/unlisted?v=...&t=...`. The
  player seeks to this position on initial load, and writes the current playhead
  back to the URL every ~10s and on pause using `replace: true` (avoiding history
  pollution).

## Backend Streaming & Resiliency

- **Streaming Implementation:** The backend (`index.ts`) streams video using
  range requests on a fast HTTP layer serving `video/mp4` MIME types, solving
  earlier issues with browser auto-downloading files incorrectly flagged as
  `application/octet-stream`.
- **Sliding-Window Timed Sessions:** Standard signed video URLs ordinarily
  expire within 30 minutes in `yt-diff` to maintain backend security. However,
  to support uninterrupted long-movie viewing or pause-and-resume workflows, the
  frontend implements a sliding window session strategy.
- **Silent Refresh Polling with Backoff:** While the player is active, the
  frontend silently polls `/refreshfile` (or `/refreshfiles` for thumbnails)
  before tokens expire. If the refresh request encounters an error (server
  restart, temporary network blip), the hook applies exponential backoff (5s,
  15s, 60s, up to 5 attempts) rather than looping aggressively at 0 ms.
- **Graceful Error Recovery:** Should the player remain paused for an extended
  duration causing a network disconnect or URL token timeout (code 3/4 errors),
  the React UI catches the `onError` event passively. Rather than breaking, it
  memorizes the exact `currentTime`, securely requests a fresh signed URL, and
  auto-seeks back to your position without significant manual intervention.

## State Persistence

- **Environment Consistency:** The player writes your Volume level, Mute
  preference, Auto-Play toggle, and Playback Speed (`ytdiff_player_rate`)
  individually to browser `localStorage`. Opening a player instantly recovers
  this configuration across reloads.

---

_Last updated at: 2026-10-17_
