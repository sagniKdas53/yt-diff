# yt-diff: Unlisted organised, and small UX fixes

Background and evidence:
[`../design-architecture-playback-review.md`](../design-architecture-playback-review.md).
Finding IDs such as P1 and D1 come from that report. Where the two disagree,
this file wins.

## Scope changed on 2026-11-15

**The redesign is dropped.** The owner looked at the Home and Library mockups
and decided against rebuilding the app. The two-panel view stays as it is. What
remains:

1. Unlisted gets organised, using the filing job that is already merged.
2. Small UX fixes the owner approved one by one.
3. Player fixes (plan 01), already built.
4. A better download queue (plan 07), approved on 2026-11-15.

**Rule for every session:** no change to how the app looks or behaves unless it
is in the Approved table below. If a task seems to need one, stop and ask.

## Goal

Keep the app as it is, and make the Unlisted pile manageable: pressing UNLISTED
fills the left panel with the groups the filing job made, so the pile gets both
panels instead of one.

## Decisions

| Topic     | Decision                                                                                                                                 |
| :-------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Layout    | Two panels, unchanged. No Home screen, no Library tabs, no new nav.                                                                      |
| Playlists | The left panel opens on your playlists, exactly as today. Nothing about that list changes.                                               |
| Unlisted  | Pressing UNLISTED swaps the left panel to the Unlisted groups. Pressing it again brings the playlists back. The button carries no count. |
| Filing    | A scheduled job files each Unlisted video into a playlist, Clips, a channel or Archive. Off until a dry run is reviewed. Can be undone.  |
| Channels  | The job makes a channel only at 5 or more videos. A video whose channel or parent playlist already exists goes there instead ([05d]).    |
| Card      | Quick actions stay as icons under each card. No More menu. Thumbnail plays, title links to the source.                                   |
| Labels    | "Watch" stays "Watch".                                                                                                                   |
| Formats   | Unchanged. yt-dlp's format choice stays as it is. A file the browser can't play offers Download and VLC.                                 |
| Storage   | Filing frees no space and moves no files.                                                                                                |

[05d]: ./05d-filing-adjustments.md

## Layout

Playlists mode is today's screen. Unlisted mode is the same screen with a
different left list:

```
┌ yt-diff      RE-INDEX [UNLISTED] LIGHT CONNECTED DOWNLOADS LOGOUT ┐
├───────────────────────┬────────────────────────────────────────────┤
│ [ Group or channel  ] │ ☐ [ Title ] Site ▾ Added ▾ Length ▾ Creator ▾  Saved ↓
│ All unlisted      581 │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐            │
│ Inbox              22 │ │  ▶  │ │  ▶  │ │  ▶  │ │  ▶  │            │
│ Via bot            80 │ └─────┘ └─────┘ └─────┘ └─────┘            │
│ ───────────────────── │ Title    Title    Title    Title           │
│ Clips             149 │ ☐ 🗑 ⬇   ☐ 🗑 ⬇   ☐ 🗑 ⬇   ☐ 🗑 ⬇            │
│ Archive · saved    45 │                                            │
│ Archive · links   321 │                                            │
│ ───────────────────── │                                            │
│ Channel A           7 │                                            │
│ Channel B           5 │                       Item count  1–8 of 45│
└───────────────────────┴────────────────────────────────────────────┘
```

- The filters sit in the existing header row beside the Title box, not in a
  second row. They show only in Unlisted mode.
- Counts are from the seed data. Channel counts will change with the 5-video
  rule.
- On a phone the left list is the first screen, as today, and a row slides in
  its videos.

## Approved, rejected, open

From the owner's comments on the mockup, 2026-11-15.

### Approved

