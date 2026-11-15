# 05: Unlisted filing implementation plan (backend)

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** a scheduled job gives every Unlisted video a home, so the pile stops
being one 3,430-row list. Nothing is deleted or moved.

**Architecture:** derived columns on `VideoMetadata`, filled at ingest and by a
backfill. A sweep records each video's placement in a new `video_filing` table,
and adds a playlist mapping when the video belongs to a playlist. `None` keeps
every row, so All unlisted still shows everything. Saved or Links only, site,
time and length are query filters, not rows anyone has to look at.

**Tech stack:** Deno, Sequelize, Postgres. **Branch:** `feat/unlisted-filing`
from `master`, once this plan is on `master`, because it brings the test data.
**Frontend:** `05b-library-views.md`. **Data:** `seed/README.md`.
**Follow-ups:** `05c-filing-follow-ups.md` tightens rule 1's uploader match and
changes undo. Where the two differ, 05c is the newer.

## The design

### Where a video goes

The first rule that fits wins. Measured on production, 2026-11-06:

| # | Rule                                             | Goes to         | Videos              |
| - | :----------------------------------------------- | :-------------- | :------------------ |
| 1 | Already in a real playlist                       | That playlist   | 431                 |
| 1 | Uploader matches a playlist URL on the same site | That playlist   | 124                 |
| 2 | Known duration under 2 minutes                   | Clips           | 757                 |
| 3 | At least 3 videos left from this channel         | Its own channel | 379, in 66 channels |
| 4 | Everything else, with a file                     | Archive, Saved  | 283                 |
| 4 | Everything else, without a file                  | Archive, Links  | 1,456               |

- **Clips come before channels** so short posts sweep into one place. It takes
  548 of the 673 rows from the most clip-heavy site, where the median is 26
  seconds, and cuts the new channels from 104 to 66.
- **An unknown duration isn't a clip.** Only 1,376 of 3,430 rows have a
  duration, so the rest go through the channel and Archive rules.
- **Saved and Links only aren't stored.** They're `downloadStatus` at query
  time, so downloading a link moves it without a sweep.

### What you see

| View         | Shows                                                 |
| :----------- | :---------------------------------------------------- |
| Inbox        | Saved in the last 30 days                             |
| Via bot      | Anything with a bot submission                        |
| Clips        | Placement `clip`                                      |
| Archive      | Placement `archive`, or not swept yet. Opens on Saved |
| All unlisted | Every row in `None`                                   |
| Channels     | Playlists of kind `channel`: 195 of yours plus 66 new |
| Playlists    | Your other playlists, about 63                        |

Every Unlisted view takes the same filters: Saved or Links only, site, year and
month added, creator and length. There's no site or time tree.

### What it must never do

- **Delete or move anything.** No file is touched, no `None` mapping is removed,
  and undo removes only what the job added.
- **Write expiry.** It doesn't read or write `retention` or `expiresAt`. The
  reaper still removes an expired bot file and resets the row, and the row stays
  filed.
- **Disturb a monitored playlist.** A filed mapping gets a negative position,
  `-floor(addedAt / 1000)`, and only the job writes negative positions. Scans
  use positions from 1 up, so End's tail stays put, and a listing that finds the
  video moves its row to the real position.
- **Override you.** If you delete a playlist the job filled, or remove a filed
  video from it, that video goes to Archive and stays there.

### What it changes on purpose

A filed mapping is a real mapping, so existing code treats it as one. Each of
these needs a test:

- **Download folder.** `resolveVideoPlaylist` now finds the playlist, so a link
  filed into one downloads into that playlist's folder. An auto-channel's folder
  is the same as Unlisted's, and files already on disk stay where they are.
- **Player links.** `/locate` opens the playlist or channel instead of Unlisted.
  Old bot links still open, because the `None` mapping stays.
- **Reaper.** A video filed into a monitored playlist is skipped, like any
  monitored video. Retention is `persistent` today, so nothing changes yet.
