# 07: Download queue implementation plan (proposal, not approved)

> **For agentic workers:** nothing here is approved. Don't start a task until
> the owner has marked it. Read `README.md` first.

**Goal:** you can move a download up or down the queue, a pause survives a
restart, and resuming doesn't send a half-finished download to the back.

**Reviewed:** `src/handlers/pipeline/job-control.ts`, `download.ts`,
`semaphore.ts`, `index.ts`, and the frontend's `JobDrawer.jsx` and
`useJobQueue.js`, at `b51c594`.

## How it works today

- A download registers an entry in `downloadProcesses`, then waits on
  `DownloadSemaphore`. The semaphore's queue is a plain list of callbacks with
  no ids, served first in, first out.
- **Pause** sends SIGTERM to yt-dlp, moves the job to the in-memory `pausedJobs`
  map, and keeps the `.part` file. **Resume** queues it again under the same id,
  and yt-dlp continues from the `.part`. **Cancel** waits for the process to
  exit, then deletes the partial files.
- The drawer polls `/queuestatus` and sends `/jobaction`.

The careful parts are sound and should stay: telling a pause from a failure,
waiting for exit before deleting partials, deleting only that job's files.

## What is wrong or missing

| #  | Finding                                                                                                                                                                                                                                       | Effect                                                           |
| :- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| 1  | The queue can't be reordered. Waiting jobs are anonymous callbacks inside the semaphore (`semaphore.ts:6`).                                                                                                                                   | No way to move a job up or down.                                 |
| 2  | Paused and queued jobs live only in memory (`pipeline/index.ts:31`).                                                                                                                                                                          | A restart or deploy forgets them. Partial files stay as orphans. |
| 3  | A resumed job goes to the back (`download.ts:296`, by its own comment).                                                                                                                                                                       | A download at 90% waits behind everything queued since.          |
| 4  | Only a running job can be paused (`job-control.ts:467`).                                                                                                                                                                                      | You can't hold a queued job, or pause everything.                |
| 5  | A cancelled queued job stays in the semaphore's line. Its "Cancelled before it started" failure event fires when its turn comes (`download.ts:340`), which can be much later.                                                                 | A stray failure message long after the cancel.                   |
| 6  | Pausing a download doesn't wait for yt-dlp to exit. Resume straight away with 2 or more slots and a second yt-dlp can open the same `.part` while the first is closing it. Listings guard against this (`retiringListings`); downloads don't. | Rare, but can corrupt the partial file.                          |
| 7  | A paused download doesn't block a new request for the same video: the duplicate check reads only `downloadProcesses` (`download.ts:255`). The new one starts, and the paused job then can't resume.                                           | A stuck paused row until you cancel it.                          |
| 8  | Nothing ever expires a paused job.                                                                                                                                                                                                            | Partial files stay until you cancel.                             |

Findings 5 and 6 are from reading the code. Neither was reproduced.

## Proposed design

One change underneath: replace the semaphore's anonymous line, for downloads
only, with a small ordered queue keyed by job id.

```
DownloadQueue
  enqueue(id, { front?: boolean }) -> Promise   resolves when a slot is free
  move(id, "up" | "down" | "top" | "bottom")    -> boolean
  remove(id)                                    -> boolean
  hold(id) / unhold(id)                         a held job is skipped
  release()
  order()                                       -> ids, the truth for positions
```

`/jobaction` gains `move-up`, `move-down`, `move-top` and `move-bottom`. They
answer `not-allowed` for a job that is running or paused. The drawer shows up
and down arrows on queued rows only. Positions in `/queuestatus` come from
`order()` instead of the acceptance counter.

Listings keep the plain semaphore. Extras sync shares the download slots and
joins the new queue at the back.

## Tasks, each needing a yes

### Task 1: An ordered queue, and move up and down (findings 1, 5)

**Files:** Create `src/handlers/pipeline/download-queue.ts`. Modify
`download.ts`, `job-control.ts`, `types.ts`, `src/middleware/validator.ts`,
`src/routes/openapi.ts`. Frontend `JobDrawer.jsx`, `useJobQueue.js`.

- [ ] **Failing tests.** `"queue - jobs start in order"`,
      `"queue - move up
      swaps with the job ahead"`,
      `"queue - the first job can't move up"`,
      `"queue - a removed job never takes a slot"`,
      `"jobs - cancelling a
      queued download reports it at once"`,
      `"jobs - moving a running job
      is not allowed"`. Frontend:
      `"queued rows have up and down buttons"`,
      `"the first row's up button is disabled"`.
- [ ] **Implement**, then `deno task gen:api`.

### Task 2: Resume goes to the front (finding 3)

- [ ] `resumeDownload` calls `enqueue(id, { front: true })`. Test:
      `"jobs - a resumed download starts before queued ones"`.

### Task 3: Pause waits for the process (findings 6, 7)

- [ ] Keep a per-URL "retiring" promise, as listings do, and make a resume wait
      on it. Count paused jobs in the duplicate check, answering the second
      request with "that video is paused; resume it".

### Task 4: Hold a queued job, and pause all (finding 4)

- [ ] `pause` on a queued job holds it in place. Add Pause all and Resume all to
      the drawer's header.

### Task 5: Survive a restart (findings 2, 8)

- [ ] Write queued and paused jobs to Valkey on every change. On boot, load them
      back **as paused**, so nothing starts downloading by surprise after a
      deploy. Drop a paused job after 14 days, and delete its partial files.

**Suggested order:** 1, 2, 3, then 4 and 5 if wanted. Task 1 is the one the
owner asked for; 2 and 3 are small and ride on it.