| Change                                                                                                                                          | Plan |
| :---------------------------------------------------------------------------------------------------------------------------------------------- | :--- |
| UNLISTED swaps the left panel to the Unlisted groups; playlists open by default                                                                 | 05b  |
| Groups: All unlisted, Inbox, Via bot, Clips, Archive saved, Archive links, job channels                                                         | 05b  |
| Filters (Site, Added, Length, Creator) in the existing header row                                                                               | 05b  |
| Watch on a job-made channel's row starts monitoring it. The job itself never indexes one                                                        | 05b  |
| Newest first in Unlisted: a new video lands on page 1                                                                                           | 05b  |
| Clips play straight through, with no Up next countdown                                                                                          | 05b  |
| The job makes a channel at 5+ videos, and folds into an existing channel or playlist                                                            | 05d  |
| The kind override comes out of #145, and the job stops relabelling your playlists                                                               | 05d  |
| Download icon on a card with no file queues the download                                                                                        | 02   |
| Thumbnails of downloaded videos stop being dimmed                                                                                               | 02   |
| Delete dialog names the video and says when it can't be undone                                                                                  | 02   |
| The open playlist's row is highlighted and its button says Open                                                                                 | 02   |
| "Item count" becomes "Per page", page size 1 goes, number box past 50 pages                                                                     | 02   |
| A finished download shows a toast with Open instead of switching the list                                                                       | 02   |
| Connection status is only mentioned after it was lost                                                                                           | 02   |
| Skeletons while loading, clearer empty text, a placeholder for a failed thumbnail                                                               | 02   |
| Download queue: move up and down, resume to the front, pause fixes, hold and pause all, survive a restart, and the drawer redone with a summary | 07   |
| Player: failure screen, retry cap, spinner, touch bar, Up next, lock-screen controls                                                            | 01   |

**Monitoring, in the owner's words:** "say a channel has 1000's of vids but we
have only collected 3 ... then don't try to index them, only if the watch mode
is explicitly set by user then index them again."

**Resume, in the owner's words:** "if a download is already running and
parallelism is set to 1 it should be 2nd." A resumed download goes to the front
of the waiting line and never interrupts one that is running.

### Rejected

| Change                                   | Owner's words                                                                |
| :--------------------------------------- | :--------------------------------------------------------------------------- |
| Card actions behind a More menu          | "I don't want to hide the quick actions behind one more drop down"           |
| Title plays, small link opens the source | "only the thumbnail plays, I want the title to still link back"              |
| Watch renamed Auto-update                | "leave watch alone as it is"                                                 |
| A count on the UNLISTED button           | "I don't want the number here"                                               |
| Any change to the playlists list         | "I still want the playlists to have their old view"                          |
| A list title above the videos            | The search box already shows the playlist's name when nothing is typed in it |
| Home, Library tabs, watch progress       | The redesign                                                                 |

Nothing is waiting on the owner.

## Order

| Plan                                           | Delivers                                          | Repo     | State                     |
| :--------------------------------------------- | :------------------------------------------------ | :------- | :------------------------ |
| [01](./01-playback-fixes.md)                   | Failure screen, buffering, player basics          | frontend | Merged, yt-diff-react#129 |
| [05](./05-unlisted-filing.md)                  | Filing job, views and filters                     | backend  | Merged, #140              |
| [05c](./05c-filing-follow-ups.md)              | Tighter matching, two filters                     | backend  | Merged, #145              |
| [05d](./05d-filing-adjustments.md)             | 5-video rule, folding, counts the left list needs | backend  | Not started               |
| [05b](./05b-library-views.md)                  | UNLISTED swaps the left panel                     | frontend | Not started               |
| [02](./02-safe-cards-and-nav.md)               | The approved small fixes                          | frontend | Not started               |
| [07](./07-download-queue.md)                   | Queue order, pause and resume fixes               | both     | Approved, not started     |
| [03](./03-formats-and-media-info.md)           | Remux, codec info                                 | both     | Not planned               |
| [04](./04-progress-ownership-notifications.md) | Watch progress, owners, notifications             | both     | Dropped                   |
| [06](./06-player-lift-and-home.md)             | Player lift, Home                                 | both     | Dropped                   |

Run 05d, then 05b, then 02. 05b and 02 edit the same components, so one at a
time. 07 doesn't touch the others and can go whenever it's approved.

