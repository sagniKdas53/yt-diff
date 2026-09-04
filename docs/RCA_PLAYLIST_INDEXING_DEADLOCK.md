# Root Cause Analysis (RCA): Playlist Indexing OS Pipe Deadlock & Telegram Bot Stall

- **Incident Date**: 2026-09-04
- **Incident Time**: ~14:16:51 UTC (19:46:51 IST) to 15:12:22+ UTC (20:42:22+
  IST)
- **Impacted Systems**: Telegram Bot (`y1_b0t`), Background Listing Pipeline,
  Backend Semaphore Queue
- **Artifacts Analyzed**:
  - Container Log:
    [`yt-diff-2026-09-04T15-12-22.log`](file:///home/sagnik/Downloads/yt-diff-2026-09-04T15-12-22.zip)
  - Telegram Client Screenshot:
    [`Screenshot 2026-09-04 at 19-50-14 Telegram Web.png`](file:///home/sagnik/Downloads/Screenshot%202026-09-04%20at%2019-50-14%20Telegram%20Web.png)

---

## 1. Executive Summary

On 2026-09-04 at 19:46 IST (14:16 UTC), a user submitted a YouTube playlist URL
(`https://www.youtube.com/playlist?list=PLbOpPUpNif8QDDLE6pjOB2QQq6KHVNnHy`) to
the Telegram bot. The bot replied with its initial acknowledgement:

> _"That's a playlist — indexing it. Nothing gets downloaded; browse it with
> /list when it finishes."_

Immediately following this acknowledgement, the bot completely stalled. All
subsequent user submissions—including an Iwara profile link sent at 19:48 IST
and an X/Twitter link sent at 19:49 IST—were ignored without any response or log
entry.

The stall was caused by a **classic OS pipe buffer deadlock** in
[`addPlaylist()`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/playlist-records.ts#L49-L88):

1. [`addPlaylist()`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/playlist-records.ts#L49)
   spawned `yt-dlp` to probe the playlist title for the first 5 items
   (`--playlist-items 1:5 --ignore-errors --dump-json`).
2. Its helper `readFirstLine()` read the first non-empty line (video #1's
   metadata) from `stdout` and returned immediately, exiting the consumer
   generator.
3. Neither `addPlaylist` nor `streamLines` drained or cancelled the remainder of
   `titleProcess.stdout`.
4. While items 2, 3, and 4 failed age-verification and logged errors to
   `stderr`, item 5 succeeded. `yt-dlp` attempted to write item 5's ~600 KB JSON
   metadata to `stdout`.
5. Because the parent process was no longer reading from `stdout`, the Linux
   kernel pipe buffer (64 KB) filled up. `yt-dlp` blocked indefinitely in kernel
   space on `write(1, ...)`.
6. Deno's `Promise.all([readFirstLine(), drainStderr(), titleProcess.status])`
   waited indefinitely for `titleProcess.status` to resolve.
7. Because `addPlaylist` never resolved,
   [`ListingSemaphore`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/listing.ts#L87)
   was held forever.
8. Because `handleMessage` awaited `runPlaylistIndex` synchronously within the
   grammY message listener, grammY's sequential polling loop froze, halting all
   future update processing.

---

## 2. Incident Timeline

| Local Time (IST) | UTC Time  | Event / Log Observation                                                                                                                                                                                                  |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **19:41:59**     | 14:11:59Z | User submits Iwara video (`.../cIzlF2cJvJ19Fh`). `ListingSemaphore` is acquired and released normally at 14:12:01Z (2.5s duration).                                                                                      |
| **19:42:xx**     | 14:12:xxZ | Video is downloaded and uploaded/delivered via download link to user.                                                                                                                                                    |
| **19:46:50**     | 14:16:50Z | User submits YouTube playlist: `https://www.youtube.com/playlist?list=PLbOpPUpNif8QDDLE6pjOB2QQq6KHVNnHy`.                                                                                                               |
| **19:46:51**     | 14:16:51Z | Bot sends Telegram ack message. `ListingSemaphore` acquired (`current concurrent: 1`).                                                                                                                                   |
| **19:46:51**     | 14:16:51Z | `executeListing` finds playlist not in DB, invokes `addPlaylist()`: `yt-dlp --playlist-items 1:5 --ignore-errors --dump-json --no-download -- https://www.youtube.com/playlist?list=PLbOpPUpNif8QDDLE6pjOB2QQq6KHVNnHy`. |
| **19:46:52**     | 14:16:52Z | Stderr: `WARNING: [youtube:tab] YouTube said: INFO - 69 unavailable videos are hidden`. Video #1 (`PcLe0mfGl3E`) outputs full JSON (~600 KB) to `stdout`. `readFirstLine()` receives it and returns.                     |
| **19:46:56**     | 14:16:56Z | Stderr: `ERROR: [youtube] OHpdulmGRmk: Sign in to confirm your age.` (Video #2).                                                                                                                                         |
| **19:46:57**     | 14:16:57Z | Stderr: `ERROR: [youtube] phzIXNXCJ3A: Sign in to confirm your age.` (Video #3).                                                                                                                                         |
| **19:46:58**     | 14:16:58Z | Stderr: `ERROR: [youtube] -eJn4c6REdI: Sign in to confirm your age.` (Video #4).                                                                                                                                         |
| **19:46:59**     | 14:16:59Z | Video #5 (`uthFZtoaVJc`) succeeds. `yt-dlp` attempts to write ~600 KB JSON to `stdout`. **Pipe buffer fills (64 KB). `yt-dlp` blocks in `write()`. Deadlock begins.**                                                    |
| **19:48:xx**     | 14:18:xxZ | User sends `https://www.iwara.tv/profile/akomni/videos`. No bot reply, no log entry (grammY polling loop stuck).                                                                                                         |
| **19:49:xx**     | 14:19:xxZ | User sends `https://x.com/dehelebe/status/2022989267849666968`. No bot reply, no log entry.                                                                                                                              |
| **20:30:00**     | 15:00:00Z | Cron cleanup runs: `cleanedDownloads=0 cleanedLists=0`. Stalled process is untracked and in `"pending"` status, so it is skipped.                                                                                        |
| **20:42:22**     | 15:12:22Z | Operator exports container logs. `ListingSemaphore` is still held with concurrency 1. Total stall time > 55 minutes.                                                                                                     |

---

## 3. Root Cause Analysis

### 3.1 Primary Cause: Pipe Buffer Deadlock in `addPlaylist`

In
[`src/handlers/pipeline/playlist-records.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/playlist-records.ts#L49-L88):

```typescript
export async function addPlaylist(
  deps: PlaylistRecordDependencies,
  playlistUrl: string,
  monitoringType: string,
): Promise<PlaylistMetadata> {
  const { launchYtDlp, streamLines, streamTextChunks } = deps;
  const { process: titleProcess } = launchYtDlp({
    url: playlistUrl,
    flags: [
      "--playlist-items",
      "1:5",
      "--ignore-errors",
      "--dump-json",
      "--no-download",
    ],
    reason: "Trying to get playlist title",
  });

  const readFirstLine = async (): Promise<string | null> => {
    for await (const line of streamLines(titleProcess.stdout)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed; // <-- BREAKS OUT OF LOOP!
    }
    return null;
  };

  const drainStderr = async () => {
    for await (const data of streamTextChunks(titleProcess.stderr)) {
      logger.error(`Error getting playlist title: ${data}`);
    }
  };

  const [firstValidLine, , status] = await Promise.all([
    readFirstLine(),
    drainStderr().catch(() => {}),
    titleProcess.status, // <-- WAITS FOR yt-dlp EXIT!
  ]);
```

#### Why it deadlocked:

1. **OS Pipe Semantics**: Pipes on Linux have a default capacity of 65,536 bytes
   (64 KB). When a child process writes more data than fits in the pipe buffer
   without a reader draining it, the `write()` system call blocks until the
   buffer is cleared.
2. **Early Exit Without Draining or Killing**: `readFirstLine()` reads the first
   valid JSON line (video #1) and immediately returns. Exiting the `for await`
   loop cancels the stream reader, but **does not drain the remaining stream or
   close the underlying OS pipe file descriptor**.
3. **Multi-item Probing**: Because `--playlist-items 1:5` was used, `yt-dlp`
   kept executing to examine the remaining items.
4. **Large Payloads**: In `yt-dlp`, each entry output under `--dump-json`
   contains full media formats, storyboards, HTTP headers, and URL
   fragments—typically between 400 KB and 1 MB.
5. When video #5 succeeded, `yt-dlp` wrote its ~600 KB JSON dump into the pipe.
   The pipe saturated at 64 KB, blocking `yt-dlp` in `sys.stdout.write()`.
6. Because `yt-dlp` was blocked on stdout, it never closed stderr, never exited,
   and never completed.
7. Consequently, `titleProcess.status` and `drainStderr()` never resolved,
   deadlocking `Promise.all`.

---

### 3.2 Secondary Cause: GrammY Sequential Polling Freeze

In
[`src/bot/adapters/telegram.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/bot/adapters/telegram.ts#L31-L40):

```typescript
bot.on("message:text", async (ctx) => {
  await onMessage({
    platform: "telegram",
    chatId: String(ctx.chat.id),
    messageId: String(ctx.message.message_id),
    text: ctx.message.text.trim(),
  });
});
```

And in
[`src/bot/submissions.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/bot/submissions.ts#L120-L132):

```typescript
if (isPlaylist) {
  rt.pending.delete(canonicalUrl);
  await runPlaylistIndex(rt, { ... }); // <-- AWAITED DIRECTLY INSIDE onMessage!
  return;
}
```

- GrammY's standard polling mechanism (`bot.start()`) dispatches incoming
  updates sequentially in a
  `for (const update of updates) { await handleUpdate(update); }` loop.
- Because `onMessage` for the playlist message never resolved, GrammY's update
  handler never resolved.
- GrammY halted processing of the update queue and never invoked `getUpdates`
  for subsequent messages. This is why the user's subsequent messages at 19:48
  and 19:49 received no response and left no traces in the logs.

---

### 3.3 Tertiary Cause: Semaphore Lockout

In
[`src/handlers/pipeline/listing.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/listing.ts#L146-L195):

- `ListingSemaphore` is configured with concurrency limit 1 (`maxListings: 1`).
- `listWithSemaphore` acquired the semaphore before calling `executeListing`,
  with release placed in a `finally` block.
- Because `executeListing` remained blocked inside `addPlaylist`,
  `ListingSemaphore` was held permanently.
- Any subsequent listing request from any user (web UI or chat bot) would
  immediately stall upon calling `await rt.semaphore.acquire()`.

---

### 3.4 Quaternary Cause: Evasion of Recovery Mechanisms

The system has two watchdog/cleanup systems, but both were evaded:

1. **Bot Watchdog Evasion**:
   [`src/bot/submissions.ts:123`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/bot/submissions.ts#L123)
   explicitly removes the URL from `rt.pending`:
   ```typescript
   // Release the download reservation — runPlaylistIndex tracks its own progress
   rt.pending.delete(canonicalUrl);
   ```
   The 30-minute bot watchdog (`armWatchdog`) is only registered for video
   downloads in `rt.pending`, leaving playlist indexing unmonitored by the bot
   watchdog.

2. **Process Cleanup Evasion**:
   [`src/handlers/pipeline/process-manager.ts:102`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/process-manager.ts#L102):
   ```typescript
   if (status === "running" && (idleTime > maxIdleTime || age > maxLifetime || isErrorOnly))
   ```
   - `titleProcess` is a temporary probe process launched inside `addPlaylist`
     and is never registered in `rt.listProcesses`.
   - The listing entry in `rt.listProcesses` (`entryKey = "pending_..."`) was
     created with `status: "pending"` and `spawnedProcess: null`.
   - `cleanupStaleProcesses` only cleans entries with `status === "running"`,
     `"completed"`, or `"failed"`, ignoring `"pending"`.
   - Even if it checked `"pending"`, `spawnedProcess` was `null`, so there was
     no process handle to terminate.

---

## 4. Empirical Reproduction

The deadlock was reproduced in Deno by simulating a child process writing a
second payload (> 64 KB) after the parent reads the first chunk and awaits
process exit without draining `stdout`:

```typescript
const p = new Deno.Command("python3", {
  args: [
    "-c",
    "import sys; sys.stdout.write('line1\\n'); sys.stdout.flush(); sys.stdout.write('x' * 1000000 + '\\n'); sys.stdout.flush(); print('done', file=sys.stderr)",
  ],
  stdout: "piped",
  stderr: "piped",
}).spawn();

// Parent reads only the first chunk and stops reading
const reader = p.stdout.getReader();
await reader.read();
reader.releaseLock();

// Parent awaits process exit
await p.status; // <-- HANGS INDEFINITELY (TIMED OUT)
```

Direct execution of `yt-dlp` with
`--playlist-items 1:5 --ignore-errors --dump-json` on the exact playlist URL
confirmed:

- Entry 1 (`PcLe0mfGl3E`): Outputs 600 KB JSON to `stdout` containing
  `playlist_title: "MMD Lo-Chan (Type.LO)"`.
- Entries 2, 3, 4: Fail age gate, output error lines to `stderr`.
- Entry 5 (`uthFZtoaVJc`): Outputs 600 KB JSON to `stdout`.
- The volume of stdout output for entry 5 far exceeds the 64 KB Linux pipe
  limit, proving 100% deadlock inevitability under the existing code.

---

## 5. Recommended Solutions & Action Items

### 5.1 Fix `addPlaylist` in `src/handlers/pipeline/playlist-records.ts` (Immediate / High Priority)

#### Option A: Terminate `titleProcess` as soon as title is found (Recommended)

Once the first valid line is read, the probe has already succeeded. There is no
need to wait for `yt-dlp` to inspect the remaining items:

```typescript
export async function addPlaylist(
  deps: PlaylistRecordDependencies,
  playlistUrl: string,
  monitoringType: string,
): Promise<PlaylistMetadata> {
  const { launchYtDlp, streamLines, streamTextChunks } = deps;
  const { process: titleProcess } = launchYtDlp({
    url: playlistUrl,
    flags: [
      "--playlist-items",
      "1:5",
      "--ignore-errors",
      "--dump-json",
      "--no-download",
    ],
    reason: "Trying to get playlist title",
  });

  const readFirstLine = async (): Promise<string | null> => {
    for await (const line of streamLines(titleProcess.stdout)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        // Cancel the stdout stream and terminate probe process immediately
        try {
          titleProcess.stdout.cancel().catch(() => {});
          titleProcess.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
        return trimmed;
      }
    }
    return null;
  };

  const drainStderr = async () => {
    for await (const data of streamTextChunks(titleProcess.stderr)) {
      logger.error(`Error getting playlist title: ${data}`);
    }
  };

  const [firstValidLine] = await Promise.all([
    readFirstLine(),
    drainStderr().catch(() => {}),
    titleProcess.status.catch(() => ({ code: 1, signal: null })),
  ]);
  // ...
```

#### Option B: Drain `stdout` concurrently

If `titleProcess` must be allowed to exit naturally without `SIGTERM`, `stdout`
must be drained in the background:

```typescript
const drainStdout = async () => {
  try {
    for await (const _ of titleProcess.stdout) {}
  } catch {
    // Ignore stream cancellation / reader abort
  }
};
```

---

### 5.2 Lightweight Title Probing with `--flat-playlist` (Optimization)

Using full `--dump-json` on video items outputs entire video object graphs
(including format tables, storyboards, and headers) simply to extract
`playlist_title`. Switching to `--flat-playlist` or `--print playlist_title`
drastically reduces execution time, memory, and stdout volume:

```bash
yt-dlp --flat-playlist --playlist-items 1 --dump-single-json --no-download -- "<url>"
```

This returns the playlist metadata object directly in milliseconds without
probing video-level formats.

---

### 5.3 Decouple Playlist Indexing from the Telegram Handler (Architecture)

In
[`src/bot/submissions.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/bot/submissions.ts#L120-L132):
Playlist indexing can take several minutes. Do not hold the Telegram message
handler awaiting the completion of indexing. Trigger it asynchronously
(`void runPlaylistIndex(...)`) after sending the ack message:

```typescript
if (isPlaylist) {
  rt.pending.delete(canonicalUrl);
  // Run asynchronously in the background so Telegram message dispatch loop stays unblocked
  void runPlaylistIndex(rt, {
    adapter,
    target,
    canonicalUrl,
    monitoringType: null,
    submissionId: submission.id,
  });
  return;
}
```

---

### 5.4 Use `@grammyjs/runner` for Concurrent Telegram Update Handling

Adopt `@grammyjs/runner` in
[`src/bot/adapters/telegram.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/bot/adapters/telegram.ts)
instead of standard sequential `bot.start()`. This guarantees that if a single
chat command is slow or encounters a stall, other user chats continue to be
served concurrently.

---

### 5.5 Enhance Stale Process Cleaner & Add Watchdogs

1. **Track `titleProcess`**: Attach `titleProcess` to `listEntry.spawnedProcess`
   or register it in `listProcesses`.
2. **Clean `"pending"` processes**: Update `cleanupStaleProcesses` in
   [`process-manager.ts`](file:///home/sagnik/Projects/docker-composes/yt-diff/src/handlers/pipeline/process-manager.ts#L102)
   to kill entries in `"pending"` status whose age exceeds `maxLifetime` or
   `maxIdleTime`.
3. **Playlist Index Watchdog**: Ensure an explicit timeout / watchdog is armed
   for entries in `rt.listings`.

---

## 6. Resolution — what was actually changed

Shipped on 2026-09-04. Four layers, ordered by how fast each one acts.

### 6.1 An abandoned pipe is now closed (`src/utils/streams.ts`)

`streamTextChunks` and `streamLines` were defined inline in `index.ts` and
handed to the pipeline as dependencies, which is why the one rule that makes
them safe was neither tested nor implemented. They now live in
`src/utils/streams.ts`, and the chunk generator cancels its reader whenever the
consumer stops early:

```typescript
} finally {
  if (!drained) {
    try {
      await reader.cancel();
    } catch { /* already closed */ }
  }
  ...
}
```

Cancelling closes the read end, so a child still writing gets `EPIPE` and exits
instead of blocking forever. This single change would have prevented the
incident; the rest is defence in depth. Covered by `tests/streams.test.ts`.

### 6.2 The probe stops itself (`playlist-records.ts`)

`addPlaylist` now runs `probePlaylistTitle`, which:

- asks the cheap question first —
  `--flat-playlist --playlist-items 1
  --dump-single-json` returns one small
  object rather than ~600 KB of format tables per item, and falls back to the
  old per-item probe only when that yields no title;
- kills the process in a `finally` as soon as the read loop is left, because one
  line was the whole job;
- enforces a deadline (`TITLE_PROBE_TIMEOUT`, default 60 s) that escalates
  SIGTERM to SIGKILL, and skips the fallback probe when it fires;
- registers the probe against the listing's process entry via
  `setProcessStatus`, so it is no longer invisible to the cleanup job.

`tests/playlist_records.test.ts` drives it against a fake subprocess whose
`status` only resolves once its pipe is cancelled or it is killed — the same
property the kernel has, and the reason the original code hung.

### 6.3 Messages are handled off the polling loop (`src/bot/dispatcher.ts`)

grammy awaits each update's handler before fetching the next batch, so an inline
handler is a single point of failure for the whole bot. `createBotService` now
dispatches onto a two-lane worker pool:

- **Slow lane** — `get` / `link` / `download` / `index`, the commands that end
  in a yt-dlp process. `BOT_MAX_CONCURRENT_MESSAGES` (default 20) run at once;
  the rest queue FIFO, and none are dropped.
- **Quick lane** — every other command is a database read and a reply, and runs
  immediately rather than waiting behind twenty downloads.

`BOT_MAX_PENDING_PER_CHAT` also went from 5 to 20. `@grammyjs/runner` was
considered and not adopted: the dispatcher fixes the same problem for every
adapter rather than only Telegram's, and adds no dependency.

### 6.4 The cleaner sees non-terminal entries (`process-manager.ts`)

`cleanupStaleProcesses` checked the idle and lifetime clocks only for entries at
`"running"`. A listing sits at `"pending"` from the moment it takes a semaphore
slot until yt-dlp is spawned, which is exactly where this one wedged, and
`"errored"` was never reaped anywhere. All non-terminal statuses are now checked
on the same clocks; `"completed"` and `"failed"` are still reaped on sight.

### 6.5 Not done, and why

**No bot-level watchdog on `rt.listings`.** With 6.1–6.4 in place a stalled
listing has its process killed by the cleanup job, which ends the line stream,
which completes the listing with a failure the user is told about. A second
timeout at the bot layer could not cancel the pipeline work anyway — it would
only free the bot's own bookkeeping and risk a duplicate index — so the
mechanism that can actually kill the process is the one left in charge.
