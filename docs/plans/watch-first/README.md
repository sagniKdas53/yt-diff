# Watch-first yt-diff: roadmap and design

Background and evidence:
[`../design-architecture-playback-review.md`](../design-architecture-playback-review.md).
Finding IDs such as P1 and D1 come from that report. Where the two disagree,
this file wins.

## Goal

Keep the archive's reliability, and make watching good enough that Jellyfin and
VLC stop being needed for everyday viewing, with the 3,000-video Unlisted pile
organized automatically.

## Decisions

| Topic         | Decision                                                                                                                          |
| :------------ | :-------------------------------------------------------------------------------------------------------------------------------- |
| Formats       | Quality first. yt-dlp's format choice stays as it is. Lossless remux only. A file the browser can't play offers Download and VLC. |
| Progress      | Per-user backend table.                                                                                                           |
| Ownership     | Record who added or saved each video. **No restrictions:** nothing filters by owner yet.                                          |
| Notifications | Persist them, with delivery per channel (web, Telegram): delivered, read, failed. Also no restrictions.                           |
| Routes        | **Approved 2026-11-06, layouts included:** `#/` is Home, `#/library` is the two-panel view. Existing bot links keep working.      |
| Unlisted      | Grouped automatically by channel, with small channels rolled up per site. Nobody sorts anything by hand.                          |
| Mini-player   | Not building one. Browser picture-in-picture stays.                                                                               |

**Why the format choice stays:** tested on a 4K YouTube video. The default picks
AV1 with AAC in MP4 at 743 MB. `-S "res,fps,hdr:12,vcodec:h264,acodec:aac"`
picks VP9 with AAC in MKV at 1.39 GB, which is larger and in a worse container,
so no compatibility sort is used.

**Ownership and notifications, confirmed 2026-11-06.** "Owner" means who asked
for the video: a web user or a bot chat. "Delivery" means whether a notification
reached that channel: delivered, read or failed.

**Starting a session?** Read [`HANDOFF.md`](./HANDOFF.md) first.

## Layouts

### `#/` Home: what you open to watch

Full width, with no management controls. Sections with nothing to show are
hidden. A card click plays.

```
┌ yt-diff   Home  Library                          ↓ 2   🔔 3   ⋮ ┐
├──────────────────────────────────────────────────────────────────┤
│  [ Search everything…                                          ] │
│                                                                  │
│  Continue watching                                               │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                    │
│  │ ▶    │ │ ▶    │ │ ▶    │ │ ▶    │ │ ▶    │  →                 │
│  │▓▓▓░░░│ │▓░░░░░│ │▓▓▓▓░░│ │▓▓░░░░│ │▓░░░░░│                    │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                    │
│  Title    Title    Title    Title    Title                       │
│  12m left 40m left 3m left  8m left  1h left                     │
│                                                                  │
│  Recently saved                                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  →                 │
│                                                                  │
│  Channels and playlists with new videos                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  →                 │
│  Name·42  Name·7   Name·19  Name·3   Name·11                     │
└──────────────────────────────────────────────────────────────────┘
```

On a phone the rails stay horizontal and swipeable, and everything else is the
same. With an empty library it shows one line and an Add button.

### `#/library`: where things live and get managed

Two panels, like today, but the left side has two tabs and the right side is
never empty. On desktop, `#/library` opens the Inbox.

```
┌ yt-diff   Home  Library                          ↓ 2   🔔 3   ⋮ ┐
├───────────────────────┬──────────────────────────────────────────┤
│ [Playlists] [Channels]│ Some Channel · 42 videos       [▶ Play]  │
│ ───────────────────── │ [Monitor channel]  [Resume]              │
│ 📥 Inbox           18 │ [ Search this list ]  Newest ▾  ☐ Hide watched
│ 🤖 Via bot        210 │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐          │
│ 🗂 All unlisted  3420 │ │  ▶  │ │  ▶  │ │  ▶  │ │  ☁  │          │
│ ───────────────────── │ │▓▓░░░│ │     │ │     │ │     │          │
│ ◉ Some Channel     42 │ └─────┘ └─────┘ └─────┘ └─────┘          │
│ ◉ Another          19 │ Title ⋮ Title ⋮ Title ⋮ Title ⋮          │
│ ◉ Third             7 │                        [Save to archive] │
│ ▸ Other from X    880 │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐          │
│ ▸ Other from YouTube  │ │     │ │     │ │     │ │     │          │
│         …      page ▾ │                          page 1 of 3  ▸  │
└───────────────────────┴──────────────────────────────────────────┘
```

- **Playlists tab:** today's list, with "Watch" renamed "Auto-update".
- **Channels tab:** the automatic groups, newest activity first.
- **On a phone:** `#/library` is the left panel alone; a row slides in the
  videos.
- **Deleting and similar:** moved into each card's ⋮ menu.

### How the pile disappears

1. Each video gets a site and channel from metadata already stored, with no
   re-index.
2. A channel with 3 or more Unlisted videos becomes its own row.
3. Everything smaller rolls up into "Other from <site>".
4. **Inbox** holds only what you might want now: saved in the last 30 days and
   not finished.
5. **Hide watched** clears finished videos from any view.

`#/unlisted` still exists as "All unlisted", so nothing is hidden for good, and
old bot links still open.

## Order

| Plan                                           | Delivers                                     | Repo     | Size |
| :--------------------------------------------- | :------------------------------------------- | :------- | :--- |
| [01](./01-playback-fixes.md)                   | Failure screen, buffering, player basics     | frontend | M    |
| [02](./02-safe-cards-and-nav.md)               | Safe cards, nav, labels, no background jumps | frontend | M    |
| [03](./03-formats-and-media-info.md)           | Remux, codec info, playback check            | both     | M    |
| [04](./04-progress-ownership-notifications.md) | Watch progress, owners, notification log     | both     | L    |
| [05](./05-auto-collections.md)                 | Newest first, Channels, Inbox                | both     | L    |
| [06](./06-player-lift-and-home.md)             | Invalidation store, player lift, Home        | both     | L    |

Each plan ships on its own. Do them in this order: 05 needs 04's tables for
Inbox, and 06 needs 04 and 05. **Before plan 05**, run Phase 0a from the review
on the Pi and paste the output into the session.

## How to run this with Sonnet

1. **One session per plan file.** Run on Sonnet, `/clear` between plans, and
   load only that plan plus this README. Don't spawn subagents.
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
| Backend  | `deno task test:unit`                                                   | 482 passed, ~20 s  |
| Backend  | `deno task fmt:check && deno lint index.ts src/ tests/ scripts/`        |                    |
| Backend  | `deno check index.ts src/ tests/ scripts/`                              |                    |
| Frontend | `npx vitest run --project desktop tests/desktop/<file>` (during a task) |                    |
| Frontend | `npx vitest run` (end of a task only)                                   | 316 passed, ~3 min |
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
- Keep the code style: explain why in comments, and use `Deno.test` names shaped
  like `area - behaviour`.

## Deliberately left out

Each of these is a finding from the review with no task here. Pick them up later
if they still bother you.

- Search text and sort in the URL (L6). Home's search and clearer empty states
  cover most of it.
- Stable thumbnail URLs (L8, S6). Only worth doing if a profile shows thumbnails
  costing real time.
- On-demand transcoding. A file that can't play offers Download and VLC instead.
- Phase 0b, c and d from the review. They still tell you whether "mid" is the
  client or the server, and nothing here depends on the answer.
