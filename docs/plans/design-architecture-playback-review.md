# Design, architecture and playback review

> **The plan in section 3 has been replaced by
> [`watch-first/`](./watch-first/README.md).** Findings here still stand. In
> particular, Phase 2's `-S` advice is withdrawn: when tested, it produced a
> larger file in a worse container than yt-dlp's default. Phase 0 still applies.

**Goal:** keep the archive's reliability, and make watching good enough that
Jellyfin and VLC stop being needed for everyday viewing.

**Evidence used**

- 26 screenshots (Telegram bot and Firefox on an Android tablet) and two desktop
  screen recordings (16 minutes in total, sampled every 15 seconds).
- The backend and frontend code at `0040ad3` / `a401984`.
- A codec survey of the 105 videos in the laptop archive, and one throwaway test
  that reproduced the playback loop.

**Not done:** the stack was not run, so nothing here is timed. The recordings
stand in for the screenshots the handoff asked for. Anything that depends on the
Pi is marked as needing measurement, and Phase 0 collects it.

**Status labels**

| Label      | Meaning                                       |
| :--------- | :-------------------------------------------- |
| Reproduced | Demonstrated by running code                  |
| Code       | Confirmed by reading the code                 |
| Seen       | Visible in the screenshots or recordings      |
| Measure    | Plausible, but unproven until Phase 0 runs    |
| Refuted    | A handoff hypothesis the evidence contradicts |
| Handoff #n | Confirms that numbered finding in the handoff |
| New        | Not in the handoff                            |

Sizes follow the backlog: S = an afternoon, M = a day or two, L = a design pass
then several days.

---

## 1. The three things that matter most

1. **Files the browser can't play get stuck in a silent, endless loop.** On any
   media error, `handleError` asks for a new signed URL and reloads, which fails
   the same way. Nothing caps it, `/getfile` has no rate limit, and no message
   ever appears. This is the "doesn't play at all" symptom.
2. **The player is built as a view of one list page.** Its queue, its Next
   button and its resume state all come from `SubList`'s current page. That one
   fact causes the queue paging, the missing "continue watching", the re-renders
   during downloads, and the lack of any watch mode.
3. **The app is arranged around managing, not watching.** The first screen is an
   empty panel. Newly added Unlisted videos land on the last page (page 428 in
   the screenshots). Downloaded thumbnails are dimmer than ones you can't play.
   A card's title opens the source site, not the player.

---

## 2. Ranked findings

### Playback

