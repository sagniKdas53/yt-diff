# Job control contract

What the download manager talks to. The backend (`yt-diff`) and the frontend
(`yt-diff-react`) are built against this file; if either side drifts, this is
what is wrong.

## The model

A **job** is one download or one playlist listing the server is running or has
accepted. Jobs have three states:

| State     | Meaning                       | A yt-dlp process? |
| :-------- | :---------------------------- | :---------------- |
| `queued`  | accepted, waiting for a slot  | no                |
| `running` | holding a slot and working    | yes               |
| `paused`  | stopped on request, resumable | no                |

Three actions, and nothing else:

| Action   | Queued                         | Running                            | Paused                               |
| :------- | :----------------------------- | :--------------------------------- | :----------------------------------- |
| `pause`  | rejected — nothing to pause    | SIGTERM, **partial files kept**    | rejected — already paused            |
| `resume` | rejected — not paused          | rejected — already running         | re-enqueued as the same job id       |
| `cancel` | dropped, **nothing to delete** | SIGTERM, **partial files deleted** | partial files deleted, job forgotten |

The distinction the whole design turns on: **pausing keeps the bytes, cancelling
throws them away.** yt-dlp resumes from a `.part` file with no extra flags, so a
pause costs one re-run and a resume costs nothing but time. A cancel is the user
saying "I don't want this", and leaving half a video on disk would be the one
outcome they did not ask for.

A queued job has no process and no bytes, so cancelling it is free — that is
what "cancel at no cost" means, and it is why a queued re-index can be cancelled
without ceremony.

## `POST /queuestatus`

Existing endpoint. Its `queue` key stays the download array (the E2E suite
asserts on it); each entry is now a full job view. `listings` is new.

```jsonc
{
  "status": "success",
  "generation": 3,
  "queue": [/* JobView */],
  "listings": [/* JobView */]
}
```

### JobView

```ts
interface TransferProgress {
  downloadedBytes: number;
  /** Null when the source never said — a live stream, or nothing yet. */
  totalBytes: number | null;
  bytesPerSecond: number | null;
  /** Null when yt-dlp reported NA. */
  etaSeconds: number | null;
}

interface JobView {
  /** Opaque, stable across queued → running → paused → queued. */
  id: string;
  kind: "download" | "listing";
  url: string;
  title: string;
  state: "queued" | "running" | "paused";
  /** 1-based among jobs of the same kind still waiting. Running jobs: 0. */
  queuePosition: number;
  /** Downloads only; null until the first progress line arrives. */
  progress: TransferProgress | null;
  /** Listings only; rows persisted so far. */
  itemsIndexed: number | null;
  /** When the job was first accepted; epoch ms. */
  startedAt: number;
}
```

Availability is **derived by the client** from `state`, never sent as its own
flag: pausable = `running`, resumable = `paused`, free-cancel = `queued`. A
server-sent `pausable` would be a second thing to keep in step with `state`.

## `POST /jobaction`

New endpoint. Same auth, same body convention as every other endpoint
(`{ token, ... }`).

Request:

```ts
{
  id: string;
  action: "pause" | "resume" | "cancel";
}
```

Response:

```ts
{
  status: "success",
  id: string,
  action: "pause" | "resume" | "cancel",
  outcome:
    | "paused"      // running → stopped, partials kept
    | "resumed"     // paused  → queued under the same id
    | "cancelled"   // gone, for good
    | "not-allowed" // the action does not apply to that state
    | "not-found";  // no such job, or it finished since the last poll
  /** What happened to the partial files. Null when the action did not run. */
  partialDeleted: boolean | null;
  /** One sentence for the user when `outcome` is not the happy path. */
  detail?: string;
}
```

`not-allowed` is a normal answer, not an error, and it means the action would
not have done what the caller asked. Mostly the poll was stale — the UI offers
pause only on a running job. One case is not staleness: a download resume
answers `not-allowed` while another download for the same video is queued or
running, because the pipeline deduplicates by URL and would have discarded the
resumed item silently. The paused job is kept, so the resume can be retried once
the other download finishes. The HTTP status stays 200 so a client that shows
the sentence needs no error branch.

`partialDeleted` is the honest report of what was on disk:

| Situation                                                       | `partialDeleted`                                            |
| :-------------------------------------------------------------- | :---------------------------------------------------------- |
| cancel while `queued`                                           | `false` — there was nothing to delete                       |
| cancel while `running`                                          | `true`                                                      |
| cancel while `running`, the file name was never printed         | `false`, and `detail` says the partial could not be located |
| cancel while `running`, the process would not confirm it exited | `false`, and `detail` says the partial was left in place    |
| cancel while `paused`                                           | `true` — these are the bytes pausing kept                   |
| pause                                                           | `false` — that is the point of pausing                      |
| resume                                                          | `null`                                                      |