- **Order.** Negative positions sort first, so filed videos sit above position 1
  in a real playlist, newest first.

### Code that has to learn about filed rows

| Code                                | What goes wrong otherwise                                                                           | Fix                                                    |
| :---------------------------------- | :-------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `clearMappingsForReindex`           | A Full or Refresh re-index wipes filed videos from the playlist                                     | Clear only positions of 0 and up                       |
| `/delplay`, `mutations.ts:129-147`  | Deleting an auto-channel (`sortOrder -1`) decrements every real playlist, and the one at 0 vanishes | Decrement only if the deleted `sortOrder` is 0 or more |
| `mergeVideoRecords`, `dedup.ts:417` | Dropping a filed duplicate decrements every real position                                           | Decrement only if the removed position is 1 or more    |
| `findDuplicatePlaylists`            | `auto:` keys aren't URLs                                                                            | Skip them, like `None` and `init`                      |

### Auto-channels

A new channel is a normal playlist row, so every existing screen works:

| Column           | Value               | Why                                                     |
| :--------------- | :------------------ | :------------------------------------------------------ |
| `playlistUrl`    | `auto:<channelKey>` | 43 of 104 candidates had no channel URL                 |
| `kind`, `origin` | `channel`, `auto`   | Puts it in Channels, not Playlists                      |
| `sortOrder`      | `-1`                | Keeps it out of Reindex all and the Playlists list      |
| `monitoringType` | `N/A`               | The scheduler ignores it                                |
| `saveDirectory`  | `""`                | Same folder as Unlisted, and cleanup already refuses it |

**Monitor channel** needs a stored channel URL. It renames the key to the real
URL (the foreign keys cascade), sets `origin` to `user`, and gives it a
`sortOrder`.

## Before you start

Run `seed/load.sh`. It starts a throwaway Postgres on `localhost:55432`, creates
the schema with the app's own code, and loads the data.

## Global constraints

See `README.md`. The rule numbers live in `src/handlers/filing/rules.ts` and
nowhere else: `CLIP_MAX_SECONDS = 120`, `CHANNEL_MIN_VIDEOS = 3`,
`CHANNEL_SHARE = 0.8`, `INBOX_DAYS = 30`.

**Sequelize trap:** `unique: true` on a column adds another constraint on every
boot under `sync({ alter: true })`, as `user_accounts` shows with 228 of them.
Use `primaryKey`, or a named entry in `indexes`.

## Review focus

1. Nothing in this plan issues a delete on a file, a `None` mapping or a video
   row.
2. A second sweep changes nothing, and undo returns the database to its earlier
   counts, including the `kind` it changed.
3. A filter value comes from a request, so a site or channel containing `'` or
   SQL is escaped. A malformed value gets a 400, not a query.
4. A row with no `raw_metadata` still gets a site from its URL, and appears in
   exactly one of Clips, Archive or a playlist.
5. `www.` and `m.` hosts are one site, and the same id on two sites is two
   channels.
6. Old bot links carrying `vp=342` still open the right video.
7. Newest-first paging and `/locate` agree for tied positions, in both sort
   modes.
8. Every row in "Code that has to learn about filed rows" has a test that fails
   without its fix. Search for other `positionInPlaylist` arithmetic too, such
   as `listing-requests.ts:281`.

---

### Task 1: Derive facets

**Files:** Create `src/handlers/filing/facets.ts`, `tests/facets.test.ts`.
Modify `src/handlers/pipeline/dedup.ts:61`: export `coreHostname` and use it for
`site`, so filing and dedup agree on what a site is.

**Interfaces:**

