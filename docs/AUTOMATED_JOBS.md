# Automated Jobs in yt-diff

`yt-diff` uses [`node-cron`](https://www.npmjs.com/package/cron) to run
background jobs on configurable schedules. Three always run; a fourth is
registered only when the chat bot is enabled. All jobs start automatically when the
server boots and are logged with their next scheduled run time.

---

## Job Overview

| Job         | Default Schedule              | Env Var            | Purpose                                    |
| :---------- | :---------------------------- | :----------------- | :----------------------------------------- |
| **Cleanup** | `*/10 * * * *` (every 10 min) | `CLEANUP_INTERVAL` | Kill stale/zombie `yt-dlp` child processes |
| **Update**  | `*/30 * * * *` (every 30 min) | `UPDATE_SCHEDULED` | Re-scan monitored playlists for new videos |
| **Prune**   | `*/30 * * * *` (every 30 min) | `PRUNE_INTERVAL`   | Remove or relocate orphaned video records  |
| **Bot Retention** | `0 * * * *` (hourly)    | `BOT_REAP_INTERVAL` | Delete expired ephemeral chat-bot downloads |

> [!NOTE]
> **Bot Retention only exists when `BOT_ENABLED=true`.** It is constructed in
> `createJobs` behind that flag, so a disabled bot registers no reaper at all.

> [!NOTE]
> All schedules use standard
> [cron syntax](https://crontab.guru/). The timezone is controlled by the
> `TZ_PREFERRED` environment variable (default: `Asia/Kolkata`).

---

## 1. Cleanup Job

**Purpose**: Prevents resource leaks by detecting and terminating child
processes (`yt-dlp` instances) that have gone stale.

### How It Works

1. Iterates over two process tracking maps: `downloadProcesses` and
   `listProcesses`.
2. For each tracked process:
   - **Completed/Failed** processes → entry is deleted from the map.
   - **Running download** processes older than `PROCESS_MAX_AGE` → forcefully
     killed (`SIGKILL`, falling back to `SIGTERM`) and removed from the map.
   - **Running list** processes → the `maxLifetime` kill is **skipped** if the
     process has produced stdout data within the `maxIdle` window. This prevents
     premature termination of large playlist scans (e.g., 5,000-item playlists).
3. Logs the number of cleaned processes and the next scheduled run.

### Configuration

| Env Var            | Default          | Description                                                  |
| :----------------- | :--------------- | :----------------------------------------------------------- |
| `CLEANUP_INTERVAL` | `*/10 * * * *`   | Cron expression for cleanup frequency                        |
| `PROCESS_MAX_AGE`  | `300000` (5 min) | Max age in milliseconds before a process is considered stale |

---

## 2. Update Job

**Purpose**: Automatically re-scans tracked playlists and channels for new
videos that were added since the last check.

### How It Works

1. Queries `PlaylistMetadata` for all playlists with `monitoringType` set to
   `Start`, `End`, or `Full`.
2. Separates playlists into three groups by monitoring type.
3. Builds listing descriptors with `isScheduledUpdate = true` (bypasses the
   "already listed" guard in the listing pipeline).
4. For YouTube playlists/channels, uses the YouTube Data API if credentials are
   configured (completes in seconds instead of hours). Falls back to `yt-dlp`
   for non-YouTube URLs or when API credentials are missing.
5. Feeds all items into `listItemsConcurrently()` in this order:
   **Start → End → Full** — cheaper incremental scans run first so they don't
   get blocked behind expensive full re-scans.
6. Logs the total number of completed updates and the next scheduled run.

### Monitoring Types Recap

| Type      | Behavior                                                                           | Best For                                                      |
| :-------- | :--------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| **Start** | Scans from index 1 forward; exits early after 2 consecutive fully-duplicate chunks | Channels where new videos appear at the **top**               |
| **End**   | Scans from `(max index - chunk size + 1)` onward                                   | Playlists where new videos are **appended** at the bottom     |
| **Full**  | Complete start-to-end re-scan; resets to `N/A` after success                       | Playlists with arbitrary insertions, deletions, or reordering |
| **N/A**   | Ignored by the scheduler entirely                                                  | Completed archives, single videos                             |

> [!TIP]
> For a detailed explanation of each monitoring mode's internal logic, see
> [LISTING_AND_UPDATING.md](LISTING_AND_UPDATING.md).

### Configuration

| Env Var              | Default        | Description                           |
| :------------------- | :------------- | :------------------------------------ |
| `UPDATE_SCHEDULED`   | `*/30 * * * *` | Cron expression for update frequency  |
| `CHUNK_SIZE_DEFAULT` | `10`           | Number of videos per processing chunk |
| `MAX_LISTINGS`       | `2`            | Max concurrent listing processes      |

---

## 3. Prune Job

**Purpose**: Cleans up orphaned video records — videos in `VideoMetadata` that
are no longer referenced by any playlist mapping.

### How It Works

1. Runs a `NOT EXISTS` subquery to find all videos with zero entries in
   `PlaylistVideoMapping`.
2. For each unreferenced video:
   - **Downloaded** (`downloadStatus = true`): Creates a new mapping to the
     **"None"** playlist with the next available `positionInPlaylist` index.
     This preserves downloaded content so it's never silently lost.
   - **Not downloaded** (`downloadStatus = false`): Destroys the
     `VideoMetadata` row entirely — there's no data to preserve.
3. Logs the count of moved vs. pruned videos and the next scheduled run.

### When Orphans Appear

Orphaned videos are created when:
- A playlist is deleted (its mappings are cascade-deleted, but shared videos may
  remain).
- Video mappings are removed via `/delsub` with `deleteVideoMappings = true`
  but `deleteVideosInDB = false`.
- A platform-side deletion during a re-scan causes stale mapping entries.

> [!TIP]
> For the full deletion lifecycle, see
> [DELETION_BEHAVIOR.md](DELETION_BEHAVIOR.md).

### Configuration

| Env Var          | Default        | Description                         |
| :--------------- | :------------- | :---------------------------------- |
| `PRUNE_INTERVAL` | `*/30 * * * *` | Cron expression for prune frequency |

---

## Startup Behavior

All three jobs are started in `server.listen()` after an initial sleep period
(`SLEEP` seconds). On startup, each job logs:

```
level=info msg="Started {name} job" schedule="{cron expression}" nextRun="{formatted date}"
```

Jobs continue running for the lifetime of the server process.

---

## 4. Bot Retention Job (Reaper)

**Purpose**: Deletes the files of expired *ephemeral* chat-bot downloads, so a
bot used as a "fetch me this video" tool does not slowly fill the disk.

Registered only when `BOT_ENABLED=true`. Implemented in `src/bot/retention.ts`.

### What it selects

A submission is reaped only when **all** of these hold:

```
status          = 'delivered'
retention       = 'ephemeral'
downloadedByBot = true
expiresAt       < now()
canonicalUrl    IS NOT NULL
```

### Three guards, all load-bearing

1. **`downloadedByBot = true` only.** When the bot is asked for something that
   was *already on disk*, it delivers the existing file and records
   `downloadedByBot = false, expiresAt = null`. The reaper therefore never
   deletes a file the bot did not fetch — this covers web-UI downloads and
   re-sends of anything fetched earlier.
2. **Must have a `BotSubmission` row.** Selection starts from that table, so a
   video with no bot involvement is unreachable by the reaper.
3. **Skips monitored playlists.** Anything mapped to a playlist whose
   `monitoringType` is `Start`, `End` or `Full` is left alone, otherwise the
   reaper and the scheduled Update job fight over the same files.

### What it deletes, and what survives

Deleted from `SAVE_PATH`: the media file and all four sidecars (thumbnail,
subtitles, comments, description), via the shared `removeVideoFiles` helper —
the same one the web UI's delete-with-cleanup uses, so the two cannot drift.

The `VideoMetadata` row is then reset to exactly the columns that
delete-with-cleanup resets:

```
downloadStatus = false
fileName, thumbNailFile, subTitleFile, commentsFile,
descriptionFile, saveDirectory = null
```

**The row itself and its playlist mapping always survive.** Nothing is ever
hard-deleted. That is what keeps `/search`, `/history` and one-command re-fetch
working after a reap — the video is simply marked "not downloaded" again.

Finally the submission is marked `status = 'reaped'`.

### Verified behaviour

A live run against two expired submissions:

```
considered=2 reaped=2 skipped=0
```

- both `.mp4` files and all sidecars gone from `SAVE_PATH`
- both rows: `downloadStatus=false`, all five file columns `NULL`
- both submissions: `status='reaped'`
- `VideoMetadata` rows and their `None` mappings intact, titles preserved
- a web-UI-downloaded video sitting in the same directory: **untouched**

---

## Retention vs. signed-URL expiry — two independent mechanisms

These are often confused. They are unrelated and both correct:

| | Signed download links | Downloaded files |
| :-- | :-- | :-- |
| Stored in | Redis (`signed:<uuid>`) | `SAVE_PATH` on disk |
| Expires via | Redis key TTL — **self-evicting** | Bot Retention job |
| Controlled by | `CACHE_MAX_AGE` (default 1h) | `BOT_RETENTION_HOURS` (default 24h) |
| On expiry | the link 404s | the file is deleted, row reset |

**Signed URLs need no cleanup code.** Redis evicts the key on its own when the
TTL lapses; nothing scans for stale links. The TTL *slides* on each access, so a
link that is being used stays alive.

Bot links and web-UI links share one lifetime. There used to be a separate
`BOT_SIGNED_URL_TTL`, removed because an expired bot link costs one `/link
<url>` to regenerate — and because two of the three renewal paths
(`refreshSignedUrl`, `refreshSignedUrls`) ignored the per-entry TTL anyway, so
the longer lifetime was never reliably honoured.

The two combine predictably:

- **Persistent submission** — file kept forever; the link still expires after
  `CACHE_MAX_AGE`. Ask the bot again, or send `/link <url>`, for a fresh one; no
  re-download happens because dedupe tier 1 sees the file on disk.
- **Ephemeral submission** — the link expires first (1h), then the file is
  reaped (24h). After that, asking again re-downloads it.

### Testing retention quickly

`BOT_RETENTION_HOURS` accepts fractional values:

```
BOT_REAP_INTERVAL="*/15 * * * *"   # sweep every 15 minutes
BOT_RETENTION_HOURS=0.25           # expire 15 minutes after delivery
```

Both are already set in the `deno task bot` / `deno task bot:proxy` tasks.
Production defaults in `envs/base.env` remain hourly / 24h.

> [!NOTE]
> A sweep that finds nothing logs `No expired bot downloads found to reap`.
> A silent sweep would be indistinguishable from a broken one.

---
*Last updated at: 2026-06-10T14:01:59+05:30*
