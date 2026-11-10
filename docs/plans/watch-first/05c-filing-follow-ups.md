# 05c: Filing follow-ups implementation plan (backend)

> **For agentic workers:** use superpowers:executing-plans inline. Read
> `README.md` first, then "The design" in `05-unlisted-filing.md`. Steps use
> checkboxes.

**Goal:** close the gaps a review of the merged plan 05 found on 2026-11-10,
before the filing job is switched on anywhere: a handle match that is too
loose, no way to overrule the job's "channel" label, an undo that forgets your
removals, and two filters the Archive needs.

**Architecture:** small changes inside `src/handlers/filing/`, one new column
on `playlist_metadata`, one new endpoint, and two optional fields on existing
requests. Nothing here changes what plan 05 promised never to do.

**Tech stack:** Deno, Sequelize, Postgres. **Branch:** `fix/filing-follow-ups`
from `master`. **Frontend:** the controls that use this are in
`05b-library-views.md`. **Data:** `seed/README.md`.

## What the review found

| Finding                                                                                                                                                              | Task |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--- |
| `channelFromHandle` matches a handle against any path segment of any playlist URL on the site, so a curated playlist under a user's path collects all their videos   | 1    |
| It never matches on channel id, so a channel stored under an id-style URL is missed                                                                                  | 1    |
| The sweep flips a single-owner playlist to kind `channel`, never flips back, and there is no way to set `kind` by hand                                               | 2    |
| Undo deletes every filing row, the `locked` ones too, so a later sweep re-files what you removed                                                                     | 3    |
| The Creator menu is a top 50 by count. Archive is, by construction, creators with one or two videos, so the menu is least useful where it's most needed              | 4    |
| "Added" is the only time filter, and 714 rows were added in one three-day import. `uploadDate` is stored and unused                                                  | 4    |
| The comment on `filedPosition` says the newest video is the least negative. It is the most negative. The behaviour is right                                          | 3    |

## Global constraints

See `README.md` and plan 05. The rule numbers still live only in
`src/handlers/filing/rules.ts`. Bump `RULES_VERSION` to 2 in Task 1, because a
placement rule changes.

**The filing job stays off.** Nothing in this plan enables it, and no task runs
`filing:run --apply` outside the test database.

## Review focus

1. A handle or id match only ever lands in a playlist that is one account's
   videos. A mixed or curated playlist is never a target.
2. A playlist whose `kind` you set by hand is never changed by a sweep, and
   undo leaves it alone.
3. Undo, then a sweep, doesn't re-file a video you removed.
4. `creatorQuery` and the uploaded range are parameters, never concatenated,
   and a malformed value is a 400.
5. Every count in `tests-db/` that changes is explained by Task 1's rule
   against `seed/check.sql`. No number is edited just to pass.

---

### Task 1: Match uploaders only to channel-like playlists, and by id too

**Files:** Modify `src/handlers/filing/place.ts`, `src/handlers/filing/store.ts`
(`loadPlaylists`), `src/handlers/filing/sweep.ts`,
`src/handlers/filing/rules.ts`, `docs/plans/watch-first/seed/check.sql`. Tests
`tests/filing_place.test.ts`, `tests/filing_sweep.test.ts`,
`tests-db/filing.test.ts`.

**Advisor checkpoint:** before Step 3, because this changes a placement rule
and the measured totals with it.

**Interfaces:**

```ts
interface KnownPlaylist {
  // existing fields, plus:
  channelLike: boolean; // kind "channel", or passes isChannelLike right now
}
interface UnlistedRow {
  // existing fields, plus:
  channelId: string | null; // the part of channelKey after "<site>:"
}
// renamed from channelFromHandle; the old name goes
channelFromUploader(row: UnlistedRow, playlists: KnownPlaylist[]): string | null
```

- [ ] **Step 1: Write failing tests.**
  - A handle that matches a playlist with `channelLike: false` matches nothing,
    and the video goes on to the clip, channel and Archive rules.
  - A handle that matches two playlists, one channel-like and one not, picks
    the channel-like one.
  - With no handle match, a `channelId` equal to a URL segment (compared
    lowercased) matches, on the same site only.
  - A `channelId` in `URL_WORDS` matches nothing.
  - A handle match wins over an id match when both exist and differ.
  - The tie-break is unchanged: monitored first, then the oldest.
  - A row already placed `playlist` under the old rule stays put. Only new and
    reconsidered rows see the new rule.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The sweep already calls `loadOwnerCounts` after
      placing; move that read before `placeVideos`, and have `loadPlaylists`
      set `channelLike` from the row's `kind` or from `isChannelLike` over
      those counts. A `kindLocked` playlist (Task 2) uses its `kind` alone.
      Bump `RULES_VERSION`.
- [ ] **Step 4: Update `seed/check.sql`** to the same rule, run it against the
      pack, and update the expected totals in `tests-db/filing.test.ts` and in
      plan 05 Task 6's list from what it prints. If a count moves in a way the
      rule doesn't explain, stop and find out why.
- [ ] **Step 5: Run `deno task test:unit` and `deno task test:db`.** Expected:
      PASS.
- [ ] **Step 6: Commit.**
      `fix(library): match uploaders only to channel-like playlists, and by id`.

