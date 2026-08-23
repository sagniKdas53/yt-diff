# Security and Code Quality Audit

Full-tree audit of the backend and the `frontend` submodule, run with the
[Thermos](https://github.com/cursor/plugins/tree/main/thermos) plugin's two
review rubrics — `thermo-nuclear-review` (correctness and security) and
`thermo-nuclear-code-quality-review` (maintainability and structure).

| | |
| :--- | :--- |
| **Scope** | `master` @ `3a06590`, `frontend` @ `bc22d7b` |
| **Surface** | ~26.4k lines — 16.7k backend TypeScript, 9.7k frontend JSX |
| **Date** | 2026-08-21, frontend findings merged in 2026-08-22 |

> [!NOTE]
> Thermos is written for diff-scoped branch review — both rubrics say to report
> only what a PR adds or modifies. There was no diff here, so both passes were
> re-scoped to audit the full tree, and the "read the PR discussion with `gh`"
> step was dropped. Every other rule was applied as written, including the
> over-reporting discipline that governs the severities below.

Findings marked **Verified** were independently re-traced end-to-end against
the source after the review passes reported them.

Line references are valid at the commits above. `master` has advanced well past
the snapshot — where a finding has been addressed in the meantime, the status
table and the finding itself say so, and the [fix order](#suggested-fix-order)
records what each step actually shipped.

> [!NOTE]
> **2026-08-22 — `docs/FRONTEND_IMPROVEMENTS.md` was folded into this document.**
> That was a separate 2026-08-04 review of `frontend/` alone, comparing it
> against a sibling React + MUI app. It has been re-verified against `frontend`
> @ `b4327d4` and merged in as [F1–F10](#frontend-architecture-and-ux); its
> `YD-F*` IDs became `F*`, keeping their numbers. Three of the ten closed in the
> meantime — `F1` is this audit's own `Q1`, and `F8` and `F9` closed as side
> effects of that fix. The source document and its branch are gone; this is now
> the only copy, and the [fix order](#suggested-fix-order) is ranked across both
> sets rather than keeping the frontend on a separate list.

## Status

| ID | Finding | Severity | Status |
| :--- | :--- | :--- | :--- |
| C1 | Argument injection into `yt-dlp` via `POST /list` | Critical | **Fixed** — with Q7 |
| S1 | Action rate limiting ships disabled | Medium | **Fixed** |
| S2 | Rate limiter keys on the socket peer | Medium | **Fixed** |
| S3 | Deletion paths skip the containment check | Medium | **Fixed** |
| S4–S9 | Assorted low-severity items | Low | **Fixed** — with F7 |
| Q1 | Frontend context layer built then bypassed | Blocker | **Fixed** |
| Q2 | Two divergent URL canonicalizers | Blocker | **Fixed** — with Q3 |
| Q3 | Documented tracking-param stripping never implemented | Correctness | **Fixed** — with Q2 |
| Q4 | Failure classification by error-string equality | Correctness | **Fixed** |
| Q5 | CI gates none of the quality signals | Blocker | **Fixed** |
| Q6 | No shared API contract | Structural | **Fixed** |
| Q7 | Validation schemas are optional-everything | Structural | **Fixed** — with C1 |
| Q8 | Non-atomic triple write in the ingest path | Structural | **Fixed** |
| Q9 | Duplication with a canonical answer already present | Structural | **Fixed** |
| Q10 | Files past the 1k-line bar | Structural | **Fixed** |
| F1 | Context providers and `useApi` written but never mounted | High | **Closed** — is Q1 |
| F2 | No error boundary behind five lazy routes | High | **Fixed** |
| F3 | The socket is never closed on the client | High | **Fixed** |
| F4 | `App.jsx` still owns the socket layer | Medium | **Fixed** |
| F5 | No routing: no deep links, no Back button | Medium | Open |
| F6 | No TypeScript, no generated API types | Medium | **Fixed** — was ranked with Q6 |
| F7 | 31-day tokens in `localStorage`, never renewed | Medium | **Fixed** — with S4–S9 |
| F8 | `"null"` as a `localStorage` sentinel | Low | **Fixed** |
| F9 | Thumbnails not lazily loaded | Low | **Fixed** |
| F10 | No test coverage thresholds | Low | **Fixed** |

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

**One migration consideration.** `playlistUrl` is a primary key, and before
this change a scheme-less submission was stored verbatim — `normalizeUrl`
passed unparseable input straight through, and `playlistRegex` matches without
a scheme. Such rows keep working, because the scheduled updater reads them from
the database and yt-dlp accepts them. But re-submitting the same scheme-less
text now normalizes it, so `findOrCreate` inserts a second row alongside the
old one. The existing `/dedup` tooling is the remedy; this is a further
argument for **Q2**, which is about the two canonicalizers disagreeing in
exactly this way.

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

**Partly fixed with S1.** The work tier was keyed on the authenticated user,
so the expensive endpoints no longer shared a budget behind a proxy. The
admission tier still keyed on the socket peer, because it runs before
authentication and has nothing else to key on.

**Fixed.** `src/utils/clientIp.ts` resolves the address the admission tier keys
on. It reads `X-Forwarded-For` only when the socket peer matches
`TRUSTED_PROXIES` — a list of addresses, CIDRs, or the shorthands `loopback`,
`linklocal` and `private` — and walks the chain right to left, stopping at the
first hop that is not itself a trusted proxy.

The direction of the walk is the security property. The rightmost entry is the
one our own proxy appended; anything a client prepends stays to its left and is
never what the walk returns. Unset (the default) means the socket peer is the
client, which is the previous behaviour and the correct one for a
directly-exposed server, so no deployment changes meaning by upgrading.

`/login` and `/register` are the endpoints this was actually for: they never
reach the per-user tier, so the admission bucket is the only place their
clients can be told apart.

---

### S3 — Deletion paths skip the containment check the read path performs

**Medium · Fixed**

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

**Fixed.** `resolveWithin` in `src/utils/path.ts` packages the `resolve` +
`isWithinPath` pair the read path already ran, and all four call sites go
through it — `removeVideoFiles`, the recursive playlist cleanup, and both
signed-URL minting paths. The helper existed; what was missing was a shape that
made it hard to skip.

Writing it surfaced a second problem the read path does not have.
`resolveWithin` counts the root as inside the root — correctly, since that is
what containment means — and an empty `saveDirectory` resolves to exactly that.
`rm(dir, { recursive: true })` on such a row would have taken the entire media
library. The `"None"` pseudo-playlist ships with `saveDirectory: ""`
(`models.ts:543`); it is rejected by name earlier in the handler, but nothing
stopped a real row from holding `""`. Cleanup now refuses anything that is not
*strictly* below the save root, logs why, and reports it in the response
message, leaving the database deletion behaviour unchanged.

---

### S4–S9 — Lower-severity items

**Low · Fixed, paired with F7**

- ~~**No `nosniff`, CSP, or `X-Frame-Options` on any response.**~~ **Done.**
  `generateCorsHeaders` is the one builder all three response paths go through
  — the JSON API, the static-asset server and the native file server — so the
  headers went in there rather than at 71 `writeHead` call sites. Every
  response now carries `nosniff`, `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer`, plus one of two policies: `APP_CSP` for the
  app, or `SIGNED_FILE_CSP` (`default-src 'none'; sandbox`) for anything out of
  the download tree.

  The planted-`.svg` path is closed twice over. `sandbox` puts the response in
  an opaque origin, so a document with script in it cannot reach this origin's
  `localStorage`; and `serveNativeFile` now refuses `inline` outright for the
  five types a browser will execute as a document, so the renderer never sees
  it. Video, audio and image playback still get `inline`, which is what the
  parameter exists for.

  The app policy pins `script-src`, `connect-src` and `form-action` to this
  origin — those are the directives that decide whether injected script can
  post the token somewhere. Two are deliberately looser and are asserted as
  such in `tests/security_headers.test.ts`, so a later tightening pass has to
  notice it is breaking something: `style-src` allows `'unsafe-inline'`
  because MUI injects inline `<style>` at runtime, and `img-src` allows
  `https:` because thumbnails come from whatever site the video came from.
- ~~**JWT in `localStorage`.**~~ **Addressed, not eliminated.** The token is
  still in `localStorage` — moving it to an `HttpOnly` cookie trades XSS
  exposure for CSRF exposure and is a bigger change than this finding
  justifies. What changed is both things that made it worse: the CSP above
  closes the exfiltration path, and `F7` cuts the window a stolen token is
  worth anything from 31 days to one.
- ~~**Login user enumeration.**~~ **Done.** The username-miss path now spends a
  `bcrypt.compare` against a throwaway hash before answering, so a miss costs
  what a hit costs. The hash is generated once at the configured
  `saltRounds` rather than hardcoded — a dummy at a different cost than the
  real ones would reintroduce the difference it exists to remove — and
  `createAuthMiddleware` warms it at startup so the first miss after a restart
  is not the odd one out.
- ~~**Committed proxy credential.**~~ **Removed from the tree**, as
  `secrets/http_proxy_password.txt` handed to gluetun via
  `HTTPPROXY_PASSWORD_SECRETFILE`, mirroring the `openvpn_password` pair
  already there. **It still needs rotating**: it was committed, so it is in the
  history regardless of what the working tree says now.
- ~~**Hardcoded personal `SAVE_PATH` default.**~~ **Done.** `./data/` instead of
  one machine's home directory. The container mounts a volume over `SAVE_PATH`
  anyway, so this only ever governed a host-side `deno task dev`, which is
  exactly the case that was silently writing somewhere nobody would look.
- ~~**`he.escape(token)` on a JWT.**~~ **Done** — deleted. It was a no-op on
  base64url and a corruption bug waiting for the day the token format changed.

---

## Structure and Maintainability

The code-quality pass returned **not approved**, failing all eight of the
rubric's approval-bar criteria.

### Q1 — The frontend's intended architecture is written, complete, and disconnected

**Blocker · Verified · Fixed**

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

**Done.** `main.jsx` renders `AppProviders` (Auth → Notification → Socket →
Download) and `App.jsx` lost 440 lines — the token state, the socket
construction, the snackbar trio, the notification log, the download queue and
the five drilled props. All 18 `fetch` calls go through `apiFetch`, which now
owns the bearer token, the JSON headers and the eight verbatim copies of
"401 → session expired → log out". A new `src/config.js` absorbed the three
copies of the backend-location logic that `App.jsx`, `SocketContext.jsx` and
the `baseUrl` in three components each kept separately.

Two of the providers had to grow to become the real path rather than a
parallel one: `DownloadContext` took over `App`'s more evolved queue logic
along with the `/download` POST and the `/queuestatus` sync, and
`NotificationContext` gained `setSnack` and `addNotification` as separate
calls, because the snackbar and the log routinely carry different text for
the same event.

### Q2 — Two divergent URL canonicalizers, one of which defines the primary key

**Blocker · Verified · Fixed, paired with Q3**

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

**Fixed.** `SITE_CANONICALIZERS` and `normalizeUrl` moved to `src/utils/url.ts`,
alongside the C1 admissibility helpers, and dedup calls `normalizeUrl`.
`canonicalizeVideoUrl` is gone; pornhub, xhamster and x.com are registry
entries.

The x.com rule resolves the disagreement by **stripping** the share params
(`s`, `t`) rather than appending them. Stripping is the only direction that
can converge: dedup's `?s=20` form was one ingest would never write, so
`canonicalizeVideoUrlsInNonePlaylist` — which writes its canonical form back as
`videoUrl` — was rewriting rows towards a spelling the next ingest immediately
diverged from again. The invariant that failure violated is now pinned as a
test: `normalizeUrl` is idempotent on every site it handles.

`canonicalizePlaylistUrl` moved with it and stays a separate function on
purpose — a playlist's identity is the `list=` that `normalizeUrl` throws
away — but now shares the generic https/trailing-slash/tracking steps instead
of restating them.

### Q3 — Documented tracking-parameter stripping was never implemented

**Correctness · Verified · Fixed, paired with Q2**

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

**Fixed.** Step 3 runs, stripping exactly what the docstring named — `utm_*`
by prefix, plus `fbclid`, `si` and `pp` — case-insensitively, before the site
rule, which is the order the `SiteCanonicalizer` contract already documented to
its own implementors. Parameters that merely look similar (`pp_id`, `site`) are
left alone.

Rows written before this keep their old spelling until `/dedup` runs, which is
safe now that dedup groups by the same function ingest writes with — the point
of pairing this with Q2.

### Q4 — Failure classification by error-message string equality

**Correctness · Verified · Fixed**

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

**Fixed** as prescribed. `ListingProcessError` lives beside `ProcessExitCodes`
in `src/handlers/pipeline/types.ts`, carrying `exitCode` and `reason`; the
producer throws it and `isDeliberateTermination` narrows on the type and reads
the code. The message keeps its `Process exited with code <n>[: reason]` shape,
because it is logged and emitted on `listing-error` for the frontend to render
— it just stopped being the thing anything decides on.

### Q5 — CI gates none of the quality signals the repo already has

**Blocker · Verified · Fixed**

At `master` @ `3a06590`, nothing across the three workflows referenced
`deno task test:unit`, `check`, `lint`, `npm test`, or `npm run lint`.
`run-tests.yml` ran only the containerized E2E suite, leaving 17 backend unit
test files, 13 frontend vitest files, the type-checker and both linters
advisory. `deno.json` additionally scoped `check`/`lint`/`fmt` to
`index.ts src/`, so `scripts/` (1,318 lines) and `tests/` were never
type-checked even locally.

**Partly fixed on `master` since the audit snapshot.** `run-tests.yml` gained a
Unit Tests job, and `deno.json` widened the `check`/`lint`/`fmt` globs to
`index.ts src/ tests/`.

**Now closed.** `run-tests.yml` has two more jobs: **Static Checks**
(`deno task check`, `lint`, `fmt:check`, each running even when an earlier one
fails, so one push surfaces every problem) and **Frontend Lint and Unit Tests**
(`npm ci`, `npm run lint`, `vitest run` reported through the same JUnit path as
the other two suites). The globs now include `scripts/`, and a `fmt:check` task
exists so CI can report rather than rewrite.

Turning these on required fixing what they had never been run against, which is
the finding making its own case:

- **`deno task check` did not pass at all.** `import type Redis from "ioredis"`
  resolved to a namespace rather than the class, giving TS2709 at fifteen sites
  across `src/`, `index.ts` and `tests/`. The named import (`import type
  { Redis }`) is what ioredis's `built/index.d.ts` actually exports.
- **`scripts/scratch_canonicalize_db.ts` had never compiled.** It imports a
  `deduplicateAll` that has never existed in `dedup.ts`; being outside every
  glob is precisely what let that stand. It now calls `deduplicateUnlisted` and
  `deduplicatePlaylists`.
- Two `no-explicit-any` hits in `scripts/`.

### Q6 — No shared API contract

**Structural · Fixed**

**Backend:** each endpoint was described in three places — path and auth in
`src/routes/api.ts`, schema 200 lines away in `index.ts:756-812`, and handler via
a 20-field `ApiRouteDependencies` interface destructured twice. Response shapes
were hand-built at **79 `writeHead` call sites** with no `json()` helper.

**Frontend:** 18 hand-rolled `fetch` calls, each restating method, `Accept`,
`Content-Type`, `Authorization`, `mode: "cors"`, `JSON.stringify`,
`response.ok` and its own 401 handling.

The leak showed through: `SubList.jsx:585,633-655` read
`item.video_metadatum.videoUrl` — a Sequelize association name reaching JSX
untyped and undocumented.

**Fixed, both halves.**

`src/routes/endpoints.ts` is one record per endpoint — method, path, handler,
schema, admission tier, work cost, and a line saying what it is for. `api.ts`
maps over it, and one `buildRunner` composes every route in the same order:
admission budget, authentication, work charge, schema, handler. No endpoint
picks its own order any more, and `index.ts` no longer imports a schema at all.

The pairing that used to be checked at each `validateBody` call site is not
lost. `AuthenticatedHandlers` derives every handler's signature from that
endpoint's own schema, so a handler that cannot accept what its schema produces
fails to compile where the handler is supplied.

Putting the records side by side made two things visible that were invisible
spread across two files: `/register` was passing `isRegistrationAllowed` as a
next-handler that could never run, and `/refresh` needed a hand-written adapter
to reach the arity the limiter wanted. Both are gone.

`json(res, status, body)` in `src/utils/http.ts` replaced the `writeHead` +
`end(JSON.stringify(…))` pair at 59 JSON call sites. Seven files stopped
needing `generateCorsHeaders` or a `jsonMimeType` local of their own.

On the frontend, `src/api/client.js` owns the half `apiFetch` never did:
encoding, `response.ok`, and parsing. `api.post()` returns the parsed body or
throws `ApiError`, so the failure path cannot be skipped — the previous shape
let a missing `if (!response.ok)` read an error body as data. `ApiError` also
carries the one thing callers could not work out for themselves,
`sessionExpired`: true only for a 401 that `apiFetch` has already reported and
logged out on. That distinction was open-coded as `if (response.status !== 401)`
at five call sites, right for the expiry case and wrong for a bad password at
`/login`.

**What was still open** — the typed client of
[F6](#f6--no-typescript-no-generated-api-types), now shipped: the response
schemas live beside this file's request records in `openapi.ts`, and the
generated client consumes both.

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

One boundary behaviour changed as a result, at endpoints that already rejected
the input, only later: checks the handlers ran by hand now fail in
`validateBody`, so the response body is the generic `Invalid payload` shape
rather than a per-field message.

The signed-file endpoints needed care rather than a blanket tightening.
`fileName` is required on `/makesignedurl` but stays optional per entry on the
bulk endpoint, which is partial-success by design — its response already
carries a null per entry it could not resolve, and the caller batches one row
per video on screen, including ones it has not downloaded and so cannot name.
The name rules themselves are shared between the two, and stayed deliberately
permissive: spaces, unicode, emoji, multi-dot extensions, a leading dot and no
extension at all are all names yt-dlp writes. They gained only what cannot name
a file here — control characters, and the `.`/`..` segment references.

That last one exposed a separate pre-existing bug. `exists()` is a `Deno.stat`
wrapper, so it is true for **directories**: any bare directory name — `..`, or
simply a playlist folder listed by `/getplay` — minted a signed URL inside the
containment check, and the serve path then sent a `Content-Length` taken from
the directory entry before failing `EISDIR` partway through the body. No string
rule can fix that, since a directory name is a perfectly valid file name; both
minting paths now stat with `isFile`.


### Q8 — Non-atomic triple write and raw interpolated SQL in the hot ingest path

**Structural · Fixed**

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

**Fixed** as prescribed. The three writes moved into `persistStreamingChunk`,
extracted to module scope so the block is reachable from a unit test without
spawning a listing process, and run inside one `sequelize.transaction()`. The
CASE statement is now `bulkCreate` with `conflictAttributes: ["id"]` and
`updateOnDuplicate: ["positionInPlaylist", "updatedAt"]`, which emits
`ON CONFLICT ("id") DO UPDATE` — every row already exists, so all of them take
the update branch, and the untouched columns are carried through to keep the
insert half well-formed.

### Q9 — Duplication that the tree already has a canonical answer for

**Structural · Fixed**

- ~~**Five host-matchers, one already canonical.**~~ **Fixed with Q2.**
  `isSiteXDotCom` existed *verbatim twice* — `index.ts:293-307` and
  `process-manager.ts:218-230` — alongside `isSiteIwaraDotTv`, `isSiteYouTube`
  and `hasEphemeralThumbnails`, while `canonicalizePlaylistUrl` declared a
  *third* inline copy of `isHostOrSubdomain` two functions below the canonical
  one. All of them now live in `src/utils/url.ts` over a single
  `isHostOrSubdomain` and a single `hostnameOf`, which matters beyond line
  count: the copies each decided for themselves whether an unparseable URL
  logged, threw or silently missed, so the same input could match on one path
  and not another. That agreement is now a test.
- ~~**Two copies of one listing algorithm.**~~ **Fixed.**
  `handlePlaylistStreaming` and `handlePlaylistViaApi` were line-for-line
  duplicates apart from where chunks came from. Both now run
  `consumePlaylistChunks` over a `PlaylistChunkSource`, and each states only
  the four things that genuinely differ: the chunk source, what an empty run
  means, what a failure means, and its own progress logging.

  The copies had already drifted, which is what the finding was really about.
  One compared the "everything in this chunk is already known" early stop
  against the *configured* chunk size and the other against the chunk actually
  received — they differ on a trailing partial chunk, so the same playlist
  could stop early on one path and not the other. The driver compares against
  the chunk it was handed. The early stop also marks the process completed now;
  it used to leave the entry at `"running"` until the idle timeout noticed.

  The offset arithmetic came out to `chunkPlaylistLines` in
  `src/handlers/pipeline/chunks.ts`, where it is tested: it writes
  `positionInPlaylist`, so an off-by-one silently renumbers a playlist, and it
  was previously two separate expressions in the full-chunk and trailing-chunk
  branches.
- ~~**Three hand-rolled copies of "drive a `yt-dlp` subprocess."**~~ **Fixed.**
  `createYtDlpLauncher` in `src/handlers/pipeline/ytdlp.ts` is the only place a
  yt-dlp subprocess starts, which is what keeps [C1](#c1--argument-injection-into-yt-dlp-via-post-list)'s
  `--` separator true for the next call site as well as these three. The
  download path's log line also stopped disagreeing with what it ran: it
  rendered its options unquoted, so a save path containing a space logged as a
  command that would not run if pasted.

  `addPlaylist`'s race went with it. It wrapped three detached IIFEs in a
  `new Promise` where the one awaiting the exit status read a variable another
  one wrote — correct only for as long as yt-dlp happened to flush stdout
  before exiting, and silently falling back to a URL-derived title when it did
  not. Both drains and the status are awaited together now.
- ~~**The process-status mutation, copy-pasted eight times**~~ **Fixed**, as
  `setProcessStatus` on the process manager. Each copy mutated an entry it
  already held by reference and *then* called `map.set(key, entry)` — a no-op,
  replicated eight times, reading as though the write were what made the change
  stick. Worse, each copy chose for itself which of the three liveness clocks
  to move, so a status change meant different things depending on which copy
  you were reading. It also returns `false` rather than silently doing nothing
  when the entry is gone, which the two callers that have just spawned a
  subprocess check: for them it means a process nothing will ever reap.

### Q10 — Files past the 1k-line bar

**Structural · Fixed**

| File | Was | Now | What happened |
| :--- | ---: | ---: | :--- |
| `src/handlers/pipeline/listing.ts` | 1,678 | 922 | The factory dissolved. `processStreamingVideoInformation` moved beside `persistStreamingChunk` into [`ingest-chunk.ts`](../src/handlers/pipeline/ingest-chunk.ts) — parse, diff and the Q8 transaction are one unit now; `addPlaylist`/`createPlaylistRecord` moved to [`playlist-records.ts`](../src/handlers/pipeline/playlist-records.ts); the `/list` triage path to [`listing-requests.ts`](../src/handlers/pipeline/listing-requests.ts). |
| `frontend/src/components/App.jsx` | 1,053 | 588 | The 414-line socket effect is a `useSocketEvents` hook, which owns the listing counter, batch-reindex tracker and last-downloaded ref, and registers its eighteen listeners from one table — the hand-maintained parallel `.off` block cannot drift by construction. This was the rest of `F4`. |
| `frontend/src/components/VideoPlayer.jsx` | 1,304 | 891 | Signed-URL minting/refresh/recovery is `useSignedPlayback`, subtitles (fetch, VTT parse, cue selection) are `useSubtitleTrack`, page-crossing prev/next is `usePlaylistNavigation`, and the pure VTT parser sits in `src/lib/subtitles.js`. `useSignedUrlRefresh.js`, which had sat unused through all of this, is deleted. |
| `frontend/src/components/SubList.jsx` | 1,038 | 769 | Thumbnails (bulk fetch + expiry scheduling) are `useThumbnailUrls`; the rows fetch is `useSubListRows`; the delete dialog is its own component. Two of the eight effects were deleted outright: "select all" is derived from the rows on screen rather than mirrored into state, which also closed a stale-true edge when a page change pruned the last checked key away. |
| `scripts/scratch_*.ts` | 1,318 | 0 | Deleted — one-off migration scripts referenced by no task, doc or Makefile target. Git history keeps them. |

**The enabler did ship:** the playlist sort order now comes from
`MAX(sortOrder) + 1`, read inside a serialized create in
`playlist-records.ts`, so `createListingFlow`'s counter, its initialization
promise, the create lock *and* the `resetPendingPlaylistSortCounter`
invalidation hook that deletion had to remember to call are all gone —
reading at write time has nothing to invalidate. What remains of the factory
is pure wiring (`createListingRuntime`) assembling an explicit context object
that every function takes as a parameter; each substantial function below it
is a plain export a test can call without building the pipeline.

The split also made three components small enough for React Compiler's lint
rules to analyze for the first time, which surfaced pre-existing
setState-in-effect patterns; two were genuinely derivable and removed, the
other two carry justifications inline.

---

## Frontend Architecture and UX

Merged in from `docs/FRONTEND_IMPROVEMENTS.md` (written 2026-08-04, IDs `YD-F1`–
`YD-F10`), which compared `frontend/` against a sibling React + MUI app solving
the same shape of problem — an authenticated SPA with live server events, long
media lists and MUI theming. That document lived only on the
`worktree-steady-dancing-crane` branch and has been deleted; everything below is
what survived re-verification against `frontend` @ `b4327d4` on **2026-08-22**.
IDs are shortened to `F1`–`F10` but keep their original numbering.

Three of the ten closed themselves between the two dates — `F1` as this audit's
own `Q1` fix, `F8` and `F9` as side effects of it. What remains is re-verified,
not carried over on trust.

### F1 — Context providers and `useApi` written but never mounted

**High · Closed — this is `Q1`**

Same finding as [Q1](#q1--the-frontends-intended-architecture-is-written-complete-and-disconnected),
reached from the frontend side. `main.jsx` now renders `AppProviders`, and all
18 `fetch` calls go through `apiFetch`. No residue.

### F2 — No error boundary, behind five lazy-loaded routes

**High · Verified · Fixed**

Zero uses of `componentDidCatch` or `getDerivedStateFromError` anywhere in
`frontend/src`. `App.jsx:31-35` lazy-loads `Nav`, `PlayList`, `SubList`, `Login`
and `Signup`; the `Suspense` boundaries at `:821` and `:920` have `fallback` but
no `errorElement` equivalent.

A throw during render unmounts the whole tree, leaving a blank `<div id="root">`
with no message and no recovery but a reload. Lazy routes make this reachable
**without a code bug**: every deploy rehashes the chunk filenames, so a tab left
open across a deploy requests a chunk that no longer exists, the dynamic import
rejects, and React caches that rejection for the life of the tab. To the user it
reads as "the app went blank and I had to log out and back in."

**Fixed** as prescribed. `src/components/ErrorBoundary.jsx` imports React,
PropTypes and one predicate, and styles itself inline. `isChunkLoadError` lives
in `src/lib/chunkLoadError.js` and matches the shapes all three engines produce,
since none of the wording is standardised. A stale chunk reloads once, with the
attempt timestamped in `sessionStorage`: a second failure inside ten seconds is
a broken build rather than a stale tab, and gets the message instead of another
round trip — while a marker from an earlier deploy does not stop a tab catching
up twice. Storage that throws at all (private mode, blocked site data) means the
message and never a blind reload.

It wraps `<App />` outside the providers in `main.jsx`, so a throw while a
context initialises is caught too, and each lazy `Suspense` block is now a
`LazyRegion` — a compact boundary around the `Suspense` — so one unloadable
panel does not take the shell with it.

### F3 — The socket is never closed on the client

**High · Verified · Fixed — and partly a security item**

`SocketContext.jsx:20-27` builds the connection inside a `useMemo` keyed on
`token`, with `forceNew: true`. There is no `disconnect()` or `.close()` call
anywhere in `frontend/src`; the cleanup in `App.jsx`'s socket effect only calls
the 18 `socket.off(...)` handlers.

On logout `setToken(null)` makes the memo return `null` and the old socket
object is simply dropped. Its listeners are gone — but the connection is still
open and still authenticated, and the server has no reason to close it. It dies
only when the expiry timer at `src/socket/index.ts:75-100` fires (up to 31 days
out, see `F7`) or the process restarts. Each login/logout cycle leaks one live
connection, and each leaked connection is a signed-out session still receiving
events.

The `Q1` fix moved this code from `App.jsx` into `SocketContext` without
changing it, so the finding survived the refactor intact.

**Fixed** as prescribed. Creation moved out of `useMemo` into a `useEffect`
keyed on `token`, the cleanup calls `sock.disconnect()`, and the socket is held
in state so consumers re-render when it swaps. The App and batch-reindex suites
stubbed `socket.io-client` with a socket that had no `disconnect`; they now mock
the method the provider calls.

### F4 — `App.jsx` still owns the socket layer

**Medium · Verified · Fixed, bar the split**

Was 1,478 lines with twelve `xRef.current = x` mirror assignments. `Q1` took it
to 1,038 lines and four mirrors (`playListUrl`, `disableProgress`,
`toggleProgressCallBack`, `isMobile` — `:255-265`); the other ten ref writes are
genuine mutable state, not mirrors.

The reason the mirrors existed is **one `useEffect` at `:341`** registering 18
`socket.on` handlers against a hand-maintained parallel block of 18
`socket.off` calls. Handlers registered once need some way to read current
state without re-subscribing, and mirroring into a ref is React 18's manual
answer.

**Fixed.** A `useLatest(value)` hook is that box, named once instead of
open-coded four times. The render-phase write is deliberate and kept — an
effect commits after paint, so a handler firing in the gap would read the
previous value — and that trade is now stated in one place with the single
`react-hooks/refs` suppression it needs, rather than left implicit at four call
sites that happened not to trip the rule.

React 19's `useEffectEvent` still replaces the pattern outright, and is still
the concrete payoff of that upgrade rather than a reason to do it.

**The split shipped with `Q10`**: the effect is now a `useSocketEvents` hook
(see the `App.jsx` row there). The mirrors went with it — the hook takes the
`useLatest` boxes as parameters and owns the batch-reindex mirror itself.

### F5 — No routing: no deep links, no working Back button

**Medium · Verified · Open**

`App.jsx:1007` is the whole navigation model:
`{token === null ? renderAuth() : renderMain()}`. Which view is showing lives in
component state; the URL never changes. `react-router` is not a dependency.

So: no link to a specific playlist, no bookmark, no reopening where you left
off, and the browser Back button exits the app rather than navigating inside it.
On mobile, where Back is the primary gesture, that is the visible cost.

**Fix.** Do it after `F4`. Adding routing to a component that also owns the
socket layer is materially harder than adding it to one that has been split.

### F6 — No TypeScript, no generated API types

**Medium · Verified · Fixed — with `Q6`**

All of `frontend/src` is `.jsx` with `PropTypes`. The backend is already Deno +
TypeScript with typed handlers, so the types exist — they just stop at the
network boundary. `PropTypes` checks component props only, at runtime only, in
dev only.

This is [Q6](#q6--no-shared-api-contract) seen from the client: the same missing
contract that lets `SubList.jsx` read `item.video_metadatum.videoUrl` — a
Sequelize association name reaching JSX with nothing describing it.

**Fixed**, as prescribed. `src/routes/openapi.ts` declares one response schema
per endpoint beside the request records `Q6` left in `endpoints.ts`, and
`deno task gen:api` emits two artifacts from those schemas:

- `openapi.json` — the OpenAPI 3.0 document for the whole HTTP surface.
- `frontend/src/api/generated/apiTypes.js` — JSDoc typedefs plus a route union.

The frontend stays JavaScript. `createApiClient.post` is generic over that
route union via JSDoc, so `api.post("/getsub", body)` accepts exactly the
documented request and resolves to exactly the documented response — the
`videoUrl` association name now has a type on both sides of the wire. A
`tsconfig.checkjs.json` runs `tsc --checkJs --noEmit` over the API layer
(`npm run typecheck`) as a CI step, and `tests/api_codegen.test.ts`
regenerates both artifacts in memory and fails against the committed copies,
so a schema edit without regeneration cannot land.

Not a TypeScript rewrite, deliberately: typing the API responses catches most
of what `PropTypes` misses, and components keep their PropTypes until each is
migrated on its own terms.

### F7 — 31-day bearer tokens in `localStorage`, never renewed

**Medium · Verified · Fixed, paired with `S4–S9`**

`src/middleware/auth.ts:407` defaulted `expiry_time` to `"31d"` and the login
form sent no override. There was no refresh endpoint and no renewal path on the
client. `AuthContext.jsx:11` reads the token straight out of `localStorage`.

The long lifetime existed precisely so the app could skip renewal, which is a
defensible trade for a self-hosted tool. The costs were that an XSS-leaked
token stayed valid for a month — compounded by the missing CSP in `S4–S9` —
and that there was no way to shorten one user's session without invalidating
everyone's.

**Done.** `TOKEN_EXPIRY` defaults to `24h`, and `POST /refresh` exchanges a
still-valid token for a fresh one. On the client, `useTokenRefresh` renews on
two triggers, because neither is sufficient alone: a timer at the halfway mark
of the token's life, and `visibilitychange`, since timers do not survive
suspend and browsers throttle them hard in background tabs — a tab woken after
its timer should have fired must not wait for a timer that already missed.

Three things fell out of it that are worth naming:

- **The client no longer picks its own lifetime.** `expiry_time` was an
  unbounded string on the login schema, so a caller could ask for a year and
  get it. The field is gone; the server decides.
- **`/refresh` sits behind `authenticateRequest`**, so an expired token gets
  the ordinary 401 there too. This extends a live session, it cannot revive a
  dead one — a sliding window, not an unlimited one. That is the trade the
  short lifetime is buying, and a tab asleep longer than `TOKEN_EXPIRY` comes
  back to a login form.
- **The response carries `expiresAt`**, the server's own `exp` claim, so the
  client schedules renewal off that rather than decoding a JWT it has no key
  to verify.

Refresh re-reads `updatedAt` from the row rather than carrying the old token's
claim forward, so a token minted here cannot outlive a password change — the
password-change check compares against exactly that value.

### F8 — The string `"null"` as a `localStorage` sentinel

**Low · Verified · Fixed**

`App.jsx` used to write `localStorage.setItem("ytdiff_token", "null")` on
expiry, with two readers guarding against that exact string. `Q1` replaced the
write with `removeItem` (`AuthContext.jsx:30`) and deleted one guard. The
remaining guard was `AuthContext.jsx:12` — `stored && stored !== "null"` —
migration code for tokens written by pre-`Q1` builds, sitting on the read path
where it read as a live workaround.

**Fixed** by migrating rather than guarding: `AuthContext` deletes the key on
mount, along with the orphaned expiry beside it — which the guard never did —
and the read is a plain read again. The migration names itself, is confined to
one function, and can be deleted outright once no live browser can still be
holding a pre-`Q1` value.

### F9 — Thumbnails not lazily loaded

**Low · Verified · Fixed**

The frontend renders exactly two remote images. `SubListItemCard.jsx:104`
already had `loading="lazy"`. The other was the MUI `Avatar` at
`PlayerPlaylistDrawer.jsx:114`, which took `src` but passed no `loading`.

The original finding assumed thumbnail grids of thousands of items — the
playlist views turned out not to render images at all, so what was left was one
attribute on one drawer list.

**Fixed** as `slotProps={{ img: { loading: "lazy" } }}`, since `img` is the slot
MUI actually puts the URL on. The drawer lists a whole playlist, so most of
those thumbnails start well below the fold.

### F10 — No test coverage thresholds

**Low · Verified · Fixed**

`vitest.config.js` composes the two viewport projects and sets no coverage
provider and no threshold; `@vitest/coverage-v8` is not a dependency. 13 desktop
and 5 mobile test files run with nothing asserting they keep covering anything.

`Q5` changed what this is worth. Before it, the frontend suite was advisory and
a coverage floor would have gated nothing. Now `npm run lint` and `vitest run`
fail the build, so a threshold is a real gate for the first time.

**Fixed** as prescribed. `@vitest/coverage-v8` with the v8 provider, and the
floor set where coverage already sat — statements 64, branches 47, functions 55,
lines 66 against 64.96/47.73/55.27/66.61. `App.jsx` and `VideoPlayer.jsx` are
inside it; `src/main.jsx` is the one exclusion, being the ReactDOM bootstrap
with nothing in it to cover.

One thing the finding did not say: the frontend CI job ran `vitest run` without
`--coverage`, so the thresholds would have been configured and never checked.
The flag is now on that step, which is what makes the floor a gate rather than a
number in a config file.

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
| `isWithinPath` (`files.ts:107`) | ~~the file deletion path (`videoFiles.ts:46`)~~ → **S3**, fixed |
| Four context providers + `useApi` | ~~`main.jsx` renders around them~~ → **Q1**, fixed |
| `SITE_CANONICALIZERS` registry | ~~`dedup.ts:63` re-implements it, disagreeing~~ → **Q2**, fixed |
| `isHostOrSubdomain` (`dedup.ts:59`) | ~~four more copies, one two functions below it~~ → **Q9**, fixed |

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

The Q2 fix moved both of those files' subjects *out* of `pipeline/` — the
canonicalizer tests now sit in `tests/url.test.ts` beside the code, and
`dedup.test.ts` is gone — so the ratio above got worse, not better. What Q5
changed is that the tests which do exist, on either side of the tree, now fail
a build.

The Q9 work moved the ratio the other way for the first time, and by the same
method as Q2: rather than trying to test `handlePlaylistStreaming` where it
sits, the two pieces of it that are worth pinning came out to modules that can
be. `chunks.ts` holds the offset arithmetic that writes `positionInPlaylist`,
and `ytdlp.ts` holds the argv builder that carries C1's `--`. Both are now
covered directly.

Q8 applied the same move to the part that needs a database, without needing
one: `persistStreamingChunk` came out of `processStreamingVideoInformation` to
module scope, and the models are the seam — stubbing their statics pins the
transaction and the upsert keys without a connection. That is the first test of
any kind against `processStreamingVideoInformation`. What is still untested is
everything upstream of the writes.

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

From the frontend review, four things the sibling app was told to copy *from*
this one. They are load-bearing — do not undo them while fixing F2–F10:

- **Accessibility.** 56 `aria-label`s across 11 components; every icon button in
  `Pagination.jsx`, `Nav.jsx` and `VideoPlayer.jsx` is labelled.
- **Real responsive testing.** `vitest.config.js` runs the suite twice — 375×667
  and 1280×720 — with per-viewport `matchMedia` shims that actually parse
  min/max-width queries. Nine `useMediaQuery` branches depend on it, so this is
  the thing `F10`'s coverage floor has to protect.
- **Server-side pagination and debounced search.** 10/25/50 page sizes with
  start/stop offsets sent to the server, search debounced at 1000 ms.
- **Precompressed assets.** gzip + brotli at build time, plus an `/esm` alias
  for `@mui/icons-material`.

One note for a future MUI upgrade rather than a finding: the `themeObj(...)`
factory in `App.jsx` is the correct pattern on MUI v5. On v9 it is superseded by
`colorSchemes` + `cssVariables` — bundle that switch with the upgrade, do not
treat it as a bug now.

---

## Suggested fix order

Sequenced so each step makes the next cheaper, not by severity alone.

1. ~~**C1 + Q7 together** — the `--` separator in all three argv builders, plus
   required fields and an http/https refinement at the schema boundary.~~
   **Done**, as a shared `isHttpUrl` predicate, `appendUrlArg` on every argv
   builder, and required fields across nine request schemas.
2. ~~**S1** — ship a non-zero action budget.~~ **Done**, as cost-weighted GCRA
   with per-user work accounting.
3. ~~**Q5** — finish the CI gate: add the frontend suite and `npm run lint`, and
   bring `scripts/` under the globs.~~ **Done**, as a Static Checks job and a
   Frontend job — after repairing the ioredis type imports and a scratch script
   that had never compiled, both of which only the new gates would have caught.
4. ~~**Q2 + Q3** — unify the canonicalizers and implement the documented
   tracking-parameter strip. Not cleanliness: the dedup path currently computes
   canonical forms the ingest path will never produce.~~ **Done**, as one
   registry in `src/utils/url.ts` with idempotence pinned per site. Took the
   host-matcher half of **Q9** and **S3** with it.
5. ~~**Q1** — mount the providers in `main.jsx` and route the 18 `fetch` calls
   through `useApi`. Deletion rather than construction.~~ **Done**, as
   `AppProviders` in `main.jsx` and one `apiFetch` behind every call, with the
   backend-location logic collapsed into `src/config.js`. Net −466 lines of
   `src/`, and the frontend suite went from 68 tests to 73.
   Step 5 is also **F1** — the two are one finding, which is why F1 does not
   appear again below.

Steps 6 onward were re-ranked on 2026-08-22, across both sets rather than
keeping the frontend items on a list of their own. The frontend items do not queue behind
the backend ones: `F2` and `F3` are the highest impact-per-hour work left in the
tree, and nothing above them blocks either.

6. ~~**F2 + F3** — an error boundary that handles stale chunks, and moving
   socket construction into an effect that disconnects on cleanup.~~ **Done**,
   as `ErrorBoundary` + `LazyRegion` around all six lazy blocks and around
   `<App />` outside the providers, and a `useEffect` keyed on `token` whose
   cleanup disconnects. `F3` carried the security half: a logged-out tab used to
   keep an authenticated socket open for the rest of the token's life.

   ~~Plus the F8 and F9 residue.~~ **Those two are done** — the sentinel is
   migrated rather than guarded, and the drawer `Avatar` lazy-loads. They came
   off this step early because neither depended on `F2` or `F3` for anything.
7. ~~**Q4** — typed process errors.~~ **Done**, as `ListingProcessError` with an
   `exitCode` field, branched on rather than string-compared, so a SIGTERM that
   also wrote to stderr stops surfacing to the user as a listing failure.
8. ~~**F10** — the coverage floor, set at current coverage across everything.~~
   **Done**, at 64/47/55/66 with nothing carved out but `main.jsx` — and with
   `--coverage` added to the frontend CI step, without which the floor would
   have been configured and never checked. It is now in place before the
   decomposition, which is the point: it is the only thing that will notice if
   steps 10–11 quietly drop coverage while moving code.
9. ~~**Q8** — one `sequelize.transaction()` around the triple write, and
    `bulkCreate` with `updateOnDuplicate` in place of the interpolated CASE.~~
    **Done**, as `persistStreamingChunk`, extracted to module scope so the
    write block is testable without spawning a listing process. Backend suite
    272 → 276, frontend 102 → 119.
10. ~~**Q6 + F6 as one piece of work**~~ — **Q6 is done**, as
    `src/routes/endpoints.ts` (one record per endpoint, which `api.ts` maps
    over), `json()` in `src/utils/http.ts` across 59 call sites, and
    `src/api/client.js` normalizing every response on the frontend. Backend
    suite 256 → 267, frontend 91 → 102, and net −418 lines across the two
    repositories.

    ~~**F6 is what is left.**~~ **F6 is done too**, as `src/routes/openapi.ts`
    (one response schema per endpoint, beside the request records),
    `deno task gen:api` emitting `openapi.json` plus
    `frontend/src/api/generated/apiTypes.js`, and a typed `post()` consumed
    from plain JS through a new `checkJs` gate. The contract now exists on
    both sides of the network boundary, generated from one file.
11. ~~**Q10** — the decomposition.~~ **Done.** `Q4` and `Q8` landed first, so
    `createListingFlow` had nothing left to close over once the sort-order
    counter moved into the database (`MAX(sortOrder) + 1` inside a serialized
    create — which also deleted the reset hook deletion used to have to
    call). `listing.ts` dissolved into `ingest-chunk.ts`,
    `playlist-records.ts` and `listing-requests.ts` around it; App.jsx's
    socket effect became `useSocketEvents` — closing the rest of `F4` and
    unblocking `F5` — while VideoPlayer and SubList gave up their
    signed-URL/subtitle/thumbnail layers to hooks. Every file named in the
    finding is under the bar, the scratch scripts are gone, and the F10
    coverage floor came through as designed: coverage rose slightly across
    the move (65.7/48.9/56.6/67.4 against the 64/47/55/66 floor).
12. **F5** — routing. After the `App.jsx` split in step 11, for the reason `F5`
    gives: routing a component that also owns the socket layer is much harder
    than routing one that does not.
13. ~~**S2, S4–S9 and F7** — the security long tail, cheapest first.~~
    **Done for S4–S9 and F7**, taken together as one change because they are
    one exposure: the CSP closes the path a token is stolen through, and the
    24-hour lifetime bounds what a stolen one is worth. Shipped as
    `SECURITY_HEADERS` + two CSP profiles in `generateCorsHeaders`, an
    `inline`-refusal list in `serveNativeFile`, a dummy `bcrypt.compare` on the
    login miss path, `POST /refresh` with `useTokenRefresh` on the client, the
    proxy credential moved to `secrets/`, and the personal `SAVE_PATH` default
    dropped. Backend suite 209 → 224, frontend 73 → 89.

    **S2 has since closed too**, as `TRUSTED_PROXIES` plus a right-to-left
    `X-Forwarded-For` walk in `src/utils/clientIp.ts`. It did not ride along
    with the rest because believing that header at all needs the allowlist
    first.

    **The committed proxy password still needs rotating.** It is out of the
    working tree, but it was committed, so it remains in the history.