```ts
export interface VideoFacets {
  site: string; // hostname, lowercased, without www. or m.
  siteName: string; // extractor_key, else site. For labels only.
  channelKey: string | null; // "<site>:<lowercased id>"
  channelName: string | null; // channel, else uploader, else uploader_id
  channelUrl: string | null; // channel_url, else uploader_url
  channelHandle: string | null; // uploader_id, lowercased, without a leading @
  uploadDate: string | null; // "YYYY-MM-DD" from upload_date "YYYYMMDD"
  durationSeconds: number | null;
}
export function deriveFacets(
  raw: Record<string, unknown> | null,
  videoUrl: string,
): VideoFacets;
```

**Why the site is the hostname:** 844 Unlisted rows have no `extractor_key`, so
using it would split one site into two groups.

- [ ] **Step 1: Write failing tests.** Id order is `channel_id`, `uploader_id`,
      `uploader_url`, `uploader`, `channel`.
  - `https://www.a.example/v`, `https://m.a.example/v` and `https://a.example/v`
    all give the site `a.example`.
  - An `extractor_key` changes `siteName`, and never `site`.
  - A `channel_id` wins over a differing `uploader_id`, and `channelHandle`
    still comes from `uploader_id`.
  - `@Name` and `name` give the same `channelKey` and `channelHandle`.
  - The same id on two sites gives two keys.
  - `null` raw gives a site from the URL and every other field null.
  - `"NA"`, `""` and whitespace count as missing.
  - Strings over 255 characters truncate, and `channelKey` stays within 250, so
    `auto:<channelKey>` fits the column.
  - A bad `upload_date` gives `null`.
  - `duration` of `"abc"`, `0` or a negative number gives `null`. `119.9` stays
    `119.9`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** A pure function.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): derive site, channel and length from stored metadata`.

### Task 2: Columns, ingest and backfill

**Files:** Modify `src/db/models.ts`,
`src/handlers/pipeline/ingest-chunk.ts:62-76, 366-378`,
`src/handlers/pipeline/types.ts:598`, `deno.json`. Create
`scripts/facets_backfill.ts`. Test `tests/ingest_chunk_persist.test.ts`.

- [ ] **Step 1: Write a failing test.** `"ingest - a video stores its facets"`:
      the upsert data includes `site` and `channelKey`, and `updateOnDuplicate`
      lists all eight.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Eight nullable columns, plus indexes on
      `("site", "channelKey")` and `("durationSeconds")`. Spread
      `deriveFacets(itemData, videoUrl)` beside `raw_metadata: itemData`.
- [ ] **Step 4: Write the backfill.** Use `VideoMetadata.unscoped()`, since the
      default scope excludes `raw_metadata`. Select `site: null`, ordered by
      `videoUrl`, with a cursor on `videoUrl`, batch 500. Update with
      `{ silent: true }` so `updatedAt` doesn't move. Task `facets:backfill`.
      Log totals with and without a channel and a duration. If plan 03 has
      merged, also fill a missing `durationSeconds` from
      `mediaInfo.durationSeconds`, which gives saved files without listing
      metadata a real length.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `feat(library): store facets at ingest, with a backfill`.

### Task 3: Unlisted newest first (L2)

**Files:** Create `src/handlers/playlists/order.ts`,
`tests/playlist_order.test.ts`. Modify
`src/handlers/playlists/queries.ts:174-186`,
`src/handlers/pipeline/locate.ts:129-147`.

**Phase 0a settled this.** Across 3,428 rows, position order never contradicts
`createdAt`. 16 positions are tied, and every tied group shares one `createdAt`.
So position gives newest first, and the id breaks ties. Don't order by
`createdAt`.

**Interfaces:**

```ts
listOrder(playlistUrl: string, sortDownloaded: boolean): Order
rowsBefore(playlistUrl: string, position: number, mappingId: string): WhereOptions
```

Both flip together when `playlistUrl === "None"`. Correct the comments at
`queries.ts:176` and `locate.ts:129`: Unlisted positions are real, and rarely
tie.

- [ ] **Step 1: Write failing tests.**
  - `listOrder("None", false)` is `position DESC, id DESC`.
  - `listOrder("None", true)` is `downloadStatus DESC, position DESC, id DESC`.
  - `listOrder("https://x", false)` is `position ASC, id ASC`, unchanged.
  - `rowsBefore("None", 5, "m")` uses `gt` on position and on id for a tie, and
    a real playlist uses `lt`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the order literal and `beforeMapping`.
      `downloadedFirstIndex` needs no change, because it only uses that helper.
- [ ] **Step 4: Check old links in the code.** `SubList.jsx:419-437` recovers
      when `v=` isn't on the page by asking `/locate`, so `vp=342` lands on the
      right page. Confirm `SubListPlayerRoute.test.jsx` covers this, and add a
      test in the frontend plan if not.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat(unlisted): show newest first`.