### Task 2: Set a playlist's kind by hand

**Files:** Modify `src/db/models.ts`, `src/handlers/filing/store.ts`
(`loadOwnerCounts`, `markChannelLike`, `loadUndoCandidates`),
`src/handlers/filing/channels.ts`, and the five places in `README.md`'s
endpoint recipe. Tests `tests/channels.test.ts`, `tests-db/channels.test.ts`.

**Interfaces:**

```ts
// playlist_metadata gains:
kindLocked: boolean, default false // you chose the kind; the sweep leaves it

// POST /playlists/kind { playlistUrl, kind: "playlist" | "channel" }
//   → { playlistUrl, kind }
// /getplay rows gain { kindLocked }
```

- [ ] **Step 1: Write failing tests.**
  - Setting a kind stores it with `kindLocked: true` and
    `kindSetByFiling: false`.
  - `None`, `init` and an unknown URL give 404. An `auto:` row gives 400: it is
    a channel by construction, and Monitor channel is how it changes.
  - A sweep doesn't flip a `kindLocked` playlist, whatever its owner counts.
  - Undo doesn't reset a `kindLocked` playlist.
  - Setting `kind: "playlist"` on a row at `sortOrder` 0 or above keeps its
    `sortOrder`, so it reappears in the Playlists list where it was.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** then run `deno task gen:api`. Update with
      `{ silent: true }` so `updatedAt` doesn't move.
- [ ] **Step 4: Add to `tests-db/`.** The End playlist, set to `playlist` by
      hand, is still `playlist` after a sweep.
- [ ] **Step 5: Commit.** `feat(library): set a playlist's kind by hand`.

### Task 3: Undo keeps your removals

**Files:** Modify `src/handlers/filing/store.ts` (`loadUndoCandidates`,
`applyUndo`), `src/handlers/filing/sweep.ts` (`UndoSummary`),
`src/handlers/filing/positions.ts` (the comment only). Tests
`tests/filing_sweep.test.ts`, `tests-db/filing.test.ts`.

A `locked` filing row records something you did, not something the job did, so
undo has no business removing it.

- [ ] **Step 1: Write failing tests.**
  - Undo deletes the filing rows that aren't `locked`, and keeps the locked
    ones as `archive` with a null `playlistUrl`.
  - `UndoSummary` gains `lockedKept`, and `filingRowsRemoved` no longer counts
    them.
  - Sweep, remove a filed video from its channel, sweep, undo, sweep: the
    video is in Archive and locked at the end, with no mapping in the channel.
  - Undo still restores the counts of `playlist_video_mappings` and
    `playlist_metadata`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Correct the `filedPosition` comment: the newest
      video is the most negative, so it sorts first in position order, which
      is what puts filed videos newest first above position 1.
- [ ] **Step 4: Run `deno task test:unit` and `deno task test:db`.** Expected:
      PASS.
- [ ] **Step 5: Commit.** `fix(library): undo keeps the videos you removed`.

### Task 4: Find a creator by name, and filter by upload date

**Files:** Modify `src/middleware/validator.ts` (`LibraryFilterSchema`, the
facets request), `src/handlers/filing/views.ts`, `src/routes/openapi.ts`.
Tests `tests/library_views.test.ts`, `tests-db/library.test.ts`.

**Advisor checkpoint:** before writing the SQL in Step 3.

**Interfaces:**

```ts
interface LibraryFilter {
  // existing fields, plus:
  dateField?: "added" | "uploaded"; // what year and month read. Default "added"
}
// POST /library/facets gains optional { creatorQuery?: string } (1–100 chars).
//   With it, `creators` is the top 50 whose name or key contains the text,
//   case-insensitive. Every other list ignores it.
// The response's `years` and `months` follow filter.dateField.
```

- [ ] **Step 1: Write failing tests** (pure parts).
  - `dateField: "uploaded"` with a year puts the range on `uploadDate`, as
    plain dates with no time zone, and a row with no `uploadDate` is excluded.
  - `dateField` without a year filters nothing, and still switches which
    column `years` counts.
  - An unknown `dateField`, an empty `creatorQuery` and one over 100
    characters give 400.
  - `creatorQuery` of `%`, `_` or `'; DROP TABLE` is matched as text: the
    wildcards are escaped and nothing is concatenated.
  - `creatorQuery` doesn't change `sites`, `years`, `lengths` or `saved`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** then run `deno task gen:api`. `/getsub` and
      `/locate` take `dateField` through the same `buildLibraryFilter`, so
      they need no other change.
- [ ] **Step 4: Add to `tests-db/`.** A creator with one video, outside the
      top 50, is found by name. Uploaded-year counts add up to the rows that
      have an `uploadDate`.
- [ ] **Step 5: Run the full backend check.** Expected: all pass.
- [ ] **Step 6: Commit, advisor checkpoint, open the backend PR.**
      `feat(library): find a creator by name, and filter by upload date`.

### After merging

Regenerated `apiTypes.js` goes to the frontend in its own small PR, as plan 05's
did. Nothing needs running on the Pi: `kindLocked` has a default, and the next
dry run of `filing:run` reports under the new rule.
