# Bot and player backlog

Eleven loose ideas, read against the code on 2026-09-16 and turned into a plan
that can be picked up cold. Each item records what already exists, what is
missing, the traps found while reading, and a size. Nothing here is started.

Suggested order, by risk-to-data first and then by cheapness:

| #  | Item                                            | Size           | Status      |
| :- | :---------------------------------------------- | :------------- | :---------- |
| 10 | Bot loses messages after an outage              | M              | not started |
| 11 | Sidecar 429s must not fail the download         | M              | not started |
| 6  | Sliding-window refresh retry loops              | S              | not started |
| 9  | Playback speed                                  | S              | not started |
| 5  | Resume at `t=` (index already works)            | S              | not started |
| 2  | Expiry label + keep in the UI and `/keep <url>` | S              | not started |
| 8a | Subtitles test                                  | S              | not started |
| 8b | (i) description dialog                          | S              | not started |
| 8c | Chapters                                        | S–M            | not started |
| 8d | Comments                                        | M, maybe never | not started |
| 4  | Share the player URL from the bot               | S–M            | not started |
| 1  | Cancel a listing or download from the bot       | M              | not started |
| 7  | Player render cost and shortcuts                | M              | not started |
| 3  | Playlist churn — the "diff" in yt-diff          | L              | not started |

Sizes: S = an afternoon, M = a day or two, L = a design pass then several days.

---

## 10. Bot loses the links sent while it was offline

**Observed, 2026-09-15/16 (power cut).** Four links were sent to the bot while
the box was down: three X links at 07:26, 07:39 and 07:59 on the 15th and one
YouTube short at 19:43. None got a reply. The bot came back at about 09:56 on
the 16th and processed exactly one — the 19:43 short — with no word about the
other three. A link sent at 10:52 was handled normally. (Screen recording:
`~/Videos/vokoscreenNG-2026-09-16_18-49-03.mkv`.)

**Requirement.** When the bot comes back it must work through _every_ link it
can still see, and it must say something about each one it cannot deliver —
silence is the bug, more than the missing files.

**Two separate causes, and only one is fixable in the bot.**

_A. Telegram's 24 h update retention._ Bot API long polling keeps an undelivered
update for 24 h and then drops it. The three X links were 26 h old when the bot
reconnected; the short was 14 h old. That matches the outcome exactly: the only
link inside the window was the only one processed. The adapter does nothing
wrong here — `createTelegramAdapter` does not pass `drop_pending_updates`, so
whatever Telegram still holds is delivered — but no code on our side can get the
older messages back, and a bot cannot read chat history.

Confirm from the box: the boot log after the outage should show one
`message:text` update, not four, and the X URLs should not appear at all.

```
docker logs --since 2026-09-16T09:50:00 yt-diff 2>&1 | grep -c 'Indexing'
docker logs --since 2026-09-16T09:50:00 yt-diff 2>&1 | grep -c 'x.com'
```

_B. Losing links that did arrive._ Independent of A, delivery is at-most-once
and a burst can still lose messages. This is the shape the earlier read of the
code predicted:

- A download waiting for the semaphore sits in `downloadProcesses` at status
  `pending` with `lastActivity` frozen at enqueue time
  (`src/handlers/pipeline/download.ts`, `downloadWithSemaphore`). Since
  `bb41c8c` (2026-09-04) `cleanupStaleProcesses` reaps _every_ non-terminal
  entry idle for longer than `PROCESS_MAX_AGE` (5 min; the job runs on
  `CLEANUP_INTERVAL`, `*/30` in `envs/base.env`). That was right for listings,
  which register their entry _after_ acquiring the slot, and wrong for
  downloads, which register _before_. A queued download that waits more than
  five minutes across a cleanup tick is deleted from the map.
- When its turn comes, `executeDownload` spawns yt-dlp first and then calls
  `setProcessStatus(processKey, "running", ...)`, which returns `false` for the
  missing entry → `reject(new Error("Process entry not found"))`. That rejection
  climbs through `Promise.all` in `downloadItemsConcurrently`, which
  `resolveAndEnqueue` invokes with `void` — there is no `unhandledrejection`
  handler anywhere in `index.ts` or `src/`, so Deno exits and `restart: always`
  brings the container back with `rt.pending` / `rt.listings` empty.