### Task 4: Placement rules

**Files:** Create `src/handlers/filing/rules.ts`,
`src/handlers/filing/place.ts`, `tests/filing_place.test.ts`. Modify
`src/db/models.ts`.

**Advisor checkpoint:** before Step 3, to check the rules against "The design".

**Models:**

```ts
// video_filing. One row per swept video. videoUrl is the primary key.
videoUrl: FK video_metadata, CASCADE on update and delete
placement: "playlist" | "channel" | "clip" | "archive"
playlistUrl: FK playlist_metadata, nullable, CASCADE on update, SET NULL on delete

locked: boolean, default false // the sweep leaves it alone
rulesVersion: integer

// playlist_metadata gains:
kind: "playlist" | "channel", default "playlist"
origin: "user" | "auto", default "user"
```

**Interfaces:**

```ts
interface UnlistedRow {
  videoUrl: string; site: string; channelKey: string | null;
  channelName: string | null; channelHandle: string | null;
  durationSeconds: number | null; addedAt: Date;
  realPlaylistUrl: string | null; // from resolveVideoPlaylist's rule
  filing: { placement; playlistUrl: string | null; locked: boolean } | null;
  hasFiledMapping: boolean; // a mapping exists in filing.playlistUrl
}
interface KnownPlaylist {
  playlistUrl: string; site: string; urlSegments: string[]; monitored: boolean;
  createdAt: Date;
}
interface Placement {
  videoUrl: string; placement; playlistUrl: string | null; locked: boolean;
  newChannel?: { key: string; title: string };
}
placeVideos(rows: UnlistedRow[], playlists: KnownPlaylist[]): Placement[]
channelFromHandle(row, playlists): string | null
isChannelLike(counts: Map<string, number>): boolean
```