## Partial files

yt-dlp writes `<name>.part` while a transfer runs, keeps `<name>.ytdl` beside it
for resume, and names fragments `<name>.part-FragN`. A cancel deletes exactly
those three shapes for that one job, where `<name>` is the output path yt-dlp
printed in its `Destination:` line:

```
<destination>.part
<destination>.part-Frag*
<destination>.ytdl
```

Never a wider glob. Two downloads can share a save directory, and "delete
everything under the folder that looks partial" would take out a neighbour.

**The name comes from `Destination:`, not from `fileName:`.** The server also
parses a `fileName:` out of yt-dlp's `post_process:` output, and that arrives
once the download is _over_ — so scoping a cancel by it meant a cancel of a
running download had nothing to delete by the time it looked. `Destination:` is
printed before the first byte moves.

If neither has arrived when the cancel lands, nothing is deleted and the
response says so. Guessing at partials by directory scan is worse than leaving
bytes the reaper will clean up.

## Listings

A listing writes no files — it streams JSON from stdout into the database and
persists each chunk as it goes. So for a listing:

- pausing keeps everything already indexed, which is the partial index
- resuming re-runs the listing from the top; rows already present dedupe
- cancelling leaves nothing on disk, so `partialDeleted` is always `false`

Resuming a listing is accepted at once but does not start at once. A pause stops
yt-dlp with SIGTERM; the run wrapped around it still has the chunk in flight to
write, so a resume that began immediately would put two runs of one playlist in
the database at once, and both reading an unmapped video can each decide it
needs a mapping. The replacement waits for the old run to settle.

The job is not in the queue yet, but it is not lost either: for the whole time
before its run registers, it reports in `listings` as `queued`, under the same
id, which is what puts a Cancel — and only a Cancel — on it in the drawer.
Reporting it as nothing at all would leave the user watching a row disappear,
with no way to stop what they just started.

That covers two waits, and a cancel has to work through both. First the run it
replaced is still settling — there, the cancel simply finds nothing waiting to
start it. Then the run is queued for a semaphore slot — and there is no entry to
look up, no process to signal, and the run is already under way, so the cancel
leaves a mark that the run itself reads and declines on. Without that second one
the cancel is accepted and the listing begins anyway the moment a slot frees,
which is the user asking for it to stop and it not stopping.

Downloads have neither wait. They carry no per-run database state to collide
with, and a download registers itself before it takes a slot rather than after,
so it is findable from the moment it is accepted.

`itemsIndexed` is a real counter of rows persisted by the run, not an estimate.

## Progress

`src/handlers/pipeline/types.ts` carries one progress template. It is the
`download` type, not `download-title` — yt-dlp accepts both and `download-title`
emits nothing at all for a file transfer, so the template that was there before
was never producing a line and the percent the whole UI reads was coming from
yt-dlp's default output instead. `download` _replaces_ that default, so the
percent has to be carried explicitly:

```
download:%(progress._percent_str)s|%(progress.eta)s|%(progress.downloaded_bytes)d|%(progress.total_bytes)d|%(progress.total_bytes_estimate)s|%(progress.speed)d
```

A real line:

```
12.1%|6|130048|1071444|NA|134937
```

Every counter is `%d`. The percent scraper in the download loop
(`/(\d{1,3}\.\d)/`) takes the first decimal on the line, so a float speed puts
`1163317.2524` in front of it and 7.2% is read as the progress. The one decimal
on the line is the percent, which is what it is there for.

`%(progress.eta)s` renders seconds as a bare integer, not `00:06`. A field that
is `NA` or empty becomes `null` rather than a zero — a zero eta would say
"finishing now" about a transfer that has not started.

One read from the pipe can carry several updates. The parser takes the last
line, because the earlier ones describe a moment the transfer has already left.

## Polling

The drawer polls `/queuestatus` rather than taking new socket events:

- drawer open: every **2000 ms**
- drawer closed, badge only: every **10000 ms**
- tab hidden: no polling at all (`document.hidden`)
- immediately after any `/jobaction`

A long-lived 1 s poll would spend a request per second per user forever for a
badge that changes slowly. `document.hidden` matters because a background tab is
the normal state of a tab that is not being watched.