- `createTelegramAdapter` hands each update to the dispatcher, which returns on
  push, so grammy confirms the offset before anything is done with the message.
  `BotSubmission` rows are written at `indexing`/`downloading` but nothing reads
  them back on boot. Any exit between accept and deliver loses the message with
  no reply.

Check on the box:

```
docker logs yt-diff 2>&1 | grep -c 'Process entry not found'
docker inspect -f '{{.RestartCount}}' yt-diff
```

**Plan.**

1. Stop reaping queued downloads. In `cleanupStaleProcesses` (or at the call
   site in `src/jobs/index.ts`), skip `download` entries whose `spawnedProcess`
   is unset — they are waiting, not wedged. Alternatively register the download
   entry after `acquire()` like listings do, but that loses the queue-position
   display, so prefer the skip. Add a `process_manager.test.ts` case: a
   `pending` download with no `spawnedProcess` and a stale clock is left alone.
2. Register an `unhandledrejection` listener in `index.ts` that logs with the
   stack and calls `preventDefault()`. Crashing the whole server for one
   rejected download promise is never the right outcome.
3. Make `executeDownload` check the entry _before_ spawning, and resolve a
   `failed` result (emitting `download-failed`) rather than rejecting, so the
   bot replies "Download failed" instead of going quiet. Together with the
   existing `onFailed` reply this is the per-link failure report: every link
   that reaches the bot ends in either a file, a link, or a "failed: <reason>"
   message on the original chat.
4. Resume on boot. In `createBotService.start()`, after `core.subscribe()`,
   query `BotSubmission` rows with status in (`pending`, `indexing`,
   `downloading`) and re-run `handleSubmission` for each, preserving the
   original delivery mode (store it on the row — today only `deliveryMode` is
   recorded after the fact). The three dedupe tiers make this idempotent: an
   already-downloaded file goes straight to delivery. Reply on the original chat
   so the user sees "Picking up where I left off".
5. Report the gap. Add a `bot_heartbeat` row (or a `lastSeenAt` on a small
   `bot_state` table) touched every minute while polling and on every update. On
   boot, if `now - lastSeenAt` is more than a few minutes, send one message to
   every chat with a submission in the last 30 days:

   > I was offline from 2026-09-15 07:10 to 2026-09-16 09:56. Anything you sent
   > before 2026-09-15 09:56 never reached me — please resend it. Links from
   > after that are being picked up now.

   The cutoff is `boot - 24 h`, which is the only fact the bot has; it cannot
   name the lost links. Send this before step 4 replies so the order in the chat
   reads correctly. Keep it to one message per chat per outage.
6. Ordering. Step 4 should re-run the backlog in `createdAt` order and the
   dispatcher should keep arrival order for the updates Telegram replays, so a
   burst comes out in the order it went in. Check `bot/dispatcher.ts` — the
   worker pool may interleave; that is fine for two or three, confusing for ten.
7. Document the 24 h Telegram limit and the boot message in `docs/BOT.md` §8.
   The honest line is: an outage under 24 h loses nothing once 1–4 are in; a
   longer one loses the older links and the bot tells you so.

---

## 11. A 429 on subtitles, thumbnail or comments must not fail the download

**Symptom.** With `SAVE_SUBS`, `SAVE_THUMBNAIL`, `SAVE_DESCRIPTION` and
`SAVE_COMMENTS` all on, one yt-dlp run makes several extra requests per video
and YouTube sometimes answers one of them with `HTTP Error 429`. Today that can
take the whole download down even though the media file was written.

**Requirement.** The video file is the download. If it lands, the run is a
success; every sidecar is allowed to fail. A run with missing sidecars is
recorded as _partial_, shown as such in the web UI and in the bot's reply, and
can be retried — the retry fetches only what is missing.

"Missing" means _the source has it and we did not get it_. A video with comments
disabled, no chapters or an empty description, or a site that has no notion of
subtitles or comments at all (x.com, most non-YouTube extractors), is complete
once the media file and whatever the source _does_ offer are on disk.
`isMetaDataSynced` must not go false, and no chip or bot line must appear, for
extras that never existed.

