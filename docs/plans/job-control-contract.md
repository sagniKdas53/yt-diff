# Job control contract

What the download manager talks to. The backend (`yt-diff`) and the frontend
(`yt-diff-react`) are built against this file; if either side drifts, this is
what is wrong.

## The model

A **job** is one download or one playlist listing the server is running or has
accepted. Jobs have three states:

| State | Meaning | A yt-dlp process? |
| :-- | :-- | :-- |
| `queued` | accepted, waiting for a slot | no |
| `running` | holding a slot and working | yes |
| `paused` | stopped on request, resumable | no |

Three actions, and nothing else:

| Action | Queued | Running | Paused |
| :-- | :-- | :-- | :-- |
| `pause` | rejected — nothing to pause | SIGTERM, **partial files kept** | rejected — already paused |
| `resume` | rejected — not paused | rejected — already running | re-enqueued as the same job id |
| `cancel` | dropped, **nothing to delete** | SIGTERM, **partial files deleted** | partial files deleted, job forgotten |

The distinction the whole design turns on: **pausing keeps the bytes,
cancelling throws them away.** yt-dlp resumes from a `.part` file with no
extra flags, so a pause costs one re-run and a resume costs nothing but time.
A cancel is the user saying "I don't want this", and leaving half a video on
disk would be the one outcome they did not ask for.

A queued job has no process and no bytes, so cancelling it is free — that is
what "cancel at no cost" means, and it is why a queued re-index can be
cancelled without ceremony.

## `POST /queuestatus`

Existing endpoint. Its `queue` key stays the download array (the E2E suite
asserts on it); each entry is now a full job view. `listings` is new.

```jsonc
{
  "status": "success",
  "generation": 3,
  "queue": [ /* JobView */ ],
  "listings": [ /* JobView */ ]
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
{ id: string; action: "pause" | "resume" | "cancel" }
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

`not-allowed` is a normal answer, not an error: the UI offers pause only on a
running job, so reaching it means the poll was stale. The HTTP status stays
200 so a client that shows the sentence needs no error branch.

`partialDeleted` is the honest report of what was on disk:

| Situation | `partialDeleted` |
| :-- | :-- |
| cancel while `queued` | `false` — there was nothing to delete |
| cancel while `running` | `true` |
| cancel while `running`, the file name was never printed | `false`, and `detail` says the partial could not be located |
| cancel while `paused` | `true` — these are the bytes pausing kept |
| pause | `false` — that is the point of pausing |
| resume | `null` |

## Partial files

yt-dlp writes `<fileName>.part` while a transfer runs, keeps `<fileName>.ytdl`
beside it for resume, and names fragments `<fileName>.part-FragN`. The server
already parses `fileName:` out of yt-dlp's `before_dl:` output, so a cancel
deletes exactly those three shapes for that one job:

```
<savePath>/<fileName>.part
<savePath>/<fileName>.part-Frag*
<savePath>/<fileName>.ytdl
```

Never a wider glob. Two downloads can share a save directory, and "delete
everything under the folder that looks partial" would take out a neighbour.

If `fileName` has not arrived when the cancel lands, nothing is deleted and
the response says so. Guessing at partials by directory scan is worse than
leaving bytes the reaper will clean up.

## Listings

A listing writes no files — it streams JSON from stdout into the database and
persists each chunk as it goes. So for a listing:

- pausing keeps everything already indexed, which is the partial index
- resuming re-runs the listing from the top; rows already present dedupe
- cancelling leaves nothing on disk, so `partialDeleted` is always `false`

`itemsIndexed` is a real counter of rows persisted by the run, not an estimate.

## Progress

`src/handlers/pipeline/types.ts` carries one progress template:

```
download-title:%(info.id)s-%(progress.eta)s
```

Nothing parses that line today, so it is extended rather than replaced — one
template, one line per update:

```
download-title:%(info.id)s-%(progress.eta)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s
```

Every added field is an **integer** on purpose. The existing percent scraper
(`/(\d{1,3}\.\d)/`) matches any decimal in the line, and a speed like `1.50`
would be read as 1.5% progress.

`total_bytes` is 0 or NA when the source does not know, in which case
`totalBytes` is the estimate, and null when neither is available.

## Polling

The drawer polls `/queuestatus` rather than taking new socket events:

- drawer open: every **2000 ms**
- drawer closed, badge only: every **10000 ms**
- tab hidden: no polling at all (`document.hidden`)
- immediately after any `/jobaction`

A long-lived 1 s poll would spend a request per second per user forever for a
badge that changes slowly. `document.hidden` matters because a background tab
is the normal state of a tab that is not being watched.