| #   | Finding                                                                                                                                                                                                                                                                                                     | Status                          | Evidence                                                                      | Size             |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------ | :---------------------------------------------------------------------------- | :--------------- |
| P1  | Unlimited re-sign loop on media errors. In a test, 25 consecutive code 4 errors produced 25 more `/getfile` mints (the cap's absence is reproduced; the missing message is from reading the code). Each round adds a Redis entry that lives for an hour and requests the media file again over the network. | Reproduced, New                 | `VideoPlayer.jsx:580-591`, `useSignedPlayback.js:132`, `endpoints.ts:237-241` | S                |
| P2  | No format policy. `downloadOptions` sets no `-f`, `-S` or remux, so yt-dlp's default choice is what gets archived. In the laptop sample, 14 of 105 files are AV1 or VP9 in WebM, including AV1 at 2160p.                                                                                                    | Code, Seen in survey            | `pipeline/types.ts:118-141`                                                   | M                |
| P3  | No buffering indicator. The `<video>` has no `onWaiting`, `onStalled` or `onCanPlay`, and the spinner only covers URL signing. A stall looks like a frozen app, which may be part of why it feels "mid".                                                                                                    | Code, New                       | `VideoPlayer.jsx:657-698`                                                     | S                |
| P4  | No `poster`, so a track starts black until its first frame.                                                                                                                                                                                                                                                 | Code, New                       | `VideoPlayer.jsx:669`                                                         | S                |
| P5  | Fullscreen icon goes wrong after Esc: no `fullscreenchange` listener.                                                                                                                                                                                                                                       | Code, Handoff #4                | `VideoPlayer.jsx:388-396`                                                     | S                |
| P6  | Tapping the video always toggles play. You can't bring back the controls without also pausing.                                                                                                                                                                                                              | Code, New                       | `VideoPlayer.jsx:745-756`                                                     | S                |
| P7  | The player uses a different definition of mobile from the app. The tablet gets the list's mobile layout but the player's small desktop controls. With the drawer open in portrait, the fullscreen button disappears.                                                                                        | Code, Seen, New                 | `VideoPlayer.jsx:137` vs `App.jsx:414-416`                                    | S                |
| P8  | No Media Session API, no next/previous shortcuts, and the next video starts with no countdown.                                                                                                                                                                                                              | Code, Handoff #8                | `VideoPlayer.jsx:455-498, 524-529`                                            | S each           |
| P9  | Every download progress tick re-renders the whole player: `DownloadContext` value → `SubList` → an unmemoized `VideoPlayer`. `memo(PlayerControlBar)` can't help because five of its props are new functions on every render.                                                                               | Code; cost needs measuring, New | `DownloadContext.jsx:329`, `SubList.jsx:94, 980`, `VideoPlayer.jsx:114`       | M (solved by S3) |
| P10 | Two range-parsing bugs: `bytes=-N` is read as bytes 0 to N, not the last N bytes, and an end past the end of the file gets `416` where RFC 7233 says to serve the rest of the file. Browsers rarely send either.                                                                                            | Code, New                       | `serveNativeFile.ts:77-84`                                                    | S                |

**Handoff hypotheses this review contradicts or could not support**

- _"Media goes through Node."_ **Refuted.** It is a native Deno stream with
  working `206` and `Range`, sitting behind Traefik. Whether it is slow is
  unmeasured, and the serving model should not change until Phase 0 says so.
- _"MP4 index at the end of the file."_ **Refuted in the sample.** All 91 MP4s
  have `moov` first.
- _HEVC, MKV and Opus-in-MP4 as the cause._ **Not supported yet.** The laptop
  sample has none of them. It holds 105 files, while Unlisted alone has 3,420
  rows on the Pi, so the real failures may be in files this survey never saw.

### Product and library

| #  | Finding                                                                                                                                                                                                                                                       | Status                             | Evidence                                          | Size              |
| :- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------- | :------------------------------------------------ | :---------------- |
| L1 | `#/` is an empty panel. There is no home, no saved progress, and no "continue watching".                                                                                                                                                                      | Code, Seen, Handoff #1             | `routes.js:16`, `App.jsx`                         | L (S4)            |
| L2 | Unlisted is oldest-first, so anything new is on the last page. The recording shows scrolling through a long page menu to get there.                                                                                                                           | Code, Seen, New                    | `queries.ts:186`, `listing.ts:1034`               | S                 |
| L3 | A background listing pulls you away from what you're browsing. If you are on Unlisted page 3 and the bot lists a link, you jump to the last page.                                                                                                             | Code, New                          | `useSocketEvents.js:441-451`                      | S                 |
| L4 | The queue drawer is one list page, and Next at a page boundary turns the list underneath.                                                                                                                                                                     | Code, Seen (`428/428`), Handoff #2 | `usePlaylistNavigation.js:61-69`                  | M (S3)            |
| L5 | The player lives inside `SubList`'s dialog and can't exist without it.                                                                                                                                                                                        | Code, Handoff #3                   | `SubList.jsx:964-988`                             | L (S3)            |
| L6 | Search text and sort aren't in the URL, so Back and reload lose them. Search that finds nothing shows a blank panel and `0-0 of 0`. The prefixes (`url:`, `title:`, `global:`) are undiscoverable, and `global:` is only global from no playlist or Unlisted. | Code, Seen, New                    | `routes.js`, `queries.ts:227-246`                 | M                 |
| L7 | A remote `onlineThumbnail` is shown while the local one is being signed, with no `onError` fallback. That sends a needless request to the source site. It also matches the blocked `.jpg` warnings in the console, though the hosts are unconfirmed.          | Code, Seen, New                    | `SubListItemCard.jsx:324-338`                     | S                 |
| L8 | Thumbnail URLs are re-signed on every playlist open, so `max-age` never helps across visits, and a page costs a Redis write per thumbnail. Local thumbnails are small (median 63 KB, p90 122 KB), so this is about the cache rather than size.                | Code; impact needs measuring, New  | `useThumbnailUrls.js:206-212`, `files.ts:202-221` | M, needs approval |

### Design

| #   | Finding                                                                                                                                                                      | Status                         | Evidence                                                                                                          | Size |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------- | :--- |
| D1  | **Delete Files is a green icon, next to a green Download icon.** The same slot is a red "delete from DB" on rows not yet downloaded. These sit one tap from every thumbnail. | Code, Seen, Handoff #5 (worse) | `SubListItemCard.jsx:438-458`                                                                                     | S    |
| D2  | Downloaded thumbnails are 70% opaque and undownloaded ones are 100%, so what you can watch looks weaker. The player's drawer does the opposite.                              | Code, Seen, New                | `SubListItemCard.jsx:342`                                                                                         | S    |
| D3  | "Watch" means auto-update monitoring, which will collide with a real watch mode. "Load / LIST / DONE" is also unclear: a green DONE button means "this one is open".         | Seen, New                      | `PlayList.jsx:559-567`                                                                                            | S    |
| D4  | Six equal nav buttons: Re-index and Logout carry the same weight as Unlisted. **"Connected" is secretly the notifications button.**                                          | Code, Seen, New                | `Nav.jsx:134-210, 351-374`                                                                                        | S    |
| D5  | Re-index exposes raw pipeline settings at the top level (`Start (Exclusive)`, `Stop (Inclusive)`, `Chunk Size`).                                                             | Seen, New                      | `Nav.jsx:235-308`                                                                                                 | S    |
| D6  | One FAB is both "clear list" and "download selected", depending on selection. On touch it can also cover list rows.                                                          | Code, Seen, New                | `SubList.jsx:1017-1049`                                                                                           | S    |
| D7  | The sentence "Nothing downloaded yet — cancelling this one costs nothing" repeats under every queued job, so about six jobs fit on screen.                                   | Code, Seen, New                | `JobDrawer.jsx:183`                                                                                               | S    |
| D8  | "Downloaded" means both "saved to the server" and "saved to this device". Rows have no direct "save" action, only checkbox then FAB.                                         | Code, New                      | `SubListItemCard.jsx:459`                                                                                         | S    |
| D9  | `IC:`, an unexplained `Saved`, page size 1, and a page menu with 428 entries.                                                                                                | Code, Seen, Handoff #6         | `SubList.jsx:829, 940-942`, `Pagination.jsx:60`                                                                   | S    |
| D10 | The autoplay switch is tooltip-only, and the playlist title only appears as the search box's label.                                                                          | Code, Seen, Handoff #6         | `VideoPlayer.jsx:773-787`                                                                                         | S    |
| D11 | The one progress bar averages all jobs.                                                                                                                                      | Code, Handoff #9               | `App.jsx:511-546`                                                                                                 | S    |
| D12 | "Connected to Backend" pops up over the player's controls.                                                                                                                   | Seen, New                      | `useSocketEvents.js:232`                                                                                          | S    |
| D13 | Accessibility: no `aria-live` anywhere, so progress is silent to screen readers. Lists have no loading or empty states.                                                      | Code, New                      | `grep` across `components/`                                                                                       | M    |
| D14 | Layout height is calculated in JavaScript. There is no `dvh` or safe-area handling anywhere.                                                                                 | Code, Handoff #7               | `App.jsx:418-437`                                                                                                 | S    |
| D15 | `#1976d2` / `rgba(25,118,210)` is hard-coded in four places, while the theme's primary is `#82b1ff` in dark mode.                                                            | Code, New                      | `VideoPlayer.jsx:792`, `PlayerControlBar.jsx:193, 204`, `PlayerPlaylistDrawer.jsx:245`, `SubListItemCard.jsx:359` | S    |

**Worth keeping (confirmed in the screenshots):** bot links survive a login and
open the right video at the right place. Subtitles, transcript sync, the
description dialog and the speed menu all look like they work well. The routing
design is sound; the proposals below only extend it.

**Console noise:** the CSP error appears to come from a browser extension,
because its source is a UUID path rather than an app bundle, so it isn't worth
chasing.

### Architecture

| #  | Finding                                                                                                                                                                                                                                                                                      | Status                     | Evidence                                 | Size   |
| :- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------- | :--------------------------------------- | :----- |
| A1 | `reFetch*` timestamp strings pass through `App` and also drive `subListIndex`, `playListIndex` and the route's page. "Which page am I on" has several owners that sync through effects.                                                                                                      | Code, Handoff #10          | `App.jsx:351-379`, `SubList.jsx:660-676` | M (S2) |
| A2 | `downloadedItem` is a ref read during render, relying on the snackbar to cause that render. Two completions batched together could lose the first row's update.                                                                                                                              | Code; not reproduced, New  | `useSocketEvents.js:260`, `App.jsx:689`  | S (S2) |
| A3 | `App` subscribes to snack state and download progress, so each one re-renders the top of the tree.                                                                                                                                                                                           | Code, New                  | `App.jsx:222-238`                        | S      |
| A4 | Polling `/queuestatus` (every 2 s open, 10 s closed) runs alongside the socket events that report the same jobs. Acceptable as a safety net, but 2 s is more than it needs.                                                                                                                  | Code, Seen in console, New | `useJobQueue.js:13-14`                   | S      |
| A5 | Docs have drifted: `VIDEO_PLAYER.md` says signed URLs last 30 minutes (`CACHE_MAX_AGE` is 3600). The comment at `queries.ts:176` says Unlisted rows share one position, while `listing.ts:1034` appends. If the comment is right, Unlisted order is effectively random. Phase 0 checks this. | Code, New                  | as listed                                | S      |

**Current data flow**

```
Providers (Auth, Socket, Notification, Download)
  → App: route, reFetch strings, list indexes, layout height, progress bar
      → PlayList (own fetch)
      → SubList (useSubListRows, useThumbnailUrls, selection, /locate, player state)
          → Dialog → VideoPlayer(19 props) → usePlaylistNavigation → SubList's page
socket events → useSocketEvents → reFetch strings, indexes, navigation, snackbars
```

**GitNexus blast radius** (indexes refreshed first; they were 153 and 40 commits
behind). **Please don't read the "LOW" ratings as safe.** They only cover what
the call graph can see.

| Symbol                                                         | Tool result                   | Reality                                                                   |
| :------------------------------------------------------------- | :---------------------------- | :------------------------------------------------------------------------ |
| `VideoPlayer`                                                  | LOW; 1 direct caller, 5 flows | 19 props taken from `SubList`'s state: the real cost of the lift          |
| `SubList`                                                      | LOW but `partial: true`       | **Unresolved.** `App` loads it with `lazy()`, which the graph can't see   |
| `usePlaylistNavigation`, `useSignedPlayback`, `useSubListRows` | Not found                     | **Unknown to the graph.** `grep` shows each has a single consumer         |
| `tryServeNativeFile`, `getSignedFileMetadata`                  | LOW; 1 direct caller each     | Consistent with `index.ts`, but the bot's links go through this route too |
| `downloadOptions`                                              | LOW but `partial: true`       | **Unresolved.** `grep` finds one consumer, `download.ts:484`              |

---

## 3. The plan

### Phase 0: measure on the Pi (no code; about an hour)

This decides how much of Phase 2 is needed, and whether serving needs any work.

**a) What is actually in the archive.** `vcodec` and `ext` should be in
`raw_metadata`, because only `formats`, `requested_formats`, `thumbnails`,
`subtitles` and `automatic_captions` are pruned. These queries also test whether
Unlisted can be grouped, and check A5.