**What the code does now (`src/handlers/pipeline/download.ts`,
`executeDownload`).**

- Exit code decides everything. `code === 0` → success; anything else →
  `download-failed` with "Process exited with code N", even when
  `capturedFileName` (from the `post_process` `--print`) is sitting in
  `savePath`. yt-dlp exits 1 whenever it reported an error, so a sidecar error
  after a finished media file is reported as a failed download.
- Whether a sidecar error aborts the media download at all depends on yt-dlp's
  `ignoreerrors`. Our options never set `--ignore-errors`, so it is the default
  `only_download`. With that, `_write_subtitles` reports an _error_ and returns
  `None`, and `process_info` returns before downloading the media — a subtitle
  429 costs the video. `_write_thumbnails` only warns. Comment extraction runs
  inside the extractor and its failure mode changes between releases. Verify all
  three against the pinned yt-dlp before relying on them: force a 429 with a
  proxy that returns it for `timedtext` / `i.ytimg.com` / `comment` requests and
  watch the exit code and what is on disk.
- On exit 0, `updates.isMetaDataSynced` is `true` regardless of `discoverFiles`'
  `syncStatus`; `allExtraFilesFound` is computed and only logged. So the DB
  cannot say "video present, subtitles missing", and neither can the UI
  (`isMetaDataSynced` is in `/getsub` and on `download-done` but never false for
  a downloaded row).
- stderr is streamed to the log and discarded; nothing keeps the last error
  text, so "429" is not recoverable after the fact.

**Plan.**

1. yt-dlp options (`pipeline/types.ts`): add `--ignore-errors` so a sidecar
   failure is a warning and the media download continues, and
   `--sleep-subtitles 1` (only when `saveSubs`) to space the timedtext requests
   out — this is the request YouTube throttles first. Consider
   `--sleep-requests 0.5` behind a config knob (`YTDLP_SLEEP_REQUESTS`) rather
   than by default; it slows every playlist run.
2. Verdict from the filesystem, not the exit code. After `status` resolves, run
   `discoverFiles` first. If `syncStatus.videoFileFound` (or `capturedFileName`
   exists in `savePath`) the download is a success even when `code !== 0`; the
   exit code is logged. Only when no media file exists is it a failure. This
   alone fixes the symptom for the thumbnail/comment cases and makes step 1 a
   belt-and-braces for subtitles.
3. Learn what the source offers, per video, from the same run. Add one more
   `--print` to `downloadOptions` that fires before the download:

   ```
   --print "before_dl:extras:subs=%(subtitles.en&1|0)s autosubs=%(automatic_captions.en&1|0)s chapters=%(chapters&1|0)s comments=%(comment_count&1|0)s description=%(description&1|0)s thumbnail=%(thumbnail&1|0)s"
   ```

   `%(field&1|0)s` prints `1` when the field is present and non-empty, `0`
   otherwise, so every extractor answers the same way — x.com prints
   `subs=0 autosubs=0 chapters=0 comments=0 description=1 thumbnail=1` without
   any per-site table. Parse it in the stdout reader next to the existing
   `before_dl:title:` line into an `offeredExtras` set. Verify the nested
   `subtitles.en` form works with `&` on the pinned yt-dlp; if it does not,
   print `%(subtitles)j` and test the key in the parser. The language must match
   `--sub-langs` — read both from one constant. `comment_count` is the best
   available signal for comments (YouTube gives `None` when they are disabled);
   a site that never sets it simply expects none. An empty description means
   yt-dlp writes no `.description` file at all, which is consistent with
   `description=0`.