- [ ] **Step 1: Write failing tests**, one per rule in "The design":
  - A row with `realPlaylistUrl` gets that playlist, even if it's a clip.
  - `@Match-Me` matches `https://match.example/@match-me/videos`, on the same
    site only.
  - A handle of `videos` or `playlist` matches nothing, because those are URL
    words.
  - With two matches, a monitored playlist wins, then the oldest.
  - `119.9` is a clip, and `120` and `null` aren't.
  - 3 clips from one account make 3 clips and no channel.
  - 3 long videos make one channel, 2 long plus 1 clip make Archive.
  - A channel's title is `channelName`, else `channelHandle`.
  - A `null` channel never forms a group.
  - A `clip` or `archive` row is reconsidered, so metadata arriving later can
    move it. A `playlist` or `channel` row stays put.
  - A `locked` row is returned unchanged.
  - `placement: "playlist"` or `"channel"` with a null `playlistUrl`, or with no
    mapping left in that playlist, means you removed it, so it becomes `archive`
    and `locked`.
  - `isChannelLike`: 8 of 10 with one owner is true, 2 of 2 is false (too few),
    and 7 of 10 is false.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pure functions, with the models beside them.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): decide where each Unlisted video belongs`.

### Task 5: The sweep and its commands

**Files:** Create `src/handlers/filing/sweep.ts`, `scripts/filing.ts`,
`tests/filing_sweep.test.ts`. Modify `deno.json`,
`src/handlers/pipeline/listing.ts:565`,
`src/handlers/playlists/mutations.ts:129-147`,
`src/handlers/pipeline/dedup.ts:417-425, 480-500`. Run `impact` on each symbol
first.

**Advisor checkpoint:** before Step 3, because this is the first code that
writes mappings outside a listing.

**Interfaces:**

```ts
interface FilingStore { /* every read and write, injectable as in RetentionStore */ }
interface FilingSummary {
  considered: number; toPlaylist: number; toChannel: number; newChannels: number;
  toClips: number; toArchive: number; unchanged: number; channelLikePlaylists: number;
}
runFilingSweep(
  options: { apply: boolean },
  store?: FilingStore,
): Promise<FilingSummary>
undoFiling(options: { apply: boolean }, store?: FilingStore): Promise<UndoSummary>
```

- [ ] **Step 1: Write failing tests** with a fake store.
  - `apply: false` returns the summary and writes nothing.
  - A filed mapping's position is `-floor(addedAt / 1000)`, and it's never
    positive.
  - A video already in the playlist gets no second mapping.
  - A new channel has the values in "Auto-channels".
  - An existing `auto:` playlist is reused.
  - One failing group is logged, doesn't stop the rest, and its rows stay
    unswept.
  - Undo removes only negative-position mappings, deletes only `origin: "auto"`
    playlists left empty, resets a playlist's `kind`, and doesn't go through
    `/delplay`.
  - Undo keeps a promoted channel.
  - `clearMappingsForReindex` keeps negative positions.
  - Deleting an `auto:` row leaves every other `sortOrder` unchanged.
  - Merging a duplicate with a negative position decrements nothing.
  - `findDuplicatePlaylists` ignores `auto:` keys.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** One transaction per channel or playlist group. Also
      set `kind: "channel"` on user playlists that pass `isChannelLike`, and
      never set it back during a sweep. Stamp `rulesVersion`.
- [ ] **Step 4: Write the commands.** `deno task filing:run` prints the summary
      as a dry run, and `--apply` writes. `deno task filing:undo` works the same
      way.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `feat(library): file Unlisted videos with a dry run and undo`.

### Task 6: Prove it on real Postgres

**Files:** Create `tests-db/filing.test.ts`. Modify `deno.json`.

Add `test:db` to `deno.json`, and add `tests-db/` to `check`, `lint`, `fmt` and
`fmt:check`. Keep it out of `test:unit`, because it needs the database.

- [ ] **Step 1: Write the tests.** Each one starts by reloading with
      `seed/load.sh`.
  - With the edge cases loaded, the totals are 44 in a playlist, 148 clips, 23
    videos in 6 channels, 45 saved and 321 links, 581 in all. That's the pack in
    `seed/README.md` plus the table below.
  - Every Unlisted row has exactly one filing row, and the `None` count doesn't
    change.
  - A second sweep reports everything unchanged.
  - Undo restores the counts of `playlist_video_mappings` and
    `playlist_metadata`.
  - No row in `bot_submissions` changes, including the ones with expiry.
  - The hostile key becomes one channel on `edge.example`, and `video_metadata`
    still exists. `other.example` stays in Archive.
  - The monitored End playlist's `resolveStartIndex` result is the same before
    and after.
  - After a sweep, a listing chunk containing a filed video moves its mapping to
    the real position and creates no second row.
  - `/locate` finds a video in an auto-channel, and in a tied position.
  - A Full re-index of the End playlist keeps its filed video.

  Each edge row's expected placement:

  | Rows                                     | Placement        |
  | :--------------------------------------- | :--------------- |
  | `clips.example`: statuses 1–7            | Clip             |
  | `clips.example`: status 8 (exactly 120s) | Archive, Saved   |
  | `clips.example`: status 9 (bad length)   | Archive, Saved   |
  | `edge.example`: all three hosts          | One channel      |
  | `other.example`: both                    | Archive, Links   |
  | `match.example/v/1`                      | The End playlist |
  | `match.example/v/2` (handle `videos`)    | Archive, Links   |
  | `nodata.example/v/1`, `v/2`              | Archive, Links   |
  | `nodata.example/v/3`, `v/4`              | Archive, Saved   |
  | `nodata.example/tie/1`, `tie/2`          | Archive, Links   |

  The End playlist also becomes kind `channel`, and the mixed playlist doesn't.
- [ ] **Step 2: Run them.** If a count differs from `seed/README.md`, find out
      which rule differs from `check.sql` before changing either. Don't edit the
      number to pass.
- [ ] **Step 3: Commit.** `test(library): prove filing against the data pack`.

### Task 7: Schedule it

**Files:** Modify `src/jobs/index.ts:61-72, 383`, `src/config.ts`,
`docker-compose.yml`, `envs/base.env`, `docs/AUTOMATED_JOBS.md`. Test
`tests/jobs.test.ts`.

- [ ] **Step 1: Write failing tests.** With `FILING_ENABLED` unset, no job is
      built, the same way a disabled bot registers no reaper. When enabled, it
      uses `FILING_INTERVAL`, and a run still in progress makes the next one
      skip.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `jobs.filing` is optional, like `botRetention`.
      Default `FILING_INTERVAL` is `0 3 * * *`, after the 02:00 prune and before
      the 04:00 update. **Add both variables to `docker-compose.yml`,** because
      compose lists the environment one by one. Check with
      `docker compose --env-file <rendered env> config | grep FILING`.
- [ ] **Step 4: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): run filing on a schedule, off by default`.