```sql
-- Codec mix. Listing-time values, so an estimate.
SELECT raw_metadata->>'ext' AS ext, raw_metadata->>'vcodec' AS vcodec,
       raw_metadata->>'acodec' AS acodec, count(*)
FROM video_metadata WHERE "downloadStatus" GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- Is the grouping data there? Per site, for Unlisted only.
SELECT v.raw_metadata->>'extractor_key' AS site, count(*),
       count(v.raw_metadata->>'channel_id') AS channel_id,
       count(v.raw_metadata->>'uploader_id') AS uploader_id,
       count(v.raw_metadata->>'uploader') AS uploader,
       count(v.raw_metadata->>'duration') AS duration
FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl")
WHERE m."playlistUrl" = 'None' GROUP BY 1 ORDER BY 2 DESC;

-- Does Unlisted have real positions, or do they tie?
SELECT count(*), count(DISTINCT "positionInPlaylist")
FROM playlist_video_mappings WHERE "playlistUrl" = 'None';
```

Table names are from the model definitions, so check them against `\dt` first.
For ground truth on real files, run `ffprobe` on anything the SQL makes
suspicious.

**b) Is "mid" the client or the server?** On the same phone, play an AV1 file at
2160p and an H.264 file at 1080p with a similar bitrate.

- If only the AV1 file stutters, the cause is client decoding. Serving is fine,
  and the answer is Phase 2.