4. Record partial. The expected set is `configured ∩ offered` — `configured`
   from `SAVE_*`, `offered` from step 3 (`subtitles` counts when either `subs`
   or `autosubs` is `1`). Then `missingExtras = expected − found` (found from
   `discoverFiles`' `syncStatus`) and
   `isMetaDataSynced = missingExtras.length === 0`, replacing the unconditional
   `true`. If the `extras:` line never arrived (old yt-dlp, killed early), fall
   back to `expected = configured` and log it, so the worst case is today's
   behaviour, not a silent "complete". Columns: `VideoMetadata.missingExtras`
   (JSON array of
   `"subtitles" | "thumbnail" | "description" | "comments" | "chapters"`, null
   when complete) and `lastDownloadError` (text, the last ~500 bytes of stderr)
   so the reason survives. Keep a small ring buffer of stderr lines in
   `executeDownload` and classify `HTTP Error 429` / `Too Many Requests` as
   `reason: "rate-limited"`; anything else is `"error"`. Migration for both
   columns; `missingExtras` in the `/getsub` attribute list; regenerate the API
   types. Existing rows keep their `isMetaDataSynced`; the sync pass in step 6
   recomputes it whenever it runs.
5. Events. `download-done` gains `partial: boolean`, `missingExtras` and
   `reason`. `download-failed` is unchanged and now means "no media file".
   Update `src/events.ts` types and the openapi schema.
6. Retry only the extras. A `syncExtras(videoUrl)` in `createDownloadFlow` that
   runs yt-dlp with `--skip-download` plus the same sidecar flags and the same
   `-o` template, into the same `savePath`, then re-runs `discoverFiles` and
   clears whatever is now present from `missingExtras`. It takes a download slot
   like any other run so it cannot pile onto a rate limit. Expose as
   `POST /syncextras { videoUrl }` in `endpoints.ts`; the existing
   `/dedup`-style validators apply.
7. Web UI. `useSocketEvents` carries the new fields into the row;
   `SubListItemCard.jsx` shows a warning chip — "partial: subtitles, thumbnail
   (rate limited)" — with a "Fetch missing extras" menu item that posts to
   `/syncextras` and a "retry-in-progress" state while the slot is taken. The
   existing `isMetaDataSynced` dot, if still rendered, should mean the same
   thing as "no chip".
8. Bot. `onDone` (`src/bot/subscriptions.ts`) reads `partial` and appends a line
   to the delivery message:

   > Got the video, but YouTube rate-limited the extras (subtitles, thumbnail).
   > `/sync <id>` fetches them later.

   Add `/sync <id|url>` (`commands.ts`, `queries.ts`) that resolves the
   submission like `/keep` does and calls `syncExtras`; reply on completion with
   what was recovered. `HELP_TEXT`, `docs/BOT.md` §5.
9. Optional: a scheduled retry. In `src/jobs/index.ts`, once an hour, pick up to
   N rows with `missingExtras` set, `reason = "rate-limited"` and `updatedAt`
   older than an hour, and run `syncExtras` for each with a small sleep between.
   Stop after three attempts per row (count on the row) and leave the chip; the
   manual path stays available.
10. Tests. `download_flow.test.ts` with a fake yt-dlp script that writes the
    media file, prints the `post_process` line, writes `HTTP Error 429` to
    stderr and exits 1: expect `status: "success"`, `partial: true`,
    `missingExtras` naming the sidecars the config expected _and_ the script's
    `extras:` line offered, `reason` `"rate-limited"`. A second script that
    writes nothing and exits 1: expect `failed`. A third that reports
    `chapters=0 comments=0` on its `extras:` line and writes no infojson, exit
    0: expect `partial: false` and `isMetaDataSynced: true`. A `syncExtras` test
    that a subtitle file appearing clears the entry. Bot: a `bot_dedupe`-style
    test that a partial `download-done` produces the extra line and that `/sync`
    resolves the id.

Items 8c (chapters) and 8d (comments) should build on `missingExtras` rather
than on `isMetaDataSynced`; chapter extraction failing is one more entry in the
same list, and `chapters=0` from step 3 is how 8c knows not to probe at all.

---

## 6. Sliding-window refresh for thumbnails and the playing video

**What exists.** `getSignedFileMetadata` slides the Redis TTL to `CACHE_MAX_AGE`
on every `?fileId=` access, so a _playing_ video keeps itself alive. The client
timers in `useThumbnailUrls.js` and `useSignedPlayback.js` only matter for a
paused player and for thumbnails sitting on screen.

**Bugs found.**

- `useThumbnailUrls.js`: when `/refreshfiles` throws (server restart, 5xx), the
  catch is empty and `scheduleThumbnailRefresh()` is called with the expiries
  unchanged. `refreshTime` is then `max(0, negative)` = 0, so the next attempt
  fires immediately — a tight retry loop until the server answers, and forever
  once the expiry has passed. Entries nulled on a failed refresh are never
  refetched either: the fetch effect only runs when `items` changes and treats
  `null` as "in progress".
- `useSignedPlayback.js`: a failed refresh logs and never reschedules. Playback
  then relies on `onError` recovery (remint + seek), which works but visibly
  stutters.

**Plan.**

1. Both hooks: on a failed refresh, back off (e.g. 5 s, 15 s, 60 s, cap at five
   tries) and then give up on that id; a refetch on next `items` change or a
   remint on `onError` takes over from there. Never schedule at 0 ms.
2. `useThumbnailUrls`: treat `null` as "retry me" once the backoff is exhausted
   — drop the entry from `thumbUrls` (so it is `undefined` again) rather than
   setting it to `null`.
3. Tests: `useThumbnailUrls.test.jsx` already exists — add a case where
   `/refreshfiles` rejects and assert the number of calls within a fake-timer
   window is bounded. Add a `useSignedPlayback` test with the same shape.

---

## 9. Playback speed

`VideoPlayer.jsx` has no rate control. Add a small menu (0.5, 0.75, 1, 1.25,
1.5, 2) beside the volume control, persist to `localStorage` as
`ytdiff_player_rate` like volume/mute/autoplay, and apply
`videoRef.current.playbackRate` inside the existing
`[videoUrl, volume, isMuted]` effect — the element unmounts when `videoUrl` goes
null between tracks, so the rate must be re-applied per track. `<` / `>` keys
once item 7's shortcuts exist.

---

## 5. Resume from a playlist index and seek to a time

**What exists.** `frontend/src/router/routes.js` already encodes
`#/playlist/<url>?v=<videoUrl>&vp=<page>` and `#/unlisted?v=...`. `v=` keyed by
URL is the equivalent of YouTube's `list`+`index`, and better: it survives
reorders. Back/Forward and pasted links already open the player through
`SubList`'s location effect.

**Plan.**

1. `routes.js`: add a `t` parameter (non-negative integer seconds) to
   `parseRoute` / `formatRoute`; omit when 0. Extend `routes.test.js` for the
   round-trip.
2. Thread `startAt` from `App` → `SubList` → `VideoPlayer`. Apply once on
   `loadedmetadata` for the track it was written for (guard with the
   `useSignedPlayback` session counter so a recovery remint does not reapply
   it).
3. Write `t` back with `replace: true` on pause and every ~10 s while playing,
   so Back does not accumulate history entries. `t` is dropped when the track
   changes.

---

## 2. Expiry label and a "keep" action, in the UI and as `/keep <url>`

**What exists.** `BotSubmission.expiresAt` keyed by `canonicalUrl`;
`buildExpiredSubmissionWhere` in `src/bot/retention.ts` is the source of truth
for what the reaper will take; `/keep <id>` in the bot (`handleKeep` in
`src/bot/queries.ts`) sets `retention=persistent, expiresAt=null`. The `<id>` is
the short code from `/history`, resolved by `findSubmissionByPrefix`, which is
scoped to the calling chat.

**Plan.**

1. `/getsub` (`src/handlers/playlists/queries.ts`): after the page query, one
   `BotSubmission.findAll` with `canonicalUrl IN (page urls)`,
   `expiresAt IS
   NOT NULL`, `downloadedByBot = true`, status `delivered`;
   attach the earliest `expiresAt` per URL as `botExpiresAt` on the row.
   Regenerate the API types (`deno task gen:api`).
2. `SubListItemCard.jsx`: a chip "expires in 3 h" when `botExpiresAt` is set; a
   menu item "Keep" that posts to a new `/keepfile` endpoint (body: `videoUrl`)
   which applies the same update as `handleKeep` to every matching submission.
   Add to `endpoints.ts` with the validator.
3. Bot: `/keep <url>` alongside `/keep <id>`. In `parseCommand`
   (`src/bot/commands.ts`, the `keep`/`rm` case) accept an argument that passes
   `isHttpUrl` and return `{ kind: "keep", url }`; in `handleKeep` canonicalise
   it the same way `handleSubmission` does, then update every submission for
   that `canonicalUrl` _in the calling chat_ (a new
   `store.updateSubmissionsByUrl`, or reuse the `/keepfile` helper from step 2
   with a chat filter). Reply with how many were kept, or "I never downloaded
   that link" when none match. `/rm <url>` falls out of the same parser change
   and is worth doing in the same commit. Update `HELP_TEXT` and `docs/BOT.md`
   §5, and `bot_commands.test.ts`.
4. Optional: put `botExpiresAt` on the `download-done` socket payload so the
   chip appears without a refetch.

**Related decision (see item 4).** A video pulled out of a `/list`-browsed
playlist is downloaded into that playlist's folder but still gets an
`expiresAt`, and `isInMonitoredPlaylist` only spares Start/End/Full playlists.
So a bot-fetched file in an unmonitored playlist is reaped on schedule and the
playlist row flips back to not-downloaded. Either treat "in any real playlist"
as persistent in the reaper, or make the bot say "expires in N h, /keep <url> to
keep it" in the delivery message. The second is cheaper and keeps the retention
rule in one place.

---

## 8. Subtitles, description, chapters, comments — four separate items

Reference: YouTube's page for `BUkLWjcoBc0` (screenshot
`~/Downloads/Screenshot 2026-09-16 at 18-56-32 …YouTube.png`) next to ours
(`…18-54-25 yt-diff.png`). YouTube shows the description under the title, an "In
this video" panel with Chapters / Transcript tabs and a thumbnail per chapter,
chapter gaps in the seek bar, and 3,562 comments. Ours shows the video, the
subtitle overlay, and a control bar. Items 8b and 8c close most of that gap; 8d
is the one to be suspicious of.