### Task 8: Views and filters on `/getsub`

**Files:** Create `src/handlers/filing/views.ts`, `tests/library_views.test.ts`.
Modify `src/middleware/validator.ts:118-124`,
`src/handlers/playlists/queries.ts:197-283`, `src/handlers/pipeline/locate.ts`.

**Advisor checkpoint:** before writing the SQL in Step 3.

**Interfaces:**

```ts
type LibraryView = "inbox" | "bot" | "clips" | "archive";
type LengthBand = "clip" | "short" | "medium" | "long" | "unknown";
// clip under 2 min, short under 10, medium under 60, long the rest, unknown null
interface LibraryFilter {
  saved?: boolean; site?: string; year?: number; month?: number;
  channel?: string; length?: LengthBand;
}
parseLibraryRequest(raw: unknown): { view: LibraryView | null; filter: LibraryFilter } | null
buildLibraryFilter(view, filter, now = new Date()): { videoWhere?: WhereOptions; mappingWhere?: WhereOptions }
// POST /getsub gains optional { view?: LibraryView, filter?: LibraryFilter }
```

- [ ] **Step 1: Write failing tests** (pure parts).
  - Each view is valid, and an unknown one gives 400.
  - `month` without `year`, a `month` of 13, and a `site` over 255 characters
    give 400.
  - A filter value of `'; DROP TABLE` produces escaped output, with no raw
    quote.
  - `view` on a real playlist URL is ignored. `filter` applies to any list.
  - `inbox` uses the `now` it's given. The pack's dates are fixed, so tests
    never rely on today's date.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Rules:
  - All four views are scoped to mappings with `playlistUrl = 'None'`.
  - `inbox`: added within `INBOX_DAYS`, and saved.
  - `bot`: `EXISTS` in `bot_submissions` on `canonicalUrl`.
  - `clips`: filing placement `clip`.
  - `archive`: filing placement `archive`, or no filing row yet.
  - `year` and `month` read the mapping's `createdAt` in `config.timeZone`.
  - `saved` reads `downloadStatus`.
  - Use replacements, or `sequelize.escape` inside `literal`. Never concatenate
    input.
  - Include with `required: true` when a filter applies, so `count` is correct.
  - `/locate` takes the same `view` and `filter`.
