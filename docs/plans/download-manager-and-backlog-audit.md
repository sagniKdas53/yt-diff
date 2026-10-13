# Audit & Findings: Bot & Player Backlog and Download Manager

This document records the findings, architectural issues, runtime diagnostics, and backlog audit for the implementations on branches:
- Backend: `feat/bot-and-player-backlog` (PR #131) and `feat/job-control` (PR #132)
- Frontend: `feat/bot-and-player-backlog` (PR #112) and `feat/download-manager` (PR #113)
- Tests: `feat/bot-and-player-backlog` (PR #1) and `test/job-control` (PR #2)

---

## 1. Executive Summary: Why the Drawers Lag (Even With Zero Active Downloads)

User testing and screen recording session analysis revealed noticeable lag in the **Download Drawer (`JobDrawer`)**, severe stutter in the **Player Playlist Drawer**, and even worse lag in the **Transcript Drawer** — specifically worse on `vp=11` than `vp=12`. Crucially, **this lag persists even when downloads are completely idle (zero active or queued jobs)**.

The lag stems from two independent rendering and compositing bottlenecks:

```
[Hardware Video Playback (30-60 fps)]
                │
                ▼ (Rendered on GPU surface)
[PlayerPlaylistDrawer Paper: backdropFilter: "blur(8px)"]  <-- Compositor stall (re-blurring video 60x/sec)
                ▲
                │ (Forced 1Hz React re-render tick)
[VideoPlayer handleTimeUpdate -> currentTime={Math.floor(t)}]
                │
                ▼
[subtitleCues.map(...) -> 213 unvirtualized MUI buttons]  <-- 1,000+ DOM nodes & emotion styles recreated every second
```

### A. The Compositing Stall: `backdropFilter: "blur(8px)"`
- **Location**: [`frontend/src/components/PlayerPlaylistDrawer.jsx#L275`](frontend/src/components/PlayerPlaylistDrawer.jsx#L275)
- **Mechanism**: The drawer paper uses `position: "absolute"`, `bgcolor: "rgba(0, 0, 0, 0.85)"`, and `backdropFilter: "blur(8px)"`, placed directly over an actively playing 1080p HTML5 `<video>` element.
- **Hardware Impact**: In Linux with hybrid Intel / NVIDIA GPUs (NVIDIA 940MX / Intel Mesa in Firefox), the compositor must read back the underlying hardware video texture, execute a 2-pass Gaussian blur on the GPU, and composite the 85% opaque black surface at 60 fps.
- **The Waste**: At `0.85` (85%) opacity, the blurred background video is virtually invisible to the user, yet the GPU pays the maximum compositing penalty on every frame and every scroll event.

### B. The 1-Second Playhead Re-render Storm & Unvirtualized DOM
- **Location**: [`frontend/src/components/VideoPlayer.jsx#L912`](frontend/src/components/VideoPlayer.jsx#L912) and [`frontend/src/components/PlayerPlaylistDrawer.jsx#L380-L400`](frontend/src/components/PlayerPlaylistDrawer.jsx#L380-L400)
- **Mechanism**:
  1. `<video>` triggers `handleTimeUpdate` 4 times per second.
  2. `VideoPlayer` passes `currentTime={Math.floor(currentTime)}` to `PlayerPlaylistDrawer`.
  3. Every single second, `currentTime` changes, invalidating `activeCueIndex` in `PlayerPlaylistDrawer`.
  4. The transcript list (`subtitleCues.map(...)`) is **not virtualized** and **not memoized**.
  5. Every second, React instantiates all 213 cues (`pq-32mjgDgc`), each with a full MUI `<ListItemButton>`, `<ListItemText>`, two `<Typography>` nodes, inline `onClick` closures, and Emotion `sx` style objects (>1,000 DOM nodes reconciled per second).
  6. When the user scrolls, the scroll-repaint and mouse-hover handlers collide with the 1Hz React reconciliation storm inside the blurred compositor layer, causing scroll jank and mouse freeze.

### C. Why `vp=11` is Significantly More Laggy Than `vp=12`
The user reported that `vp=11` (`pq-32mjgDgc`) lags horribly, whereas `vp=12` (`ApzGAimXUe0`) is noticeably smoother:
1. **Playlist Item Count**:
   - `vp=11` is page 11 (items 81–88 of 88): it contains **8 full video items** in the playlist drawer and 8 cards mounted in the background `Unlisted` page DOM.
   - `vp=12` is page 12 (the final page): it contains **only 1 video item** (`The Human Shivers...`).
   - In `PlayerPlaylistDrawer`, the playlist items mapping (`items.map`) evaluates 8 complex cards with thumbnail resolution and status badges on `vp=11` vs 1 item on `vp=12`.
2. **Transcript Cue Density**:
   - `pq-32mjgDgc` (`vp=11`) is a fast-paced science lecture ("Scientists Made Rat Hearts Photosynthetic...") with continuous speech, resulting in **213 dense cues**.
   - `ApzGAimXUe0` (`vp=12`) is an Ed Sheeran music mashup with long instrumental sections and sparse lyrics, containing **169 looser cues**.

### D. Why the Download Drawer (`JobDrawer`) Lags When Idle
- **Location**: [`frontend/src/hooks/useJobQueue.js#L77-L97`](frontend/src/hooks/useJobQueue.js#L77-L97) and [`frontend/src/components/JobDrawer.jsx#L283-L290`](frontend/src/components/JobDrawer.jsx#L283-L290)
- **Mechanism**:
  1. When open, `useJobQueue` polls `/queuestatus` every 2 seconds (`POLL_OPEN_MS = 2000`).
  2. Each poll calls `setLoading(true)`, fetches from the server, updates `setJobs(newObject)`, and calls `setLoading(false)`.
  3. This triggers **3 rapid re-renders every 2 seconds**.
  4. Even with 0 downloads, `setJobs({ downloads: [], listings: [] })` creates a new object reference, causing `downloads` and `listings` in `JobDrawer` to recalculate.
  5. `JobRow` and `JobGroup` are unmemoized; opening and scrolling the drawer stutters due to this constant state churn.

---

## 2. Bot Integration Diagnostics & Broken Link Handlers

### A. Bot Player Link Fails to Open Player / Seeks to Wrong Page
- **Context**: Telegram delivery message vs resulting web application view.
- **Symptom**: User sends an Iwara link (`RKtACaiXahVcQy`). The bot responds with `Watch it: https://<host>/ytdiff/#/unlisted?v=https%3A%2F%2Fwww.iwara.tv%2Fvideo%2FRKtACaiXahVcQy`. Clicking the link navigates to Page 1 of Unlisted (items 1–8 of 92). The player **never opens**, and the video is at position 95 (Page 12).
- **Root Cause Chain**:
  1. **`resolveVideoPlaylist` drops `None`**: In [`src/handlers/pipeline/download-location.ts#L10`](src/handlers/pipeline/download-location.ts#L10), `PSEUDO_PLAYLISTS = ["init", "None"]`. For any unlisted or bot video, `resolveVideoPlaylist` returns `null`.
  2. **`locateVideo` returns null page**: In [`src/handlers/pipeline/locate.ts#L43-L46`](src/handlers/pipeline/locate.ts#L43-L46), if `resolveVideoPlaylist` returns `null`, `locateVideo` immediately returns `{ videoUrl, playlistUrl: null, page: null }` without querying `PlaylistVideoMapping` for `None`.
  3. **`buildPlayerUrl` excludes `vp`**: In [`src/bot/delivery.ts#L140-L142`](src/bot/delivery.ts#L140-L142):
     ```typescript
     if (playlistUrl && page !== null && page > 0) {
       params.set("vp", String(page + 1));
     }
     ```
     Because `playlistUrl` is `null`, `vp` is never appended!
  4. **Frontend `SubList.jsx` drops the link**:
     - When the app loads `#/unlisted?v=...`, `SubList` loads page 0 (items 1–8).
     - The video is at position 95, so it is missing from `items`.
     - `SubList` calls `POST /locate`.
     - Backend `/locate` returns `page: null`.
     - In [`SubList.jsx#L228-L236`](frontend/src/components/SubList.jsx#L228-L236), `targetPage === null` triggers `dropLinkVideo()`.
     - `dropLinkVideo()` removes `v=` from the URL, so the player is abandoned, leaving the user stranded on Page 1.

### B. Bot Submission Closes Player During Playback
- **Symptom**: While watching a video in the web player, a new submission from the Telegram bot causes the player to abruptly close and dumps the user back to the unlisted playlist page.
- **Root Cause**:
  1. When a bot submission completes its single-item listing, the backend emits `listing-single-item-complete`.
  2. In [`frontend/src/hooks/useSocketEvents.js#L417-L422`](frontend/src/hooks/useSocketEvents.js#L417-L422):
     ```javascript
     const current = playListUrlRef.current;
     if (current === "init" || current === "None") {
       setPlayListUrl("None");
       setSubListIndex(data.seekSubListTo);
     }
     ```
  3. In [`frontend/src/components/App.jsx#L284-L290`](frontend/src/components/App.jsx#L284-L290), `setPlayListUrl` is bound to `replacePlayListUrl`:
     ```javascript
     const replacePlayListUrl = useCallback(
       (url) =>
         navigate(
           { playlistUrl: url, videoUrl: null, videoPage: 0 },
           { replace: true },
         ),
       [navigate],
     );
     ```
  4. `replacePlayListUrl` forcefully resets `videoUrl: null` and `videoPage: 0`!
  5. Setting `videoUrl: null` triggers `hidePlayer()` in `SubList.jsx`, immediately closing the player and interrupting the user's active playback.

### C. 3rd Bot Download Failure (`UZJFFStQemI` - Golden Brown)
- **Symptom**: YouTube video failed with `ERROR: unable to download video data: HTTP Error 403: Forbidden`.
- **Root Cause**:
  1. Format 616 (video, 20.5MB) downloaded 100%, but format 251 (audio) was rejected by YouTube with `HTTP Error 403: Forbidden`.
  2. In [`index.ts#L313-L315`](index.ts#L313-L315):
     ```typescript
     if (config.proxy_string && (isSiteIwaraDotTv(url) || isSiteXDotCom(url))) {
       args.push("--proxy", config.proxy_string as string);
     }
     ```
     `--proxy` is **only passed for iwara.tv and x.com**. Even though an HTTP outbound proxy was configured in the environment, YouTube requests completely bypassed the proxy and exited directly from the local IP, triggering YouTube CDN rate limiting.
  3. `yt-dlp` does not automatically retry HTTP 403 CDN errors without `--retry-sleep 403:5` or `--extractor-args "youtube:player_client=default,ios"`.

---

## 3. Complete Inventory of Discovered Bugs & Regressions

| # | Component | Severity | Description | Root Cause / File |
|---|---|---|---|---|
| 1 | **Compositor / Video Player** | **Critical** | Player playlist and transcript drawers drop frames and stutter when scrolling or hovering. | `backdropFilter: "blur(8px)"` over hardware video decoding in [`PlayerPlaylistDrawer.jsx#L275`](frontend/src/components/PlayerPlaylistDrawer.jsx#L275). |
| 2 | **Transcript Viewer** | **High** | Transcript drawer lags on 1-second video ticks; `vp=11` (213 cues) worse than `vp=12`. | Unvirtualized and unmemoized `subtitleCues.map` re-rendering 1,000+ DOM nodes every second in [`PlayerPlaylistDrawer.jsx#L380`](frontend/src/components/PlayerPlaylistDrawer.jsx#L380). |
| 3 | **Bot Player Navigation** | **Critical** | Telegram bot links (`#/unlisted?v=...`) do not open the player and leave user on Page 1. | `locateVideo` excludes `None`, `buildPlayerUrl` omits `vp`, and `SubList.jsx` drops `v=` when `targetPage` is null. |
| 4 | **Player Interruption** | **Critical** | Background bot submission closes active video player during playback. | `useSocketEvents.js` calls `setPlayListUrl("None")`, invoking `replacePlayListUrl` which resets `videoUrl: null`. |
| 5 | **YouTube Pipeline** | **High** | YouTube downloads fail with HTTP 403 on stream chunks; proxy not utilized. | [`index.ts#L313`](index.ts#L313) restricts `--proxy` to iwara and x.com; lacks 403 retry arguments. |
| 6 | **Player Layout** | **High** | Opening player sidebar (350px) completely occludes right-side video controls. | Drawer renders as `position: "absolute"` inside player container without resizing video viewport. |
| 7 | **UI State Desync** | **High** | Pausing a download leaves card outlined in green with badge `#1` while active job switches to purple `#2`. | `DownloadContext` is not updated when `POST /jobaction` pauses a job; no socket event emitted. |
| 8 | **Transcript Auto-Scroll** | **Medium** | "Sync to video time" highlights active cue but does not scroll it into view. | Missing `scrollIntoView({ behavior: "smooth", block: "nearest" })` ref call on active cue. |
| 9 | **Player Drawer Navigation** | **Medium** | Phantom pagination controls `< 11/12 >` appear at the bottom of the Transcript and Chapters tabs. | Pagination block in [`PlayerPlaylistDrawer.jsx#L405`](frontend/src/components/PlayerPlaylistDrawer.jsx#L405) rendered outside `effectiveTab === "playlist"`. |
| 10 | **Job Drawer Polling** | **Medium** | 2-second polling causes 3 re-renders per cycle even when idle with zero downloads. | `setLoading(true)` / `setLoading(false)` churn and object re-creation in [`useJobQueue.js#L77`](frontend/src/hooks/useJobQueue.js#L77). |
| 11 | **Backend Job Control** | **Medium** | Pausing a playlist listing triggers a spurious error toast: `Failed to list Video: No items found`. | Listing SIGTERM exit code 143 caught as error instead of clean pause in [`listing.ts`](src/handlers/pipeline/listing.ts). |
| 12 | **Subtitle Fetching** | **Medium** | YouTube subtitle HTTP 429 errors fail permanently without retry backoff. | Subtitle fetch lacks exponential backoff handling in download pipeline. |
| 13 | **DOM Parser Loop** | **Medium** | Subtitle parsing freezes the main thread on long files. | [`subtitles.js#L96`](frontend/src/lib/subtitles.js#L96) runs `new DOMParser().parseFromString` inside a loop for every cue. |
| 14 | **Backend Job Control** | **Low** | Backend logs cancelled jobs as errors: `ERROR: Cancelled before it started`. | Cancelled queued jobs throw error in concurrency queue instead of clean cancellation log. |
| 15 | **UI Copy** | **Low** | Resumed downloads show copy: `"Nothing downloaded yet — cancelling this one costs nothing"`. | [`JobDrawer.jsx#L171`](frontend/src/components/JobDrawer.jsx#L171) checks `queued` state without verifying `downloadedBytes > 0`. |
| 16 | **Player Download Bar** | **Low** | Ambiguous 3px green line at bottom of player drawer item has no progress text or tooltip. | [`PlayerPlaylistDrawer.jsx#L249`](frontend/src/components/PlayerPlaylistDrawer.jsx#L249) renders raw line indicator without labels. |

---

## 4. Implementation Plan for Stacked Follow-Up PRs

### PR 1: Backend Pipeline, Proxy & Bot Resilience (`fix/job-control-pipeline`)
1. **Support `None` in `locateVideo`**:
   - In [`locate.ts`](src/handlers/pipeline/locate.ts), if `resolveVideoPlaylist` returns `null`, query `PlaylistVideoMapping` for `playlistUrl = "None"`.
   - Calculate `page = Math.floor(index / pageSize)` so unlisted videos return valid page coordinates.
2. **Include `vp` in `buildPlayerUrl` for Unlisted**:
   - In [`delivery.ts`](src/bot/delivery.ts), allow `page > 0` to set `vp` regardless of whether `playlistUrl` is null or a named playlist.
3. **Pass Proxy for YouTube & Add 403 Retries**:
   - In [`index.ts#L313`](index.ts#L313), enable `--proxy` for YouTube (or whenever `config.proxy_string` is configured).
   - In [`types.ts`](src/handlers/pipeline/types.ts), add `--retry-sleep 403:5` and `--extractor-args "youtube:player_client=default,ios"`.
4. **Throttle Progress Emissions**: Throttle `safeEmit("downloading-percent-update")` to at most once per 250ms per download.
5. **Handle Listing Pause**: Map `yt-dlp` exit 143 during listing cancel/pause to a clean `paused` state.
6. **Emit `job-paused` / `job-resumed`**: Notify client sockets on job state changes.

### PR 2: Frontend Performance & Virtualization (`perf/drawer-and-player-rendering`)
1. **Eliminate Backdrop Blur**: In [`PlayerPlaylistDrawer.jsx`](frontend/src/components/PlayerPlaylistDrawer.jsx), replace `backdropFilter: "blur(8px)"` with solid `rgba(18, 18, 18, 0.95)`.
2. **Virtualize / Memoize Transcript Cues**: Wrap cue items in `React.memo(CueItem)` to prevent re-rendering 200+ cues on 1-second video ticks.
3. **Clean Up `useJobQueue.js` Polling**: Remove `setLoading(true/false)` churn on recurring poll ticks; only update state when payload changes.
4. **Memoize Job Drawer Elements**: Wrap `JobRow` and `JobGroup` in `React.memo`.
5. **Optimize `subtitles.js`**: Replace `new DOMParser().parseFromString(...)` with regex tag stripping.

### PR 3: Player UI & Navigation Stability (`fix/player-ui-and-queue-sync`)
1. **Prevent Player Closure on Bot Submissions**:
   - In [`useSocketEvents.js`](frontend/src/hooks/useSocketEvents.js) and [`App.jsx`](frontend/src/components/App.jsx), preserve `videoUrl` when refreshing playlists; never pass `videoUrl: null` on background listing completion.
2. **Fix `SubList.jsx` Video Link Dropping**:
   - Do not call `dropLinkVideo()` if the video is located on another page; navigate to the target page and open the player.
3. **Prevent Video Control Occlusion**: Ensure player control bar remains accessible when the 350px drawer is open.
4. **Implement Auto-Scroll on Transcript**: Auto-scroll active cue into view when `syncTranscript` is enabled.
5. **Scope Pagination to Playlist Tab**: Only show `< 11/12 >` on the Playlist tab.
6. **Synchronize Card Outlines & Copy**: Update `DownloadContext` on job pause/resume and fix resumed download copy.