### 8a. Subtitles — test with real files (S)

`parseSubtitleText` handles hour-less timestamps (fixed earlier). Open questions
to test: YouTube auto-subs (`--write-auto-subs`) emit rolling duplicate cues, so
the overlay probably double-renders lines; only `en` is written
(`--sub-langs en` is hard-coded in `pipeline/types.ts`). Decide whether to
dedupe cues by text at parse time. The cue list is also the input to a
Transcript tab (8c), so get the parse right first.

### 8b. (i) description dialog (S)

`descriptionFile` is already in the `/getsub` row. Button in the control bar →
`/getfile` for a signed URL → fetch text → MUI dialog with the title, the upload
date and the description; linkify URLs and `mm:ss` timestamps (a click seeks,
which is the poor man's chapter list for videos without chapters). Reuse the
`useSubtitleTrack` fetch pattern with a session guard. Same dialog on mobile;
`VideoPlayer.test.jsx` desktop and mobile cases.

### 8c. Chapters (S–M)

**What exists.** `--embed-chapters` is already in `downloadOptions`, so every
file downloaded so far carries its chapters in the container. Browsers do not
expose embedded chapters to `<video>`, so they have to be pulled out and stored.
ffprobe ships in the image (`Dockerfile`).

**Plan.**

1. Storage: `VideoMetadata.chapters` JSON column,
   `[{ start: seconds, end: seconds, title }]`, null when none. Migration plus
   the model.
2. Extraction at discovery time. In the `discoverFiles` step after a download,
   run `ffprobe -v error -show_chapters -of json <file>` and map
   `start_time`/`end_time`/`tags.title`. One process per download, sub-second.
   Add a one-off backfill job (or a `deno task chapters:backfill`) that walks
   `downloadStatus = true` rows with `chapters IS NULL` and probes them, so the
   existing library gets chapters without re-downloading. Prefer ffprobe over
   the infojson `chapters[]` so this does not depend on 8d's file.
3. `/getsub`: add `chapters` to the attribute list; regenerate the API types.
4. Player: chapter gaps on the seek bar (MUI `Slider` `marks`, or a custom
   segmented track), the current chapter title next to `00:06 / 19:58`, and a
   Chapters list in the existing drawer with a Transcript tab beside it fed by
   the parsed cues (click → seek, highlight the active row, "sync to video time"
   toggle like YouTube's). No per-chapter thumbnails — that needs server-side
   frame extraction and is not worth it.
5. Tests: a `parseChapters` unit test on a captured ffprobe output; a
   `VideoPlayer.test.jsx` case that renders marks and seeks on click.

### 8d. Comments (M, and possibly never)

**The problem with the feature.** `BUkLWjcoBc0` has 3,562 comments; long-tail
videos have tens of thousands. Rendering that in the player is a paging and
virtualisation project, not a dialog. And the cost is on the download side too:
`--write-comments` makes yt-dlp page through every comment thread before it
finishes, which adds minutes per video and is where YouTube rate limits bite
first. The honest position is that this is not a feature the player needs, and
`SAVE_COMMENTS` should stay off by default.

**One bug to fix regardless.** `discoverFiles` looks for `<base>.info.json`, but
the download options only pass `--write-comments`, which places comments _in_
the infojson and does not write it — `--write-info-json` is also needed.
Consequences today with `SAVE_COMMENTS=true`: no file is ever found and
`commentsFileFound` never flips — and nothing notices, because
`isMetaDataSynced` is set `true` unconditionally on exit 0 (item 11 fixes that).
`commentsFile` is also not in the `/getsub` attribute list. Fix: add
`--write-info-json` when `saveComments` is on (`pipeline/types.ts`), plus
`--no-write-playlist-metafiles` so playlist runs do not emit one, and add
`--extractor-args "youtube:max_comments=<N>"` so a download is bounded.

**If it is ever built,** the only shape that works is server-side paging: a
`/comments?videoUrl&offset&limit&sort=likes` endpoint that parses the infojson
once (cache the parsed array in Redis under the file's mtime), returns top-level
comments only, and loads replies on demand by `parent`. The client renders 50 at
a time with "load more". Never ship the infojson to the browser.

---

## 4. Share the player URL from the bot

**What exists.** `createDelivery.buildSignedUrl` in `src/bot/delivery.ts` is
where the download link is built. The player needs a login (`TOKEN_EXPIRY`
defaults to 24 h); that is fine — the message carries a plain player URL and the
user logs in when asked. No token in the link.

**Where a bot download actually lands.** The bot always calls
`resolveAndEnqueue([videoUrl], "None")` (`src/bot/submissions.ts`, `enqueue`).
`resolveAndEnqueue` (`src/handlers/pipeline/download.ts`) then picks the save
directory like this:

- a fresh link (tier 3) is listed into the `None` pseudo-playlist and saved at
  the root of `SAVE_LOCATION`; it shows under Unlisted in the UI;
- a video that is already indexed under a real playlist (the `/list` →
  `/get <entry>` flow, tier 2) has no `None` mapping, so the fallback branch
  looks up its first non-`None` mapping and uses _that playlist's_
  `saveDirectory`. The file lands in the playlist's folder and the playlist row
  shows it as downloaded. It does **not** appear under Unlisted.

So the answer to "where does it go" is: into the playlist you browsed, exactly
as if you had clicked download in the UI. Two catches: if the video is mapped to
several playlists the `findOne` has no `order`, so which folder wins is
arbitrary — fix by ordering by the mapping's `createdAt` or by preferring a
monitored playlist; and the file still carries the bot's `expiresAt` (see the
note under item 2).

**Catch for the link.** `SubList`'s location effect only opens `v=` when the row
is on the _loaded page_ and silently drops the parameter otherwise. The bot
cannot know the page, and for a playlist video the link must be the playlist
route, not `#/unlisted`.

**Plan.**

1. Backend: a `/locate` endpoint (or `videoUrl` on `/getsub`) that returns, for
   a video URL, the playlist it should be opened in (the same mapping choice
   `resolveAndEnqueue` made — share the helper) and the page it sits on for the
   given page size and sort.
2. Frontend: when `v=` is set and not on the current page, call `/locate`, set
   `vp`, and let the existing effect open it. `seekSubListTo` in the listing
   events is the same idea and can share code.
3. Bot: on delivery, send `${publicBaseUrl}${urlBase}/#/playlist/<playlist>?v=…`
   for a playlist video and `#/unlisted?v=…` otherwise, alongside the download
   link (not instead — the download link works without a login). The delivery
   message also becomes the place to say "expires in N h — /keep <link> to keep
   it".

---

## 1. Cancel a listing or download from the bot

**What exists.** Nothing user-facing, in the bot or the web UI. Running
downloads carry `spawnedProcess`; SIGTERM already maps to exit 143 →
`download-failed` with "Process was killed" → the bot's `onFailed` replies.
Listings carry the same handle in `listProcesses`.

**Plan.**

1. Pipeline: `cancelDownload(url)` in `createDownloadFlow` — kill a running
   entry; for a `pending` one set `cancelled = true` and have
   `downloadWithSemaphore` bail after `acquire()` with a `failed` result.
   `cancelListing(url)` in `createListingRuntime` — kill the process; the
   singleflight joiners receive the cancelled result automatically. A cancelled
   playlist leaves a partial index, which is acceptable; log it.
2. HTTP: `POST /cancel { url, kind }` in `endpoints.ts` so the web UI can use it
   too.
3. Bot: `/cancel <id>` resolving the `/history` id to a `canonicalUrl` and
   looking it up in `rt.pending` / `rt.listings`; also accept a bare URL. Reply
   with what was stopped. Add the command to `HELP_TEXT` and `docs/BOT.md` §5.
4. Tests: `bot_commands.test.ts` for parsing; a `bot_dedupe`-style runtime test
   that a cancelled pending entry settles the submission as `failed`.

---

## 7. Player review and optimisation

**Findings in `VideoPlayer.jsx` and its hooks.**

- `onTimeUpdate` sets three states at ~4 Hz: `currentTime` in the player,
  `currentTime` again in `useSubtitleTrack`, and `bufferedTime`. Each fires a
  render of the whole 900-line tree including the drawer and MUI sliders. This
  is the dominant cost.
- Active-cue lookup is an O(n) `filter` over every cue per tick.
- No keyboard shortcuts.
- `togglePlay` sets `isPlaying` optimistically and `onPlay`/`onPause` set it
  again — harmless but redundant.

**Plan.**

1. Collapse to one time state owned by the player; pass `currentTime` into the
   subtitle hook instead of having it keep its own.
2. Split the control bar into a memoised component that receives only what it
   renders; keep the drawer out of the tick path.
3. Binary-search the cues (they are sorted by start) or pre-bucket by second.
4. Shortcuts: space/k play-pause, ←/→ ±10 s, ↑/↓ volume, m mute, f fullscreen, c
   subtitles, </> speed. Ignore when focus is in an input.
5. Measure before/after with the React profiler on a long video with auto-subs;
   `VideoPlayer.test.jsx` (desktop and mobile) must stay green.

---

## 3. Playlist churn — the "diff" in yt-diff

**What exists.** Only current state:
`PlaylistVideoMapping (videoUrl,
playlistUrl, positionInPlaylist)`, overwritten
on update. Removals are inferred (`logger.warn` in the update path, see
`docs/LISTING_AND_UPDATING.md`) and never recorded. `VideoMetadata.isAvailable`
marks videos yt-dlp reports as unavailable.

**Design.**

- New table
  `playlist_changes (id, playlistUrl, videoUrl, kind: added|moved|
  removed, fromPosition, toPosition, runId, createdAt)`,
  written by the ingest path (`ingest-chunk.ts` / `playlist-records.ts`)
  whenever a mapping is created or its position changes.
- `removed` can only be asserted by a `Full` run, which sees the whole list;
  `Start` and `End` modes never can. Record a `runId` per scheduled run and, for
  Full runs, mark mappings not seen in that run as removed (keep the mapping,
  flag it, so the row can still be shown red).
- UI: colour rows relative to a chosen baseline — "since last run" or "since I
  last opened this playlist" (a per-playlist timestamp in `localStorage`). Green
  added, red removed, blue moved, matching the git metaphor.

**Plan.**

1. Phase 1 (backend): the table, writes from the ingest path for added/moved in
   every mode, removed from Full runs; a `/changes` endpoint paged by playlist.
   Tests alongside `playlist_records.test.ts`.
2. Phase 2 (frontend): the row colouring and a "changes since" control in
   `SubList`; a summary line on the playlist row ("+12 −3 ~5 since Monday").
3. Retention: prune `playlist_changes` older than N days in the existing prune
   job.

---

_Written 2026-09-16 from a read of `master` at `035ff7c`; items 10, 2, 8 and 4
revised the same day after the 15–16 Sep outage; item 11 added the same day._
