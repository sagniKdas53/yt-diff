# Security and Code Quality Audit

Full-tree audit of the backend and the `frontend` submodule, run with the
[Thermos](https://github.com/cursor/plugins/tree/main/thermos) plugin's two
review rubrics — `thermo-nuclear-review` (correctness and security) and
`thermo-nuclear-code-quality-review` (maintainability and structure).

| | |
| :--- | :--- |
| **Scope** | `master` @ `3a06590`, `frontend` @ `bc22d7b` |
| **Surface** | ~26.4k lines — 16.7k backend TypeScript, 9.7k frontend JSX |
| **Date** | 2026-08-21 |

> [!NOTE]
> Thermos is written for diff-scoped branch review — both rubrics say to report
> only what a PR adds or modifies. There was no diff here, so both passes were
> re-scoped to audit the full tree, and the "read the PR discussion with `gh`"
> step was dropped. Every other rule was applied as written, including the
> over-reporting discipline that governs the severities below.

Findings marked **Verified** were independently re-traced end-to-end against
the source after the review passes reported them.

Line references are valid at the commits above. `master` has advanced since the
snapshot — where a finding has been addressed in the meantime, the status table
says so.

## Status

| ID | Finding | Severity | Status |
| :--- | :--- | :--- | :--- |
| C1 | Argument injection into `yt-dlp` via `POST /list` | Critical | **Fixed** — with Q7 |
| S1 | Action rate limiting ships disabled | Medium | **Fixed** |
| S2 | Rate limiter keys on the socket peer | Medium | Partly fixed with S1 |
| S3 | Deletion paths skip the containment check | Medium | Open |
| S4–S9 | Assorted low-severity items | Low | Open |
| Q1 | Frontend context layer built then bypassed | Blocker | Open |
| Q2 | Two divergent URL canonicalizers | Blocker | Open |
| Q3 | Documented tracking-param stripping never implemented | Correctness | Open |
| Q4 | Failure classification by error-string equality | Correctness | Open |
| Q5 | CI gates none of the quality signals | Blocker | Partly fixed |
| Q6 | No shared API contract | Structural | Open |
| Q7 | Validation schemas are optional-everything | Structural | **Fixed** — with C1 |
| Q8 | Non-atomic triple write in the ingest path | Structural | Open |
| Q9 | Duplication with a canonical answer already present | Structural | Open |
| Q10 | Files past the 1k-line bar | Structural | Open |

**C1 and Q7 were deliberately paired and fixed in one PR.** They are the same
boundary reached from two directions — see
[Where the two passes converge](#where-the-two-passes-converge) — and fixing
either alone would have left the other half of the hole open.

---

## Correctness and Security

### C1 — Argument injection into `yt-dlp` via `POST /list`

**Critical · Verified · Fixed, paired with Q7**

Every element of `urlList` reaches the `yt-dlp` argv as a positional argument
with no `--` separator anywhere in the tree, so any element starting with `-` is
parsed as an *option* rather than a URL.

The full path:

- `src/middleware/validator.ts:34` — `urlList: z.array(z.string()).optional()`.
  No `.url()`, no scheme check.
- `src/handlers/pipeline/process-manager.ts:149` — `normalizeUrl` returns the
  input **unchanged** when `new URL()` throws. A string like
  `--config-location=…` never parses, so it passes through untouched.
- `src/handlers/pipeline/listing.ts:201-202` — not found in the database, so it
  is pushed to `itemsToList` as `type: "undetermined"`.
- `src/handlers/pipeline/listing.ts:1059-1065` —
  `processArgs = ["--playlist-start", n, "--dump-json", "--no-download", videoUrl]`.
- `index.ts:192-197` —
  `new Deno.Command("python3", { args: ["-c", YT_DLP_PATCHED_CMD, ...args] })`,
  straight into `yt_dlp.main()`.

The same missing separator applies at `listing.ts:1503` (`addPlaylist`) and
`download.ts:308` (`["-P", "home:" + savePath, videoUrl]`).

**Reachability.** `/list` sits behind `authenticateRequest`, but registration is
open by default — `src/config.ts:321` reads `ALLOW_REGISTRATION !== "false"` and
`envs/base.env` ships `true`.

**Impact.** The container runs `deno run --allow-all` (`Dockerfile:145`) with no
Deno permission sandbox, and with the secret key, database password, cookies and
proxy credentials mounted. Arbitrary flag injection is immediate. The review
pass additionally reports reaching self-contained execution via
`--config-location` pointed at a file planted through the app's own download
pipeline, since one `urlList` element yields one process and `--exec` alone has
no URL to fire on.

**Fix — both layers, not one.** Both shipped together:

- `looksLikeUrl` moved out of `src/bot/commands.ts` into `src/utils/url.ts`,
  which is now the one place URL admissibility is decided for both paths.
- `urlList` on `/list` and `/download` is `z.array(HttpUrlSchema)`, a schema
  that **parses rather than validates**: `toHttpUrl` returns a serialized
  `http(s)` URL or nothing. The invariant it establishes is about the output,
  not the input — every value that leaves the boundary begins with a scheme,
  so nothing downstream can read it as an option.
- All three argv builders go through `appendUrlArg`, which appends the URL
  behind a literal `"--"`. `--` closes yt-dlp's option parsing, so a URL that
  already sits in the database from before this fix still cannot become a flag.

The second layer matters on its own: the scheduled updater and the download
path read URLs from the database, not from the request, so the schema alone
would not have covered a row poisoned by an earlier exploit.

**What stays accepted.** Scheme-less input is normalized rather than refused —
`youtube.com/watch?v=…` is how people paste URLs, and yt-dlp accepts it across
its ~2,500 supported sites. Host-and-port forms (`example.com:8443/v`),
IP literals, IPv6 brackets and internationalized domains all survive; the
`bot/commands.ts` path deliberately keeps the stricter `isHttpUrl`, because in
a chat stream a bare word has to stay chatter rather than become a submission.

**What stays rejected.** Anything beginning with `-`, any other scheme
(`file:`, `data:`, `javascript:`), text that is not a URL at all, and yt-dlp's
own non-URL prefix forms — `ytsearch:`, `scsearch:`, `:ytfav`, `:ytsubs`,
`:ythistory` and the roughly twenty others. That last exclusion is a choice,
not an oversight: this app keys playlists by URL, and the account-scoped
keywords would spend the operator's cookies on behalf of whoever submitted
them.

---

### S1 — Action rate limiting ships disabled

**Medium · Verified · Fixed**

`envs/base.env` shipped `RATE_LIMIT_ACTION_MAX_REQUESTS=0`, and
`src/middleware/rateLimit.ts` treated `0` as "disabled". The two endpoints
behind the action limiter are `/list` and `/download`, so they were unthrottled
in every stock deployment — including the throttle that would otherwise slow an
attacker probing C1.

This was **not** the already-documented issue.
[`ISSUES_AND_IMPROVEMENTS.md`](./ISSUES_AND_IMPROVEMENTS.md) §4 covered the
*global* limiter and reassured that base.env set it to `10`. That reassurance did
not extend to the action limiter.

Fixing it surfaced two further problems that made the naive fix actively wrong:

- **All limiters shared one Redis key.** `rateLimit` keyed on `ip:<addr>` with no
  scope while being called with two different budgets, so login attempts and
  listing requests drained the same counter. Simply raising the action budget
  would have let `/list` traffic exhaust the auth budget of 10. `/isregallowed`
  runs on every page load and was already spending the login budget.
- **`incr` + conditional `expire` was not atomic.** A process dying between the
  two commands left a key with no TTL, locking that address out until Redis was
  flushed by hand.

And a structural one: `MAX_LISTINGS`/`MAX_DOWNLOADS` already cap concurrency at
1, so the risk a request counter cannot see is not load — it is unbounded queue
depth. One `/list` carrying 200 URLs at `monitoringType: "Full"` cost exactly as
much as one carrying a single URL.

**Fixed by** replacing the fixed-window counter with two tiers of cost-weighted
GCRA. See [Rate limiting](./GETTING_STARTED.md#rate-limiting) for the
configuration and [`ISSUES_AND_IMPROVEMENTS.md`](./ISSUES_AND_IMPROVEMENTS.md)
§4 for the full rationale.

---

### S2 — Rate limiter keys on the socket peer, ignoring `X-Forwarded-For`

**Medium · Partly fixed**

`src/middleware/rateLimit.ts` keyed on `request.socket.remoteAddress`, populated
from `info.remoteAddr.hostname` at `src/transport/denoHttp.ts:240-243`. The
intended deployment terminates TLS at a reverse proxy (`PROTOCOL=https`,
`HIDE_PORTS=true`), where every client presents the proxy's address — so all
users shared one bucket and one noisy client could lock out everyone.

**Partly fixed with S1.** The work tier is now keyed on the authenticated user,
so the expensive endpoints no longer share a budget behind a proxy. The
admission tier still keys on the socket peer, because it runs before
authentication and has nothing else to key on.

**Remaining fix.** Derive the client IP from `X-Forwarded-For` behind a
configurable trusted-proxy setting. Until then, `/login` and `/register` still
share one admission bucket per proxy address.

---

### S3 — Deletion paths skip the containment check the read path performs

**Medium · Open**

`makeSignedUrl` guards correctly — `basename()`, then `join`, `resolve`, and
`isWithinPath` at `src/handlers/files.ts:107-119`. The deletion paths do not:
`src/handlers/videoFiles.ts:46-53` and the recursive
`rm(playListDir, { recursive: true })` at
`src/handlers/playlists/mutations.ts:197-205` build
`join(config.saveLocation, video.saveDirectory ?? "", value)` with no
containment check.

`saveDirectory` derives from `yt-dlp` metadata — `truncateText(playlistTitle, 30)`
at `listing.ts:1655` — and `join` collapses `..` segments.
`--restrict-filenames` is on by default, which is what keeps this from being
exploitable today, so this is defense-in-depth. It is still a real asymmetry:
the read path is hardened and the destructive path is not.

**Fix.** Apply the same `resolve` + `isWithinPath` pair before any `unlink` or
`rm`. The helper already exists.

---

### S4–S9 — Lower-severity items

**Low · Open**

- **No `nosniff`, CSP, or `X-Frame-Options` on any response**
  (`src/utils/http.ts:139-169`). Signed files serve same-origin with
  `Content-Disposition: inline` when `?inline=true`
  (`serveNativeFile.ts:32-35`) and a Content-Type from the extension — a planted
  `.svg` with a minted signed URL would render inline on the app origin.
  Conditional on a plant, cheap to close.
- **JWT in `localStorage`** (`frontend/src/components/App.jsx:159,668`) —
  exfiltratable by any XSS, and the missing CSP above compounds it.
- **Login user enumeration** — `authenticateUser` only runs `bcrypt.compare`
  when the username exists (`src/middleware/auth.ts:397-422`). Add a dummy
  compare on the miss path.
- **Committed proxy credential** — `HTTP_PROXY_PASSWORD` in `envs/base.env`.
  Rotate it and move it under `secrets/`.
- **Hardcoded personal `SAVE_PATH` default** (`src/config.ts:324`) — a host-side
  `deno task dev` silently creates a tree under someone's home directory.
- **`he.escape(token)` on a JWT** (`src/middleware/auth.ts:433`) is a no-op on
  base64url today and a latent trap if the token format changes.

---

## Structure and Maintainability

The code-quality pass returned **not approved**, failing all eight of the
rubric's approval-bar criteria.

### Q1 — The frontend's intended architecture is written, complete, and disconnected

**Blocker · Verified · Open**

`AuthContext`, `SocketContext`, `DownloadContext`, `NotificationContext` and the
`useApi` hook are imported by **nothing outside `contexts/` itself** — the only
cross-references are `useApi.js` importing two of the contexts.
`frontend/src/main.jsx` renders a bare `<App />` with no provider.

`App.jsx` then re-implements all four inline — `token` (`:163`), `socket`
(`:224`), `notifications` (`:191`), the snackbar trio (`:177-179`),
`activeDownloads`/`queuedItems` (`:192,196`) — and drills
`backEnd, token, setToken, setSnack, addNotification` into all five children.
`DownloadContext.jsx` is 144 lines duplicating the queue logic at
`App.jsx:359-590`.

**Fix.** This is deletion, not construction: mount the providers in `main.jsx`
and route the 18 hand-rolled `fetch` calls through the `useApi` that already
exists. Roughly 400 lines leave `App.jsx` before any real refactoring begins.

### Q2 — Two divergent URL canonicalizers, one of which defines the primary key

**Blocker · Verified · Open**

`normalizeUrl` (`process-manager.ts:149`) drives a `SITE_CANONICALIZERS` registry
and is the **write path** — its output *is* the `videoUrl` primary key.
`canonicalizeVideoUrl` (`dedup.ts:63`) is an inline if/else chain over the same
sites and drives the **dedup path**. They disagree:

- `dedup.ts:107-113` *appends* `?s=20` to x.com URLs. `normalizeUrl` does not —
  dedup's canonical x.com form is one ingest will never write.
- `dedup.ts:97-104` implements pornhub and xhamster for real.
  `process-manager.ts:125-132` is a *commented-out placeholder* saying "Add more
  site rules here as needed, e.g. pornhub" — the same knowledge written once as
  code and once as a TODO, in two files.
- `normalizeUrl` handles YouTube `/embed/`; `canonicalizeVideoUrl` does not.

A deduplicator computing a different canonical form than the writer is a
correctness trap with a code-smell cause.

**Fix.** Move `SITE_CANONICALIZERS` and `normalizeUrl` to `src/utils/url.ts`,
fold the pornhub/xhamster/x.com rules into the registry, and have dedup call it.
Deletes `dedup.ts:59-168` and the divergence class outright.

### Q3 — Documented tracking-parameter stripping was never implemented

**Correctness · Verified · Open**

The `normalizeUrl` docstring at `process-manager.ts:141-147` documents four
steps, including *"3. Strips known tracking query parameters (utm_\*, fbclid, si,
pp)"*. The implementation runs 1 → 2 → 4; there is no step 3. Grepping all of
`src/` for those names returns **exactly one hit — the comment itself**.

This is a correctness bug, not doc drift. `SITE_CANONICALIZERS` covers only
youtube, iwara and spankbang, so every other site falls to the generic path,
which preserves all query parameters. Because `normalizeUrl`'s output is the
`videoUrl` primary key, the same video shared with different `?si=` or `utm_*`
values becomes a **distinct row** — a silent dedup failure on exactly the sites
that have no canonicalizer rule.

**Fix.** Implement the documented step. It is the registry's generic fallback and
is what the comment already promises callers.

### Q4 — Failure classification by error-message string equality

**Correctness · Verified · Open**

`listing.ts:785-787` decides whether a listing genuinely failed by comparing
`error.message` against two literals:

```ts
!processSucceeded && error &&
error.message !== "Process exited with code null" &&
error.message !== "Process exited with code 143"
```

The producer at `listing.ts:1158-1163` appends `: ${reason}` whenever stderr had
content. A genuine SIGTERM-with-stderr therefore produces
`"Process exited with code 143: <reason>"`, fails both equality tests, and gets
surfaced to the user as a listing error instead of a cancellation.

The author saw this coming — the comment above the throw reads *"Keeps the
original prefix so anything matching on it still works"* — but the consumer uses
exact `!==`, not `startsWith`. **The mitigation does not work.**

**Fix.**
`class ListingProcessError extends Error { constructor(readonly exitCode: number | null, readonly reason: string) }`,
thrown at `:1160` and branched on by `exitCode` at `:785`.

### Q5 — CI gates none of the quality signals the repo already has

**Blocker · Verified · Partly fixed**

At `master` @ `3a06590`, nothing across the three workflows referenced
`deno task test:unit`, `check`, `lint`, `npm test`, or `npm run lint`.
`run-tests.yml` ran only the containerized E2E suite, leaving 17 backend unit
test files, 13 frontend vitest files, the type-checker and both linters
advisory. `deno.json` additionally scoped `check`/`lint`/`fmt` to
`index.ts src/`, so `scripts/` (1,318 lines) and `tests/` were never
type-checked even locally.

**Partly fixed on `master` since the audit snapshot.** `run-tests.yml` now has a
Unit Tests job, and `deno.json` widens the `check`/`lint`/`fmt` globs to
`index.ts src/ tests/`. Still outstanding: the frontend vitest suite and
`npm run lint` are not run by CI, and `scripts/` remains outside the globs.

### Q6 — No shared API contract

**Structural · Open**

**Backend:** each endpoint is described in three places — path and auth in
`src/routes/api.ts`, schema 200 lines away in `index.ts:756-812`, and handler via
a 20-field `ApiRouteDependencies` interface destructured twice. Response shapes
are hand-built at **79 `writeHead` call sites** with no `json()` helper.

**Frontend:** 18 hand-rolled `fetch` calls, each restating method, `Accept`,
`Content-Type`, `Authorization`, `mode: "cors"`, `JSON.stringify`,
`response.ok` and its own 401 handling.

The leak shows through: `SubList.jsx:585,633-655` reads
`item.video_metadatum.videoUrl` — a Sequelize association name reaching JSX
untyped and undocumented.

**Fix.** One record per endpoint (`{ method, path, schema, handler, auth, rateLimit }`)
that `api.ts` maps over, plus `json(res, status, body)` in `src/utils/http.ts`.
On the frontend, one `api/client.js` normalizing each response once.

### Q7 — Validation schemas are optional-everything

**Structural · Fixed, paired with C1**

`validator.ts:33-38` marks `urlList` optional on `/list` — and
`listing.ts:182-184` then throws `"URL list is required"` at runtime. `:45-48`
makes both `url` and `watch` optional on `/watch`. The schema declares "anything
goes", the handler re-checks by hand, and the type system learns nothing.

**This is the same boundary C1 walks through.** The security and quality passes
reached it from opposite directions.

**Fix.** Required fields are required now — on `/list`, `/download`, `/watch`,
both delete endpoints and the four signed-file endpoints — and the hand-written
request interfaces were narrowed to match, so a dozen downstream
presence-guards deleted themselves. C1's scheme refinement landed on the same
schemas.

Two boundary behaviours changed as a result, both at endpoints that already
rejected the input, only later and with a different message:

- A `/makesignedurls` entry with no `fileName` used to be skipped silently;
  the whole request is now a 400, matching the single-file endpoint. The name
  rule itself stayed deliberately permissive — spaces, unicode, emoji,
  multi-dot extensions, a leading dot and no extension at all are all names
  yt-dlp writes, and all still resolve. It gained only what cannot name a file
  here: control characters, and the `.`/`..` segment references, which
  `basename` preserves and which resolved to a *directory* inside the save
  root rather than failing.
- Fields that handlers rejected by hand now fail in `validateBody`, so the
  response body is the generic `Invalid payload` shape rather than a
  per-field message.

### Q8 — Non-atomic triple write and raw interpolated SQL in the hot ingest path

**Structural · Open**

`listing.ts:1410-1418` builds an
`UPDATE … SET "positionInPlaylist" = CASE WHEN "id" = '<uuid>' THEN <n> … END`
by string concatenation, bypassing the ORM. Values are UUIDs and integers from
prior database rows rather than user input, so this is **not** an injection
finding — but structurally it is the one place the ORM is abandoned.

The real problem is that the three writes at `:1385` (videos), `:1404` (new
mappings) and `:1417` (position updates) run in **no transaction**. A failure
between them leaves videos upserted with mappings missing, or positions
half-shifted — and this runs once per chunk, per playlist, on every scheduled
update.

**Fix.** Wrap all three in `sequelize.transaction()` and replace the CASE
statement with
`bulkCreate(rows, { updateOnDuplicate: ["positionInPlaylist"], transaction })`.

### Q9 — Duplication that the tree already has a canonical answer for

**Structural · Open**

- **Five host-matchers, one already canonical.** `isSiteXDotCom` exists
  *verbatim twice* — `index.ts:293-307` and `process-manager.ts:218-230` —
  alongside `isSiteIwaraDotTv`, `isSiteYouTube` and `hasEphemeralThumbnails`.
  The canonical helper `isHostOrSubdomain` already exists at `dedup.ts:59`; two
  functions below it, `canonicalizePlaylistUrl` ignores it and declares a *third*
  inline copy.
- **Two copies of one listing algorithm.** `handlePlaylistStreaming`
  (`listing.ts:613-799`) and `handlePlaylistViaApi` (`:801-948`) are
  line-for-line duplicates apart from where chunks come from. A
  `PlaylistChunkSource` async-iterable plus two ~40-line adapters collapses ~150
  lines and one whole parallel flow.
- **Three hand-rolled copies of "drive a `yt-dlp` subprocess."**
  `listing.ts:1048`, `:1497` and `download.ts:304`. The `addPlaylist` instance
  wraps three detached IIFEs in a `new Promise` where one writes
  `firstValidLine` and another reads it — a race held together by yt-dlp's flush
  timing.
- **The process-status mutation, copy-pasted eight times**, each copy mutating an
  entry it already holds by reference and *then* calling `map.set(key, entry)` —
  a no-op, replicated eight times.

### Q10 — Files past the 1k-line bar

**Structural · Open**

| File | Lines | What is actually wrong |
| :--- | ---: | :--- |
| `src/handlers/pipeline/listing.ts` | 1,684 | One function, `createListingFlow`, holding 20 nested functions over four pieces of mutable closure state. Nothing can be imported or tested in isolation. |
| `frontend/src/components/App.jsx` | 1,478 | 24 `useState`, 16 `useRef` mirrors, and one **469-line `useEffect`** registering 17 socket handlers with a hand-maintained parallel `.off` block. |
| `frontend/src/components/VideoPlayer.jsx` | 1,355 | Signed-URL fetching, playback state, fullscreen chrome and drawer navigation in one component — while `useSignedUrlRefresh.js` sits unused. |
| `frontend/src/components/SubList.jsx` | 1,124 | 8 effects, two of them storing derived state that `useMemo` would compute. |
| `scripts/scratch_*.ts` | 1,318 | Referenced by no task, doc or Makefile target, outside every lint/check glob, and importing production DB models to mutate the database. |

The `listing.ts` split is mostly a *consequence* of Q2, Q4 and Q9 rather than
extra work: once the `sortOrder` counter moves into the database,
`createListingFlow` has nothing left to close over and the factory becomes plain
exported functions.

---

## Where the two passes converge

The two review passes ran in parallel with no knowledge of each other.
Weighting their overlaps is the highest-signal output of the audit.

### The security bug and the design flaw are the same finding

The quality pass flagged **Q7** — the schemas are optional-everything, so
handlers re-check by hand and the type system learns nothing — purely as a
boundary-hygiene problem. The security pass reached that identical boundary from
the other side and found **C1**: it is the reason unvalidated strings reach
`yt-dlp`'s argv.

Two reviewers, two rubrics, one line of code. That convergence is why C1 is
rated Critical rather than High, and why the two were fixed together in one PR
rather than separately.

### One failure mode, repeated

Every major finding is an instance of the same pattern: **a correct abstraction
exists in the tree, and the path that actually runs goes around it.**

| Canonical thing that exists | What bypasses it |
| :--- | :--- |
| `isHttpUrl` (`utils/url.ts`, hoisted out of `bot/commands.ts`) | ~~the HTTP `/list` path~~ → **C1**, fixed |
| `isWithinPath` (`files.ts:107`) | the file deletion path (`videoFiles.ts:46`) → **S3** |
| Four context providers + `useApi` | `main.jsx` renders around them → **Q1** |
| `SITE_CANONICALIZERS` registry | `dedup.ts:63` re-implements it, disagreeing → **Q2** |
| `isHostOrSubdomain` (`dedup.ts:59`) | four more copies, one two functions below it → **Q9** |

The design instincts are good — the registry pattern, the context split, the
semaphore, dependency injection in `resolveBotConfig`, and strong comment
quality throughout. The failure is narrow and consistent: good abstractions get
built, the next feature lands beside them instead of inside them, and the bypass
becomes the load-bearing path. **Most of the remedy is finishing what is already
in the tree.**

### Why nothing caught any of this

Against `src/handlers/pipeline/**` — 4,156 lines carrying essentially all the
domain logic — the test suite has `dedup.test.ts` (75 lines) and
`process_manager.test.ts` (64 lines). There is no test at any level of
`executeListing`, `processStreamingVideoInformation`, `handlePlaylistStreaming`,
or `executeDownload`.

That cuts both ways. Nothing is coupled to the internals these fixes would
change, so the decomposition is unobstructed — but nothing catches a regression
either.

---

## Verified as correctly handled

Reported for calibration — these were specifically checked and found sound,
which is what makes the findings above meaningful.

- **SQL injection** — all data access is parameterized Sequelize `Op.*`
  bindings; the only `sequelize.query` calls are static DDL.
- **Path traversal in signed-URL minting** — `basename` + `resolve` +
  `isWithinPath`, with a `^[^\\/]+$` schema regex behind it.
- **Signed file IDs** — `crypto.randomUUID()`, stored server-side in Redis; the
  serve path takes only the opaque id, never a user path.
- **Range requests** — bounds-validated, correct 416 on violation.
- **The bot is not an injection vector** — `looksLikeUrl` restricts to
  http/https; fails closed on empty allowlist or missing token.
- **Startup fails closed on secrets** — missing `SECRET_KEY` or `DB_PASSWORD`
  throws before serving.
- **JWT and session handling** — HS256 with a symmetric secret, password-change
  invalidation on both HTTP and socket paths, socket re-verification on a TTL
  cadence.
- **Container hardening** — runs as non-root `ytdiff`; the static-asset map is
  prototype-pollution-safe.
- **CORS** — single-origin allowlist echoed only on exact match, with
  `Vary: Origin`. Request bodies capped at 1 MB.

---

## Suggested fix order

Sequenced so each step makes the next cheaper, not by severity alone.

1. ~~**C1 + Q7 together** — the `--` separator in all three argv builders, plus
   required fields and an http/https refinement at the schema boundary.~~
   **Done**, as a shared `isHttpUrl` predicate, `appendUrlArg` on every argv
   builder, and required fields across nine request schemas.
2. ~~**S1** — ship a non-zero action budget.~~ **Done**, as cost-weighted GCRA
   with per-user work accounting.
3. **Q5** — finish the CI gate: add the frontend suite and `npm run lint`, and
   bring `scripts/` under the globs.
4. **Q1** — mount the providers in `main.jsx` and route the 18 `fetch` calls
   through `useApi`. Deletion rather than construction.
5. **Q2 + Q3** — unify the canonicalizers and implement the documented
   tracking-parameter strip. Not cleanliness: the dedup path currently computes
   canonical forms the ingest path will never produce.
6. **Q4, Q8, then Q10** — typed process errors, a transaction around the triple
   write, and the decomposition, which by then is mostly a consequence of the
   steps above.