- If both stutter, run the next check.

**c) Server latency.** With a signed URL from the browser's network tab, run
this from a machine on the same network as the phone. It reads the file's size,
then times the start of the file and a seek to the middle. Do it again directly
against the Pi without Traefik.

```bash
SIZE=$(curl -s -o /dev/null -D - -H 'Range: bytes=0-0' "$URL" |
  tr -d '\r' | awk -F/ 'tolower($0) ~ /^content-range:/ {print $2}')
MID=$((SIZE / 2))
for RANGE in 0-1023 "$MID-$((MID + 1023))"; do
  curl -s -o /dev/null -H "Range: bytes=$RANGE" \
    -w "$RANGE ttfb=%{time_starttransfer}s total=%{time_total}s code=%{http_code}\n" "$URL"
done
```

**d) React profile.** Record the profiler during playback with a download
running, to see how much P9 costs. If it is negligible, the lift still stands on
its other reasons, but it stops being a performance project.

### Phase 1: quick fixes (one branch, with tests)

Run `npm run lint`, `npm run typecheck` and `npm test`, plus impact analysis
before each symbol edit. The order is by user impact.

1. **P1: stop the loop.** An expired URL can also surface as code 4, so one
   retry has to stay. Allow one re-sign, then show a real screen if the source
   fails again before `loadeddata`. Retry codes 2 and 3 up to twice. A retry
   that plays resets the budget, so long-video recovery keeps working. The
   screen offers Next video, Download, Copy stream URL (for VLC or mpv), and
   Open in VLC on Android.
