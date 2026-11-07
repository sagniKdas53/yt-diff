# Handoff: watch-first yt-diff

You're picking up an implementation that's been reviewed, decided and planned,
but not started. **Don't redo the review or reopen the decisions.** The plans
carry the design, so your job is to execute them one at a time.

## Where things stand (2026-11-06)

| Item                       | State                                                             |
| :------------------------- | :---------------------------------------------------------------- |
| Review and plans           | Merged to `master`                                                |
| 30-day login sessions      | Merged to `master` (PR #137). Not yet deployed to the Pi          |
| Plans 01 to 06             | Not started                                                       |
| Pi measurements (Phase 0a) | Done. Results in `notes-2026-11-06.md`                            |
| Pi measurements (0b)       | Laptop done, in the notes. Phones to come                         |
| Pi measurements (0c, 0d)   | Not run, and nothing depends on them                              |
| Test data                  | `seed/`, loaded and checked against production                    |
| Frontend `material`        | Unchanged at `a401984`                                            |
| Test baseline              | 568 backend unit + 41 backend database, 316 frontend, all passing |

The owner has approved everything in the `README.md` Decisions table, including
the Home and Library layouts. On 2026-11-06 the owner chose the Unlisted design:
Saved or Links only, one Archive with filters, one Channels list, and a Clips
shelf. These plans run locally.

## Before the first session (owner)

1. **Stay on `docs/unlisted-filing-plan` until its PR merges.** Plans 05 and 05b
   and `seed/` exist only there, so `master` would lose them. While it's open,
   branch backend work from it and target backend PRs at it. Frontend branches
   still start from `material`. After it merges, use
   `git switch master && git pull`, and branch from `master`.
2. **Deploy the 30-day sessions:** run `make pi5` to regenerate `.env`, then
   recreate the container. A new image alone doesn't apply it, because the
   change is in `docker-compose.yml` and `envs/base.env`.
3. **Tick "Remember me" on your phone once.** Without it the session ends with
   the tab, however long the token lasts.

## How to run a session

One Sonnet session per plan, with the advisor available and no subagents.
`/clear` between plans. Paste this, changing the plan number:

```
Implement docs/plans/watch-first/01-playback-fixes.md.
Read docs/plans/watch-first/HANDOFF.md and README.md first, then that plan, and
nothing else from docs/plans. Use superpowers:executing-plans inline. Don't spawn
subagents. Call the advisor only at the plan's Advisor checkpoints, if the same
problem fails twice, and before saying you're finished. Stop and ask me if a task
needs a decision the plan doesn't make. Don't merge anything.
```

**Finishing a plan:** the full checks pass, the advisor has been called, and a
PR is open. Then update the Progress table below, in that plan's branch.

## What each plan needs first

| Plan | Before starting                                     |
| :--- | :-------------------------------------------------- |
| 01   | Nothing                                             |
| 02   | 01 merged                                           |
| 03   | 02 merged                                           |
| 04   | 03 merged. Backend PR merges before its frontend PR |
| 05   | Nothing. Run `seed/load.sh` for the test database   |
| 05b  | 02 and 05 merged                                    |
| 06   | 04, 05 and 05b merged, and their backfills run      |

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

## After each plan (owner, on the Pi)

| Plan | Run                                                                          |
| :--- | :--------------------------------------------------------------------------- |
| 03   | `deno task media:backfill`, then `media:remux-mkv` (dry run, then `--apply`) |
| 04   | `deno task owners:backfill`, then with `--apply --assign-unowned <you>`      |
| 05   | `facets:backfill`, then `filing:run` (dry run, then `--apply`), then enable  |
| 06   | `deno task facets:backfill` again, to fill `downloadedAt`                    |

Use the same method you use for `chapters:backfill` in the container.

## Progress

| Plan                                  | Branch(es)                                     | PR                             | Merged                                           | Backfill run |
| :------------------------------------ | :--------------------------------------------- | :----------------------------- | :----------------------------------------------- | :----------- |
| 01 Playback fixes                     | `fix/playback-failures`                        | yt-diff-react#129              |                                                  | n/a          |
| 02 Safe cards and nav                 | `fix/safe-cards-and-nav`                       |                                |                                                  | n/a          |
| 03 Formats and media info             | `feat/media-info`, `feat/playability-check`    |                                |                                                  |              |
| 04 Progress, ownership, notifications | `feat/user-tracking`, `feat/watch-progress-ui` |                                |                                                  |              |
| 05 Unlisted filing                    | `feat/unlisted-filing`                         | #140, types: yt-diff-react#128 | 2026-11-06 (yt-diff#140, with yt-diff-react#128) |              |
| 05b Library views                     | `feat/library-views`                           |                                |                                                  | n/a          |
| 06 Player lift and Home               | `feat/player-lift`, `feat/home-feed`           |                                |                                                  |              |

## Not in scope

Listed under "Deliberately left out" in `README.md`. Don't add them, and don't
add owner-based restrictions or a custom mini-player.
