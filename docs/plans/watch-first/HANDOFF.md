# Handoff: yt-diff, Unlisted organised and small fixes

**The redesign is off (2026-11-15).** There is no Home screen, no Library tabs
and no new nav. The two-panel app stays. `README.md` has the scope and the table
of what the owner approved. **Build nothing that isn't in that table.** If a
task seems to need a change the table doesn't list, stop and ask.

The decisions are made and the plans carry the design. Your job is to execute
one plan at a time.

## Where things stand (2026-11-16)

| Item                   | State                                               |
| :--------------------- | :-------------------------------------------------- |
| 01 Player fixes        | Merged (yt-diff-react#129)                          |
| 05 Unlisted filing     | Merged (#140)                                       |
| 05c Filing follow-ups  | Merged (#145), without the kind override            |
| Plans 05d, 05b, 02, 07 | Approved, not started                               |
| Plans 03, 04, 06       | Dropped or not planned. Nothing of theirs was built |
| Filing job             | Off everywhere. Run only against the seed database  |
| Frontend `material`    | `ad26b3f`, which `master` points at                 |
| Test baseline          | 592 backend unit, 50 backend database, 364 frontend |
| Deployed to the Pi     | None of the above. The owner deploys                |

Known and left alone: a video in a codec the browser can't decode, with playable
audio, shows a black screen and no message. Two dependency updates are open and
failing tests (jsdom 31, and a vite patch release).

## What to build, in order

| Step | Plan                                            | Repo     | Branch                     | Needs                |
| :--- | :---------------------------------------------- | :------- | :------------------------- | :------------------- |
| 1    | [05d](./05d-filing-adjustments.md) Tasks 1 to 5 | backend  | `fix/filing-adjustments`   | Nothing              |
| 2    | [07](./07-download-queue.md) Tasks 1 to 5       | backend  | `feat/download-queue`      | Step 1's PR open     |
| 3    | [05b](./05b-library-views.md)                   | frontend | `feat/unlisted-left-panel` | Step 1 merged        |
| 4    | [02](./02-safe-cards-and-nav.md)                | frontend | `fix/approved-small-fixes` | Step 3 merged        |
| 5    | [07](./07-download-queue.md) Task 6             | frontend | `feat/download-drawer`     | Steps 2 and 4 merged |

- 05d Task 0 is done: the kind override never reached `master`.
- Steps 1 and 2 can't run at the same moment. `test:db` and the seed loader
  share one port.
- Steps 3, 4 and 5 edit the same components, so one at a time.
- Each step ends in a PR. The owner merges. **Don't merge anything.**
- A backend step that changes the API also opens a small frontend PR with the
  regenerated types, and its backend PR bumps the `frontend` pointer to a commit
  that has them. See "The generated-types test" under Traps.

## How to run a step

One Sonnet session or subagent per step. Paste this, changing the plan:

```
Implement docs/plans/watch-first/05d-filing-adjustments.md, Tasks 1 to 5.
Read docs/plans/watch-first/HANDOFF.md and README.md first, then that plan, and
nothing else from docs/plans. Use superpowers:executing-plans inline. Stop and
ask if a task needs a decision the plan doesn't make, or a change to how the
app looks that README.md doesn't list as approved. Don't merge anything, and
don't run the filing job against anything but the seed database.
```

**Finishing a step:** every check exits 0, a PR is open with Summary, Evidence
and Merge Danger sections, and the Progress table below is updated in that
branch.

## Rules that hold for every step

- **Never connect to the Pi or production, and never deploy.** Tests and the app
  run against the seed database and a local Redis only.
- **Don't read `.env` or `secrets/`.** The owner has filled them in.
- **Don't enable the filing job.** `filing:run` and `filing:undo` are for the
  seed database.
- **Judge a check by its exit status,** not by reading its output.
- **Don't run `npm run build` as written.** It writes into the deployed folder.
  Use
  `npx vite build --base=/ytdiff/ --outDir=<a scratch folder> --emptyOutDir`.
- **Browser checks** use 1440×900, 800×1280 and 390×844.

## Seeing it run locally

There's no script for this in the repo. What worked:

1. `seed/load.sh` for Postgres on `127.0.0.1:55432`, and a Redis container on a
   spare port.
2. Build the frontend into a scratch folder with the command above, and run the
   backend from a folder that has that build as `dist/`.
3. Start it with
   `deno run --allow-all --config <repo>/deno.json
   <repo>/index.ts`, with
   `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `REDIS_HOST`,
   `REDIS_PORT`, `SECRET_KEY`, `PORT`, `HOSTNAME` and `SAVE_PATH` set, and
   `UPDATE_SCHEDULED`, `EXTRAS_RETRY_INTERVAL` and `PRUNE_INTERVAL` set to a
   date that never comes, such as `0 0 29 2 *`. The seed's credentials are in
   `seed/README.md`.
4. The seed has rows but no files. To play something, make short test clips with
   ffmpeg and hard-link one to each saved row's `fileName`.
5. The groups in Unlisted mode are empty until a sweep has run on the seed:
   `deno task facets:backfill`, then `deno task filing:run` with `--apply`.

## Things already proven, so don't re-derive them

- **yt-dlp format choice stays.** A compatibility `-S` produced a larger MKV
  than the default on a 4K test. `--merge-output-format mp4/webm/mkv` doesn't
  prevent MKV either.
- **`--remux-video "mkv>mp4"` works, but `post_process` prints the old `.mkv`
  name.** Use `after_move`, as plan 03 Task 1 says, or rows will point at files
  that don't exist.
- **Media is a native Deno stream with working range requests,** not Node. Leave
  serving alone apart from plan 03's parsing fix.
- **The playback retry loop is reproduced.** 25 code 4 errors made 25 more
  `/getfile` requests. An expired URL can also surface as code 4, so one retry
  has to stay.
- **The tap trap is real.** Touch fires `mousemove` before `click`, so
  `showControls` is already true by the time `onClick` reads it. See plan 01
  Task 4.

## Traps

- **The generated-types test.** `tests/api_codegen.test.ts` compares
  `frontend/src/api/generated/apiTypes.js`, at the commit the root repo points
  to, with what `deno task gen:api` produces. A backend branch that changes the
  API fails it until the frontend has the new file and the branch's `frontend`
  pointer is bumped to that commit. Merge the types PR, then bump.
- **A fresh worktree has an empty `frontend/`.** Run
  `git submodule update --init` or that test can't run.
- **GitNexus's bundled runner fails** on a storage version mismatch. Use
  `npx --yes gitnexus@latest impact "<symbol>" --direction upstream --repo
  yt-diff`
  and `... detect-changes --scope all --repo yt-diff`. The repo name, not `.`.
- **`lockedKept` in undo stays.** It keeps a video you took out of a playlist
  from being filed again. It has nothing to do with the kind override that was
  removed.
- **The missing-file screen matches the server's exact words,** "File could not
  be found" with a 400 (`src/handlers/files.ts`). Reword that and the player
  falls back to plain error text.
- **GitNexus understates this code.** It rates `VideoPlayer` LOW with one
  caller, while 19 props depend on `SubList`. It can't see hooks or `lazy()`
  imports. `partial: true`, `UNKNOWN` or "not found" means confirm with `grep`,
  as `CLAUDE.md` requires. The index goes stale quickly, so refresh at the start
  of a session.
- **Sync errors are silent.** `initializeDatabase` catches and logs them, and a
  failure also skips creating the `None` playlist. Check the log after any model
  change.
- **`frontend/` is a submodule on `material`.** Commit there, PR there, and bump
  the pointer in the root repo afterwards. `git status` in the root won't show
  frontend file changes.
- **`deno task gen:api` writes into `frontend/`.** That file goes on the
  frontend branch.
- **The full frontend suite takes about 3 minutes.** Run single files during a
  task.
- **`unique: true` adds a constraint on every boot.** `user_accounts` has 228 of
  them from `sync({ alter: true })`. Use `primaryKey` or a named index on new
  tables. The existing ones aren't planned work.
- **This repository is public.** Don't commit anything from production without
  pseudonymizing it, and don't name sites other than YouTube in new documents.
  See `seed/README.md`.
- **Only the filing job writes negative positions.** Any code doing arithmetic
  on `positionInPlaylist` has to allow for them. Plan 05 lists the known places.
- **`view` means an Unlisted group, and only that:** `inbox`, `bot`, `clips`,
  `archive` and `all`, in the route and in requests.
- **`approximateSize` can't be trusted.** It totals 8.7 GB for a 361.5 GB
  library.
- **`raw_metadata` holds `cookies` in 230 rows,** and backups copy them. It
  isn't planned work, so tell the owner if you're near that code.
- **Line numbers are from `0040ad3` / `a401984`** and drift as plans merge.
  Search for the symbol if a range looks wrong.
- **`tests/auth_token.test.ts` pins the code default at `24h`.** The 30-day
  setting is in `envs/base.env` on purpose, and the code default stays.
- **A new environment variable needs a line in `docker-compose.yml`.** Compose
  lists the service's environment one by one and has no `env_file`, so a value
  only in `envs/*.env` never reaches the container. `TOKEN_EXPIRY` went
  unnoticed this way. Check with
  `docker compose --env-file <rendered env> config | grep <NAME>`.

## After each step merges (owner, on the Pi)

| Plan | Run                                                                       |
| :--- | :------------------------------------------------------------------------ |
| 05   | `facets:backfill`, if not run yet                                         |
| 05d  | `filing:run` as a dry run. Read it. Then `--apply`, then `FILING_ENABLED` |
| 07   | Nothing. Queued and paused jobs come back paused after the restart        |

Wait for 05d before the first real sweep: before it, the job makes channels at 3
videos. Use the same method you use for `chapters:backfill` in the container.

## Progress

| Plan                           | Branch(es)                 | PR                             | State       |
| :----------------------------- | :------------------------- | :----------------------------- | :---------- |
| 01 Playback fixes              | `fix/playback-failures`    | yt-diff-react#129              | Merged      |
| 05 Unlisted filing             | `feat/unlisted-filing`     | #140, types: yt-diff-react#128 | Merged      |
| 05c Filing follow-ups          | `fix/filing-follow-ups`    | #145, types: yt-diff-react#135 | Merged      |
| 05d Filing adjustments         | `fix/filing-adjustments`   |                                | Not started |
| 07 Download queue, backend     | `feat/download-queue`      |                                | Not started |
| 05b Unlisted in the left panel | `feat/unlisted-left-panel` |                                | Not started |
| 02 Approved small fixes        | `fix/approved-small-fixes` |                                | Not started |
| 07 Download queue, drawer      | `feat/download-drawer`     |                                | Not started |

The filing job hasn't been run or enabled anywhere but the seed database.

## Not in scope

Listed under "Deliberately left out" in `README.md`. Don't add them, and don't
add owner-based restrictions or a custom mini-player.