- [ ] **Step 4: Add to `tests-db/`.** The views and filters return the expected
      rows, Clips and Archive never share a row, and they add up with the
      playlists to the Unlisted total.
- [ ] **Step 5: Run the full backend check.** Expected: all pass.
- [ ] **Step 6: Commit.**
      `feat(library): filter Unlisted by view, site, time and length`.

### Task 9: Counts for the rail and the filter bar

**Files:** Modify `src/handlers/filing/views.ts`, `tests/library_views.test.ts`,
and the five places in `README.md`'s endpoint recipe.

**Interfaces:**

```ts
// POST /library/summary {} →
// { inbox, bot, clips, archive, all, notSwept }
// POST /library/facets { view?, filter? } →
// { saved: { saved, links },
//   sites: [{ site, name, count }],   // name: most common siteName for that site
//   years: [{ year, count }], months: [{ month, count }],  // months only with a year
//   lengths: [{ band, count }], creators: [{ key, name, count }] }  // top 50
```

- [ ] **Step 1: Write failing tests.** Each dimension's counts ignore that
      dimension's own selection, so picking one site still lists the others, and
      they respect every other filter.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** then run `deno task gen:api`.
- [ ] **Step 4: Add to `tests-db/`.** Facet counts add up to the view's total.
- [ ] **Step 5: Commit.** `feat(library): counts for views and filters`.

### Task 10: Channels list and Monitor channel

**Files:** Create `src/handlers/filing/channels.ts`, `tests/channels.test.ts`.
Modify `src/handlers/playlists/queries.ts:86-118`,
`src/handlers/pipeline/listing.ts:466`, and the endpoint recipe's five places.

**Advisor checkpoint:** before Step 3, because this changes a primary key.

**Interfaces:**

```ts
// POST /getplay gains optional { kind?: "playlist" | "channel" }.
//   No kind: today's behaviour, every row with sortOrder >= 0.
//   "playlist": kind playlist, sortOrder >= 0.
//   "channel": kind channel at any sortOrder, excluding None, newest activity first.
//   Rows gain { kind, origin, videoCount, latestAddedAt, channelUrl }.
// POST /channels/monitor { playlistUrl, monitoringType } → { playlistUrl }
```

- [ ] **Step 1: Write failing tests.**
  - Each `kind` returns the rows above, and no `kind` returns today's rows.
  - Monitor on an `auto:` row with a channel URL renames it, moves its mappings
    and filing rows, sets `origin: "user"` and the next `sortOrder`, and starts
    a listing through the normal path.
  - Monitor with no channel URL gives 400.
  - Monitor where a playlist already has that URL moves the mappings into it,
    and removes the empty `auto:` row.
  - **`seekPlaylistListTo` trap:** `listing.ts:466` reports `sortOrder` as a
    page position, which stops being true once Channels and Playlists are
    separate lists. Report the playlist's URL too, so the frontend can open it
    directly.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Serialize the `sortOrder` read with
      `playlistCreateChain`, the lock `createPlaylistRecord` uses, which needs
      exporting. Then run `deno task gen:api`.
- [ ] **Step 4: Add to `tests-db/`.** Renaming cascades to mappings and filing
      rows.
- [ ] **Step 5: Run the full backend check, and `validation/` if the stack
      runs.**
- [ ] **Step 6: Commit, advisor checkpoint, open the backend PR.**
      `feat(library): one list for channels, and Monitor channel`.

### After merging (run on the Pi, by you)

```bash
deno task facets:backfill
deno task filing:run            # dry run. Compare with the table above
deno task filing:run --apply
```

**Optional first:** run `/dedup-unlisted` as a dry run, because 121 same-id
groups are still in the library. It merges rows, and leaves the duplicate's file
on disk.

Then set `FILING_ENABLED=true`, run `make pi5`, and recreate the container.
`deno task filing:undo --apply` reverses it.
