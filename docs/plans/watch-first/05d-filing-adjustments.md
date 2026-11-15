# 05d: Filing adjustments implementation plan (backend)

> **For agentic workers:** use superpowers:executing-plans inline. Read
> `README.md` first. Steps use checkboxes.

**Goal:** the filing job stops making small channels, folds a job-made channel
into the real one when it appears, and the API gives the left panel the two
things it is missing.

**Architecture:** backend only, all in `src/handlers/filing/` plus one
`/getplay` filter. No new tables.

**Branch:** `fix/filing-adjustments` from `master`, after #145 merges. **Don't
enable the filing job anywhere.** Test against the seed only.

## What the merged backend work is still for

Plans 05 (#140, merged) and 05c (#145, open) were written for the redesign. This
is what each piece does now.

| Piece                                                           | From    | Still needed? | Why                                                                  |
| :-------------------------------------------------------------- | :------ | :------------ | :------------------------------------------------------------------- |
| `video_filing` table, the sweep, `filing:run`, `filing:undo`    | 05      | Yes           | It is the organising.                                                |
| Site, channel and length columns on videos, `facets:backfill`   | 05      | Yes           | The job and the filters both read them.                              |
| `/getsub` with `view` and filters                               | 05      | Yes           | Opens a group in the right panel.                                    |
| `/library/summary`                                              | 05      | Yes           | Counts on the group rows. Needs the Archive split (Task 3).          |
| `/library/facets`, and `creatorQuery`                           | 05, 05c | Yes           | Fills the filter menus.                                              |
| Job-made channels as playlist rows (`auto:` URL, origin `auto`) | 05      | Yes           | They are the channel rows in the left panel.                         |
| `videoCount`, `latestAddedAt`, `channelUrl` on `/getplay` rows  | 05      | Yes           | Count and order of the channel rows.                                 |
| `/channels/monitor`                                             | 05      | Yes           | Setting Watch on a job-made channel. Approved.                       |
| Unlisted sorted newest first                                    | 05      | Yes           | Independent of the redesign.                                         |
| Uploader matched by handle then id, channel-like playlists only | 05c     | Yes           | Stops videos landing in the wrong playlist.                          |
| `dateField` (Added or Uploaded)                                 | 05c     | Yes           | The Added filter uses it.                                            |
| `/getplay` with `kind: "playlist"`                              | 05      | **No**        | It fed the Playlists tab. Harmless, unused.                          |
| The job relabelling your own playlists as kind `channel`        | 05      | **No**        | It fed the Channels tab. Nothing reads it now.                       |
| `POST /playlists/kind`, the `kindLocked` column                 | 05c     | **No**        | They exist to overrule that relabelling.                             |
| Undo keeping the videos you removed (`lockedKept`)              | 05c     | Yes           | Without it, undo then a sweep re-files a video you took out by hand. |
| Inbox view (saved in the last 30 days)                          | 05      | Yes           | The owner said to keep it.                                           |

Nothing from plans 03, 04 or 06 was built, so there is nothing of theirs to
revert.

**What to do about the three "No" rows:**

- `POST /playlists/kind` and `kindLocked` are in #145, which isn't merged.
  Taking them out of #145 before it merges is cheaper than a revert later. That
  is Task 0, and it waits for the owner's yes.
- The relabelling and `kind: "playlist"` are merged. Task 4 turns the
  relabelling off. The `kind` column stays, because job-made channels use it,
  and so does the `kind` filter.
- A playlist still counts as channel-like for matching an uploader. That is
  worked out from its videos on each sweep and never depended on the stored
  label.

## Review focus

1. A sweep on the seed makes no channel with fewer than 5 videos, and a second
   sweep makes no new rows at all.
2. Raising the threshold must not change which of your playlists count as
   channel-like: that test uses its own number.
3. Folding moves mappings and filing rows in one transaction, and a video the
   owner took out of a channel by hand stays out.
4. `filing:undo` still restores everything after a fold.

---

### Task 0: Take the kind override out of #145 (approved 2026-11-15)

**Files:** on `fix/filing-follow-ups`: `src/db/models.ts`,
`src/handlers/filing/{channels,store,sweep}.ts`,
`src/handlers/playlists/index.ts`, `src/middleware/validator.ts`,
`src/routes/{endpoints,openapi}.ts`, `index.ts`, `openapi.json`,
`tests-db/channels.test.ts`, `tests-db/filing.test.ts`.

- [ ] Remove `SetPlaylistKindRequestSchema`, the `/playlists/kind` endpoint,
      `setKind` and `kindLocked`, with their tests. Keep `lockedKept`: it is
      about filing rows, not kinds.
- [ ] `deno task gen:api`, then drop the type from yt-diff-react#135.
- [ ] Full backend check. Push to #145.

### Task 1: A channel needs 5 videos

**Files:** `src/handlers/filing/rules.ts`, `place.ts`,
`docs/plans/watch-first/seed/check.sql`, `seed/README.md`, `tests/` and
`tests-db/filing.test.ts`.

`CHANNEL_MIN_VIDEOS` is used twice: to make a channel (`placeVideos`) and to
judge a playlist channel-like (`isChannelLike`). Only the first changes.

- [ ] **Failing tests.**
      `"filing - four videos from one channel go to
      Archive"`,
      `"filing - five make a channel"`,
      `"filing - an existing
      channel still takes one more video"`,
      `"filing - a playlist with 3 of
      one owner is still channel-like"`.
- [ ] **Implement.** `CHANNEL_MIN_VIDEOS = 5`; add `CHANNEL_LIKE_MIN = 3` and
      use it in `isChannelLike`. Bump `RULES_VERSION` to 3.
- [ ] **Seed.** Update `check.sql` and the totals in `seed/README.md`. The
      channel count on the seed will fall; record the new numbers.
- [ ] **Commit.** `fix(filing): make a channel only at five videos`.

**Open point for the owner:** a job-made channel that exists already, from the
old rule, with 3 or 4 videos. No production sweep has run, so there are none.
The plan leaves existing channels alone.

### Task 2: Fold a job-made channel into the real one

Today a video goes to an existing playlist or channel on the first sweep (rule
1). What's missing is the later case: the job made `auto:<channel>`, and
afterwards you added that channel as a real playlist. The job-made row stays, as
a duplicate.

**Files:** `src/handlers/filing/place.ts`, `sweep.ts`, `store.ts`,
`tests-db/channels.test.ts`.

- [ ] **Failing tests.**
      `"filing - a job-made channel folds into a real
      playlist for the same uploader"`:
      mappings move, filing rows point at the real playlist with placement
      `playlist`, the `auto:` row is gone.
      `"filing - a locked video isn't moved by a fold"`.
      `"filing - undo
      after a fold removes the moved mappings"`.
- [ ] **Implement.** In the sweep, before placing: for each `auto:` playlist,
      run `channelFromUploader` with one of its videos. On a match, reuse what
      `promote` in `channels.ts` does for a merge, inside the playlist create
      lock.
- [ ] **Dry run** on the seed prints `folded: n`.
- [ ] **Commit.** `feat(filing): fold a job-made channel into the real one`.

### Task 3: What the left panel is missing

**Files:** `src/handlers/filing/views.ts`, `channels.ts`,
`src/handlers/playlists/queries.ts`, `src/middleware/validator.ts`,
`src/routes/openapi.ts`, `tests-db/library.test.ts`.

- [ ] **Failing tests.**
      `"library - the summary splits Archive into saved
      and links"`:
      `archiveSaved + archiveLinks === archive`.
      `"playlists - origin auto lists only job-made channels"`, with
      `videoCount`, most videos first.
- [ ] **Implement.** Add `archiveSaved` and `archiveLinks` to `LibrarySummary`.
      Add `origin: "user" | "auto"` (optional) to the `/getplay` request and to
      `playlistKindWhere`. No `origin` is today's behaviour, unchanged.
- [ ] `deno task gen:api`. **Commit.**
      `feat(library): archive split and an origin filter for the left list`.

### Task 4: Stop relabelling your playlists (approved 2026-11-15)

**Files:** `src/handlers/filing/sweep.ts`, `store.ts`, tests.

- [ ] Remove the step that sets `kind: "channel"` and `kindSetByFiling` on user
      playlists. Keep `isChannelLike` for matching.
- [ ] `filing:undo` still resets rows a past sweep relabelled.
- [ ] Add `"filing - a sweep starts no listing"`: the job never indexes a
      channel it made. Only Watch, set by the owner, does.
- [ ] **Commit.** `fix(filing): leave the kind of your own playlists alone`.

### Task 5: Full check and PR

- [ ] `deno task test:unit`, `deno task test:db`, `deno task fmt:check`,
      `deno lint index.ts src/ tests/ scripts/`,
      `deno check index.ts src/ tests/ scripts/`. Judge by exit status.
- [ ] GitNexus `detect_changes`, then PR to `master`, with the regenerated types
      as a frontend PR to `material`.
