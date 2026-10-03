# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of the codebase.

For the full-tree audit that produced the current security and structural
findings — including severities, evidence, and the suggested fix order — see
[`SECURITY_AND_QUALITY_AUDIT.md`](./SECURITY_AND_QUALITY_AUDIT.md).

*Note: Following recent extensive refactoring phases, major architecture, routing, rate-limiting, and input validation issues have been successfully addressed. The remaining items represent long-term goals.*

## Future Milestones

### 1. Hardcoded Process Operations

Raw array pushes like `downloadOptions.push('--trim-filenames')` are fine currently, but can become unruly over time if the scope of `yt-dlp` arguments grows dynamically per-video rather than globally. Consider abstracting `yt-dlp` argument generation into a more flexible builder pattern or isolated configuration mapper.

### 2. Active Monkey Patches

The codebase contains one active workaround for an upstream bug. See [`MONKEY_PATCHES.md`](./MONKEY_PATCHES.md) for full details, implementation snippets, and removal conditions.

- **`curl_cffi` Segfault** (`index.ts`) — `curl_cffi.Curl.reset` is patched to a no-op at runtime via `python3 -c` to prevent `SIGABRT` crashes when `--impersonate` is used. Remove once `curl_cffi` fixes `Curl.reset` safety upstream.

### 3. Large JSONB Payload Storage

The `raw_metadata` column on `VideoMetadata` currently stores heavily nested JSONB structures. While bulky arrays (formats/thumbnails) are pruned, accumulating this across thousands of videos might bloat PostgreSQL storage unnecessarily if the fields are never queried.

- **Suggested Improvement**: Periodically review whether `raw_metadata` is actively utilized. If not, consider extracting only specific metadata keys explicitly rather than a catch-all JSON dump, or offload this archival data to file-based cache.

### 4. Playlist Indexing Pipe Buffer Deadlock (resolved)

Probing playlist titles via `addPlaylist` (`playlist-records.ts`) read only the first stdout line and awaited `.status` without draining or killing the `yt-dlp` subprocess. When subsequent videos outputted additional JSON metadata, the Linux 64 KB pipe buffer saturated and deadlocked the process, freezing both `ListingSemaphore` and Telegram polling. See [`RCA_PLAYLIST_INDEXING_DEADLOCK.md`](./RCA_PLAYLIST_INDEXING_DEADLOCK.md) for full root cause analysis, empirical reproduction, and suggested remediation.

- **Resolved on 2026-09-04**: `streamTextChunks` now cancels its reader when a consumer stops early (`src/utils/streams.ts`), the title probe kills itself and enforces a `TITLE_PROBE_TIMEOUT` deadline, bot messages are handled off the polling loop by `src/bot/dispatcher.ts`, and `cleanupStaleProcesses` reaps every non-terminal status rather than only `"running"`. See section 6 of the RCA.

---

### 5. Rate Limiting Defaults to Off When Unset (resolved)

Rate limiting used to default to off. `config.cache.reqPerIP` was built as
`parseInt(Deno.env.get("RATE_LIMIT_GLOBAL_MAX_REQUESTS") ?? "0", 10)` and
`rateLimit` treated `0` as "disabled", so an instance that never set the
variable had no throttling at all. `envs/base.env` set the *global* limit to
`10`, but shipped `RATE_LIMIT_ACTION_MAX_REQUESTS=0` — meaning the limiter in
front of `/list` and `/download` was off in every stock deployment.

Two further problems surfaced while fixing it:

- **All limiters shared one Redis key.** `rateLimit` keyed on `ip:<addr>` with
  no scope while being called with two different budgets, so login attempts and
  listing requests drained the same counter and whichever limit was lowest
  silently governed both. `/isregallowed` runs on every page load and spent the
  login budget.
- **`incr` + conditional `expire` was not atomic.** A process that died between
  the two commands left a key with no TTL, locking that address out until Redis
  was flushed by hand.

All three are fixed. Throttling now runs in two tiers:

- **Admission** (`auth`, `public`, `action` buckets) runs before authentication,
  keyed per client address, counting requests. It stops unauthenticated floods.
- **Work** runs after the body is parsed and the user is verified, charging in
  units of queued work rather than requests, keyed per user.

The work tier is the one that matters here. `MAX_LISTINGS`/`MAX_DOWNLOADS`
already cap concurrency at 1, so the risk a request counter cannot see is not
load — it is unbounded queue depth. A single `/list` carrying 200 URLs with
`monitoringType: "Full"` is now priced as 200 full playlist re-scans instead of
as one request.

The algorithm is GCRA (the approach behind `redis-cell` and `throttled`): one
timestamp per key, budget that refills smoothly instead of resetting on a
window edge, per-request cost as a first-class input, and a single atomic Lua
call. Rejections carry `Retry-After`.

Defaults are set well above realistic interactive use and above what the E2E
suite generates. `0` remains an explicit opt-out, but it is no longer what an
operator gets by omitting a variable. See `docs/GETTING_STARTED.md` for the
full variable list and weights.

---

### 6. Root `package.json` Removed (resolved)

The repository root used to carry a `package.json` containing literally `{}`
plus an empty `package-lock.json`, while `deno.json` held the real dependency
graph. `.github/dependabot.yml` pointed its `npm` ecosystem at that root, so
Dependabot mis-detected the project as npm-with-no-dependencies.

Both files were unused — nothing in `Dockerfile`, `Dockerfile.alpine` or CI
referenced them (the `npm install` in the Docker build runs inside
`frontend_src/`, against the frontend submodule's own real manifest), and Deno
does not recreate them. They have been deleted and the Dependabot `npm` block
replaced with `gitsubmodule`.

> [!NOTE]
> Deno dependencies in `deno.json` / `deno.lock` are **not** a Dependabot-
> supported ecosystem, so backend dependency bumps remain manual. Use
> `deno outdated` to review them.

---

### 7. Comments — declined, not deferred

**Decision: the comments feature is not being built. `SAVE_COMMENTS` stays off
by default and no comments UI will be added.**

Two reasons, neither of which is a missing-effort problem:

- **It is a paging and virtualisation project, not a dialog.** The reference
  video in the backlog has 3,562 comments; long-tail videos have tens of
  thousands. Rendering that in the player means server-side paging by
  `parent`, incremental loading, and windowed rendering — a project in its own
  right, competing with the player work that actually closes the gap against
  YouTube.
- **`--write-comments` is where rate limits bite first.** yt-dlp pages through
  every comment thread before the run finishes, which adds minutes per video
  and multiplies the request count exactly where YouTube is already throttling
  sidecars. A deployment that turned it on would trade a video that always
  downloads for one that sometimes does not.

The one bug in this area is fixed regardless: `discoverFiles` looked for
`<base>.info.json`, but the download options only passed `--write-comments`,
which puts comments *inside* the infojson without writing it — so
`commentsFile` could never be found and nothing noticed. `--write-info-json`,
`--no-write-playlist-metafiles` and a bounded `youtube:max_comments` now come
with it, and `commentsFile` is in the `/getsub` row so a deployment that does
opt in can see what landed.

If this is ever revisited, the only shape that works is a
`/comments?videoUrl&offset&limit&sort=likes` endpoint that parses the infojson
once (cached against the file's mtime), returns top-level comments only, and
loads replies on demand. The infojson must never be shipped to the browser.

---
*Last updated at: 2026-10-03*