Which backend work from 05 and 05c is still needed is listed in
[05d](./05d-filing-adjustments.md#what-the-merged-backend-work-is-still-for).

**Test data:** [`seed/`](./seed/README.md) loads real-shaped data into a
throwaway Postgres. **Phase 0a results and the storage audit:**
[`notes-2026-11-06.md`](./notes-2026-11-06.md).

## How to run this with Sonnet

1. **One session per plan file.** Run on Sonnet, `/clear` between plans, and
   load only that plan plus this README. An orchestrating session may instead
   hand each plan to one Sonnet subagent, one at a time: `test:db` and the seed
   loader share a fixed port, so two plans can't test at once.
2. **Call the advisor only** at each `Advisor checkpoint` in a plan, when the
   same problem has failed twice, and before declaring a plan finished. Each
   call forwards the whole session, so short sessions keep it cheap.
3. **Read narrowly.** Plans name line ranges from `0040ad3` / `a401984`. Lines
   may have moved in later plans, so search for the symbol if a range looks
   wrong.
4. **Stop and ask** if a task needs a decision not written down here, rather
   than picking one quietly.

## Repo workflow

- **Frontend:** `frontend/` is a submodule. Branch from `material`, PR there,
  then bump the pointer in the root repo after merging.
- **Backend:** branch from `master` in the root repo.
- **API changes that span both:** `deno task gen:api` writes `openapi.json` and
  `frontend/src/api/generated/apiTypes.js`. Merge backend first, then commit the
  regenerated file on the frontend branch.
- **GitNexus (required by `CLAUDE.md`):** before editing a symbol, run `impact`
  with `summaryOnly: true`. Before each commit, run `detect_changes` with
  `scope: "all"`. Refresh with `node .gitnexus/run.cjs analyze --index-only` at
  the start of a session. Warn the user on HIGH or CRITICAL. `UNKNOWN`,
  `partial: true`, or a target not found (hooks and `lazy()` imports often are)
  means confirm callers with `grep`.

### Commands and baselines

| Scope    | Command                                                                 | Baseline           |
| :------- | :---------------------------------------------------------------------- | :----------------- |
| Backend  | `deno task test:unit`                                                   | 592 passed, ~20 s  |
| Backend  | `deno task test:db` (needs Docker; loads `seed/` each test)             | 50 passed, ~2 min  |
| Backend  | `deno task fmt:check && deno lint index.ts src/ tests/ scripts/`        |                    |
| Backend  | `deno check index.ts src/ tests/ scripts/`                              |                    |
| Frontend | `npx vitest run --project desktop tests/desktop/<file>` (during a task) |                    |
| Frontend | `npx vitest run` (end of a task only)                                   | 364 passed, ~3 min |
| Frontend | `npm run lint && npm run typecheck`                                     |                    |

Run frontend commands from `frontend/`.

### Adding an endpoint

There are five places, and nothing works until all are done:

1. Zod schema in `src/middleware/validator.ts`.
2. Handler name in `AuthenticatedHandlers` and a record in the `endpoints` list
   in `src/routes/endpoints.ts`, usually `admission: "none"`.
3. Response schema in `ResponseSchemas` in `src/routes/openapi.ts`.
4. Handler wired in the `authenticated:` block of `index.ts` (around line 697).
   The router's third argument is `RequestContext`, with `userId` and
   `userName`.
5. `deno task gen:api`.

## Global constraints

- No new runtime dependencies, and no TanStack Query.
- Hash routing stays. Every link the bot has already sent must keep opening.
- Nothing filters or blocks by owner.
- No yt-dlp format selection (`-f`, `-S`) is added.
- Signed file serving stays in Deno. Plan 03 only fixes range parsing.
- `sequelize.sync({ alter: true })` is the migration system, so new columns are
  nullable or have defaults.
- Recording progress, owners or notifications must never fail a download, a
  delivery or playback. Log the error and carry on.
- Browser checks use three sizes: 1440×900, 800×1280 and 390×844. Watching on a
  phone is the goal, and the first two never show a phone's width.
- Keep the code style: explain why in comments, and use `Deno.test` names shaped
  like `area - behaviour`.

## Deliberately left out

Dropped on 2026-11-15 with the redesign: the Home screen, the Library tabs and
nav, watch progress, ownership, the notification log, the player lift, and
remuxing (plans 03, 04 and 06). An unsupported codec that plays sound over a
black screen with no message is also left, as too big for now.

Each of these is a finding from the review with no task here. Pick them up later
if they still bother you.

- Search text and sort in the URL (L6).
- Stable thumbnail URLs (L8, S6). Only worth doing if a profile shows thumbnails
  costing real time.
- On-demand transcoding. A file that can't play offers Download and VLC instead.
- Phase 0c and d from the review, and 0b on phones. They still tell you whether
  "mid" is the client or the server, and nothing here depends on the answer. The
  laptop half of 0b is in the notes.
- Filling in metadata for rows that have none, which needs a yt-dlp call per
  row. 844 rows stay in Archive under their site until a re-index gives them
  more.
- Deleting duplicate files. 3.93 GB of orphans and a few dozen duplicates, out
  of 361.5 GB. The existing dedup tool merges rows only.
- Moving files into per-channel folders. It's tidier, and it frees nothing.
- Site shelves, guided triage, dead-link checks and topic clustering. Considered
  on 2026-11-06, and not chosen.
- Running these plans in cloud sessions. What that would take is in the notes.
