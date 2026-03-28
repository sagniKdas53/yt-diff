# Automated Jobs in yt-diff

`yt-diff` uses [`node-cron`](https://www.npmjs.com/package/cron) to run three
background jobs on configurable schedules. All jobs start automatically when the
server boots and are logged with their next scheduled run time.

---

## Job Overview

| Job | Default Schedule | Env Var | Purpose |
| :-- | :--------------- | :------ | :------ |
| **Cleanup** | `*/10 * * * *` (every 10 min) | `CLEANUP_INTERVAL` | Kill stale/zombie `yt-dlp` child processes |
| **Update** | `*/30 * * * *` (every 30 min) | `UPDATE_SCHEDULED` | Re-scan monitored playlists for new videos |
| **Prune** | `*/30 * * * *` (every 30 min) | `PRUNE_INTERVAL` | Remove or relocate orphaned video records |

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
   - **Running** processes older than `PROCESS_MAX_AGE` → forcefully killed
     (`SIGKILL`, falling back to `SIGTERM`) and removed from the map.
3. Logs the number of cleaned processes and the next scheduled run.

### Configuration

| Env Var | Default | Description |
| :------ | :------ | :---------- |
| `CLEANUP_INTERVAL` | `*/10 * * * *` | Cron expression for cleanup frequency |
| `PROCESS_MAX_AGE` | `300000` (5 min) | Max age in milliseconds before a process is considered stale |

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
4. Feeds all items into `listItemsConcurrently()` in this order:
   **Start → End → Full** — cheaper incremental scans run first so they don't
   get blocked behind expensive full re-scans.
5. Logs the total number of completed updates and the next scheduled run.

### Monitoring Types Recap

| Type | Behavior | Best For |
| :--- | :------- | :------- |
| **Start** | Scans from index 1 forward; exits early after 2 consecutive fully-duplicate chunks | Channels where new videos appear at the **top** |
| **End** | Scans from `(max index - chunk size + 1)` onward | Playlists where new videos are **appended** at the bottom |
| **Full** | Complete start-to-end re-scan; no early-exit optimization | Playlists with arbitrary insertions, deletions, or reordering |
| **N/A** | Ignored by the scheduler entirely | Completed archives, single videos |

> [!TIP]
> For a detailed explanation of each monitoring mode's internal logic, see
> [LISTING_AND_UPDATING.md](LISTING_AND_UPDATING.md).

### Configuration

| Env Var | Default | Description |
| :------ | :------ | :---------- |
| `UPDATE_SCHEDULED` | `*/30 * * * *` | Cron expression for update frequency |
| `CHUNK_SIZE_DEFAULT` | `10` | Number of videos per processing chunk |
| `MAX_LISTINGS` | `2` | Max concurrent listing processes |

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

| Env Var | Default | Description |
| :------ | :------ | :---------- |
| `PRUNE_INTERVAL` | `*/30 * * * *` | Cron expression for prune frequency |

---

## Startup Behavior

All three jobs are started in `server.listen()` after an initial sleep period
(`SLEEP` seconds). On startup, each job logs:

```
level=info msg="Started {name} job" schedule="{cron expression}" nextRun="{formatted date}"
```

Jobs continue running for the lifetime of the server process.