2. **D1, D2, D8: make the cards safe.** Keep a primary action per state (Play or
   Save) and move download-to-device, remove and both deletes into a "more"
   menu, as playlist rows already do. Reserve red for destructive actions, and
   remove the dimming from thumbnails.
3. **L2: newest first by default for Unlisted,** with the sort in the header.
   This one changes visible behaviour, so it waits on decision 4. `/getsub` and
   `locateVideo` must change order together, or bot links will open the wrong
   page.
4. **L3: stop background navigation.** Only move when the viewer asked for it;
   otherwise show a toast with a "View" action.
5. **P3, P4, P5, P6, P7: player basics.** Buffering spinner, poster,
   `fullscreenchange`, a first tap that reveals controls, and one shared
   definition of mobile.
6. **P8: viewing comforts.** Media Session, `Shift+N`/`Shift+P` (`<` and `>`
   stay as speed), and an "Up next" countdown of a few seconds that can be
   cancelled.
7. **D3 to D7, D9 to D15, L7, A3, A5, P10: the small batch.** Worth noting:
   rename "Watch" to "Auto-update" _before_ any watch mode ships, make nav icons
   match their jobs, and put Re-index, theme and logout in an overflow menu.

### Phase 2: format policy (backend; needs a decision)

Existing files come first, because a new download setting doesn't help anything
already on disk.

1. **Record what each file is.** Add `mediaInfo` (codec, profile, bit depth,
   height, fps) to `VideoMetadata`. It can come from the `ffprobe` step already
   used for chapters, with a backfill like the chapters one. `/getsub` returns
   it.
2. **Check before playing.** Use `MediaCapabilities.decodingInfo` with
   `canPlayType` as a fallback. Unsupported files go straight to the P1 screen,
   and those it reports as not smooth get a small warning. Card badges could
   show this too, so you know before you tap.
3. **Lossless fixes.** Add `--remux-video "mkv>mp4"` for future downloads, and a
   batch job for existing MKVs (`ffmpeg -c copy`, no quality change). This
   should be safe for the common codecs, but test it on a sample first, because
   the file name changes and the database row has to follow.
4. **Format sort, only if Phase 0 shows it's needed.** Put it behind a setting
   (`YTDLP_FORMAT_SORT`) that is off by default. `-S "vcodec:h264,acodec:aac"`
   caps most YouTube videos around 1080p and usually makes files larger. Measure
   the real cost first with `yt-dlp --simulate --print` under both sorts on a
   few URLs.
5. **On-demand transcoding: not recommended for now.** Software H.264 on a Pi 5
   would compete with downloads for CPU, and any live transcoding needs real
   engineering around seeking. Reconsider only if Phase 0 finds a large number
   of files that nothing else can fix.

### Phase 3: structural changes (each needs your go-ahead)

Ordered so each step works on its own.

**S1. Watch progress (M).** Use a backend table, because the evidence shows
viewing on both a tablet and a laptop, and IndexedDB would keep separate
progress per device. Auth already exposes a `userId`.

- Table `watch_progress`: `userId`, `videoUrl`, `positionSeconds`,
  `durationSeconds`, `completedAt`, `updatedAt`. Primary key
  `(userId, videoUrl)`, plus an index on `(userId, updatedAt DESC)`.
- Writes reuse the existing `writeStartAt` timing, every 10 s and on pause. On
  page exit use `fetch(..., {keepalive: true})`, because auth is a bearer header
  and `sendBeacon` can't carry one.
- Treat a video as finished at 95%, or with under 30 s left.
- Reads: one query per page joined into `/getsub`, the same shape as
  `findBotExpiries`, drawn as a thin bar on each card. `GET /continue` feeds the
  home screen.
- A `t=` in the link wins over saved progress, so shared links stay exact.

**S2. Replace `reFetch` strings (M).** A small store of about 30 lines using
`useSyncExternalStore`, with no new dependency: `invalidate("playlists")`,
`invalidate("videos", url)`, and `patchRow(url, fields)` for completed
downloads. Move the 3-second batching from `useSocketEvents` into it. Make the
URL the only owner of the current page and remove the `subListIndex` /
`playListIndex` effects. This fixes A1 and A2, and S3 is much easier afterwards.

**S3. Lift the player and give it its own queue (L).** These are one change,
because the queue is the reason the player can't leave `SubList`.

1. Add `usePlayQueue(playlistUrl, sort, videoUrl)`, using the existing `/locate`
   and `/getsub`. It holds a window around the current video and never touches
   the list's `vp`.
2. Render the player from a host in `App`, driven by the route. Its props shrink
   from 19 to about 5.
3. Update `SubListPlayerRoute.test.jsx`, `VideoPlayer.test.jsx` and
   `PlayerPlaylistDrawer.test.jsx`. `usePlaylistNavigation` tests move across to
   the new hook.

This fixes L4, L5 and P9. **I'd skip the custom mini-player for now:** the app
already has browser picture-in-picture, and the lift makes a mini-player
possible later without rework.

**S4. Home and a lighter watch mode (L, needs sign-off on routes).** I'd avoid
building a separate Watch app and Manage app, because that doubles every screen.
Add one home screen, and let the existing screens serve as Manage.

```
#/                     Home: continue watching, recently added,
                       playlists with new videos, and one global search
#/library              Today's two-panel view with nothing selected
#/unlisted, #/playlist/<url>, ?v=, ?t=, pp/ps/vp/vs
                       Unchanged, so every link already sent by the bot keeps working
```

- Playlist headers get Play, Resume, and "12 new".
- Clicking a card's thumbnail or title plays; a small icon links to the source.
- **One trap:** socket handlers treat `init` as "free to navigate"
  (`useSocketEvents.js:367, 406`). Home must not inherit that, or a background
  listing will pull you off it. L3 fixes this first.
- **Open question: the login wall on bot links.** The first screenshots show
  "Session expired" and the sign-in form straight after opening a bot link,
  which is the main way into watching on mobile. Check whether "Remember me" was
  ticked and whether `TOKEN_EXPIRY=24h` plus the refresh hook cover a link
  opened the next day. If not, a longer session for trusted devices belongs in
  this step.

**S5. Organize Unlisted (M, after Phase 0's second query).** Keep `None` as
storage, with no change to mappings or folders. Add derived columns
(`channelKey`, `channelName`, `site`, `durationSeconds`) backfilled from
`raw_metadata`, so no re-index is needed. Scope the key by site, since the same
name can exist on two.

- Views: Recently added (default), By channel, By site, Via bot.
- A "via bot" _badge_ is nearly free, because `/getsub` already queries
  `BotSubmission` per page and only needs to stop filtering on expiry. A view
  filtered to bot items needs its own join, so it is a little more work.
- **The one to build first if you only build one:** "14 videos saved from this
  channel. Monitor the whole channel?" It turns a single link into a monitored
  playlist, which is exactly the problem this app was created to solve.

**S6. Stable thumbnail URLs (M, serving change, only if Phase 0 justifies it).**
Stateless signed URLs that don't change between visits would let browser caching
work. Skip this if the profile doesn't show thumbnails costing real time.

---

## 4. Decisions needed

| #  | Decision                                           | My recommendation                                                           |
| :- | :------------------------------------------------- | :-------------------------------------------------------------------------- |
| 1  | Format policy: original quality, or compatibility? | Keep original quality, add lossless remux, and decide on `-S` after Phase 0 |
| 2  | Watch progress storage                             | Backend table, per user                                                     |
| 3  | Route change: `#/` becomes Home, new `#/library`   | Yes. Only `#/` changes meaning, and existing bot links keep working         |
| 4  | Unlisted default order: newest first               | Yes                                                                         |
| 5  | Mini-player                                        | Not now                                                                     |

---

_Written 2026-11-06 from `master` at `0040ad3` and frontend at `a401984`._
