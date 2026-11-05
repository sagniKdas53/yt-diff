# 05: Auto-collections implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** Unlisted stops being a 3,000-row list. It organizes itself by channel,
with small channels rolled up per site, plus an Inbox of what's recent and
unfinished.

**Architecture:** derived columns on `VideoMetadata`, filled from `raw_metadata`
by a backfill and at ingest. `None` stays the storage, with no change to
mappings or folders. Collections are computed by query, and viewed through the
same `/getsub` and `SubList` as today.

**Tech stack:** Deno, Sequelize, Postgres, React. **Branches:**
`feat/auto-collections` from `master`; `feat/library-channels` from `material`.
**Spec:** `README.md`, "How the pile disappears".

## Before you start

Paste the output of the Phase 0a queries from the review (run on the Pi) into
the session.

**Advisor checkpoint:** look at the coverage numbers. If most rows have no
usable channel, or one "Other" group is enormous, adjust `deriveFacets` or the
rollup before writing code.

## Global constraints

See `README.md`. Don't move files, and don't write to mappings.
`COLLECTION_MIN_VIDEOS = 3` and `INBOX_DAYS = 30` are constants in one file.

## Review focus

1. A collection key comes from the URL, so a site or channel containing `'` or
   SQL must be safely escaped. A malformed key gets a 400, not a query.
2. A video with no channel information still appears, under "Other from <site>",
   and a row with no `raw_metadata` still gets a site from its URL.
3. A channel crossing the threshold moves from "Other" to its own row, and each
   video appears in exactly one group.
4. Old bot links carrying `vp=342` still open the right video after the order
   flips.
5. Newest-first paging and `/locate` agree for tied positions, in both sort
   modes.

---

### Task 1: Derive facets

**Files:** Create `src/handlers/pipeline/facets.ts`, `tests/facets.test.ts`.

**Interfaces:**

```ts
export interface VideoFacets {
  site: string; // extractor_key, else extractor, else URL hostname
  channelKey: string | null; // "<site lowercased>:<id>"
  channelName: string | null; // channel, else uploader, else uploader_id
  channelUrl: string | null; // channel_url, else uploader_url
  uploadDate: string | null; // "YYYY-MM-DD" from upload_date "YYYYMMDD"
  durationSeconds: number | null;
}
export function deriveFacets(
  raw: Record<string, unknown> | null,
  videoUrl: string,
): VideoFacets;
```

- [ ] **Step 1: Write failing tests.** Id order is `channel_id`, then
      `uploader_id`, then `uploader_url`, then `uploader`, then `channel`.
  - YouTube with `channel_id` uses it, ignoring a differing `uploader_id`.
  - An X post with `uploader_id` only uses that, with `channelName` from
    `uploader`.
  - Same id on two sites gives two keys.
  - `null` raw gives `site` from the hostname and every other field null.
  - The strings `"NA"`, `""`, and whitespace count as missing.
  - Strings over 255 characters truncate.
  - A bad `upload_date` gives `null`. `duration: "abc"` gives `null`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** A pure function. Lowercase the id too, so `@Name`
      and `@name` match.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): derive site and channel from stored metadata`.

### Task 2: Columns, ingest and backfill

**Files:** Modify `src/db/models.ts`,
`src/handlers/pipeline/ingest-chunk.ts:62-76, 366-378`,
`src/handlers/pipeline/types.ts:598`, `deno.json`. Create
`scripts/facets_backfill.ts`. Test `tests/ingest_chunk_persist.test.ts`.

- [ ] **Step 1: Write a failing test.** `"ingest - a video stores its facets"`:
      the upsert data includes `site` and `channelKey`, and `updateOnDuplicate`
      lists all six.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Six nullable columns, plus index
      `("site", "channelKey")`. Spread `deriveFacets(itemData, videoUrl)` beside
      `raw_metadata: itemData`.
- [ ] **Step 4: Write the backfill.** Use `VideoMetadata.unscoped()`, since the
      default scope excludes `raw_metadata`. Select `site: null`, ordered by
      `videoUrl`, with a cursor on `videoUrl`, batch 500. Update with
      `{ silent: true }` so `updatedAt` doesn't move. Task `facets:backfill`.
      Log totals of rows with and without a channel.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `feat(library): store facets at ingest, with a backfill`.

### Task 3: Unlisted newest first (L2)

**Files:** Create `src/handlers/playlists/order.ts`,
`tests/playlist_order.test.ts`. Modify
`src/handlers/playlists/queries.ts:174-186`,
`src/handlers/pipeline/locate.ts:129-147`.

**Interfaces:**

```ts
listOrder(playlistUrl: string, sortDownloaded: boolean): Order
rowsBefore(playlistUrl: string, position: number, mappingId: string): WhereOptions
```

Both flip together when `playlistUrl === "None"`. **Correct the comments** at
`queries.ts:176` and `locate.ts:129` to match what Phase 0a's third query showed
about tied positions.

**If that query shows ties,** position can't give newest first, because tied
rows would fall back to random UUID order. In that case, for `None` only, both
helpers order and compare on the mapping's `createdAt DESC, id DESC` instead,
and the tests below change to match.

- [ ] **Step 1: Write failing tests.**
  - `listOrder("None", false)` is `position DESC, id DESC`.
  - `listOrder("None", true)` is `downloadStatus DESC, position DESC, id DESC`.
  - `listOrder("https://x", false)` is `position ASC, id ASC`, unchanged.
  - `rowsBefore("None", 5, "m")` uses `gt` on position and on id for a tie, and
    a real playlist uses `lt`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the order literal and `beforeMapping`.
      `downloadedFirstIndex` needs no change, because it only uses that helper.
- [ ] **Step 4: Check old links by hand in the code.** `SubList.jsx:419-437`
      already recovers when `v=` isn't on the page: it asks `/locate`. `vp=342`
      then lands on the right page. Confirm the existing test in
      `SubListPlayerRoute.test.jsx` covers this, and add one if not.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat(unlisted): show newest first`.

### Task 4: Collections API

**Files:** Create `src/handlers/collections.ts`, `tests/collections.test.ts`.
Modify `src/middleware/validator.ts:118-124`, `src/routes/endpoints.ts`,
`src/routes/openapi.ts`, `index.ts`,
`src/handlers/playlists/queries.ts:197-283`.

**Advisor checkpoint:** before writing the SQL in Step 3.

**Interfaces:**

```ts
type CollectionKey = "inbox" | "bot" | `channel:${string}` | `other:${string}`;
parseCollectionKey(raw: string): ParsedCollection | null
buildCollectionFilter(parsed, userId?: string): { videoWhere?: WhereOptions, mappingWhere?: WhereOptions }
// POST /collections { start?, stop?, query? } →
// { count, summary: { inbox, bot, all },
//   rows: [{ key, kind: "channel" | "other", title, site, videoCount, downloadedCount,
//            latestAddedAt, channelUrl,
//            cover: { saveDirectory, thumbNailFile, onlineThumbnail } | null }] }
// POST /getsub gains optional { collection?: string, hideWatched?: boolean }
```

- [ ] **Step 1: Write failing tests** (pure parts).
  - `parseCollectionKey`: `inbox`, `bot`, `channel:youtube:abc`, `other:Youtube`
    are valid. `""`, `channel:`, `other:`, `nonsense`, and over 600 characters
    are `null`.
  - `buildCollectionFilter` for a key containing `'; DROP TABLE` produces
    escaped output, with no raw quote.
  - `/getsub` with a bad `collection` gives 400.
  - `/getsub` with `collection` on a real playlist URL ignores it.
  - `inbox` needs a user; with no `userId` it doesn't exclude by progress.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Rules:
  - Scope is mappings with `playlistUrl = 'None'`.
  - Group by `(site, channelKey)`. `channelKey` not null with
    `count >= COLLECTION_MIN_VIDEOS` is its own `channel:<key>` row, and all
    else is `other:<site>`.
  - Sort by `latestAddedAt DESC` (mapping `createdAt`), then key.
  - Cover: newest downloaded row with a thumbnail, by `LATERAL` or
    `DISTINCT ON`.
  - `other:<site>` filter: that site, and `channelKey` null or not in the set of
    big channels.
  - `channel:<key>` filter: `channelKey = key`.
  - `inbox`: mapping `createdAt` within `INBOX_DAYS`, downloaded, and no
    finished `watch_progress` for this user (`NOT EXISTS`).
  - `bot`: `EXISTS` in `video_owner` with `source = 'bot'`.
  - `hideWatched`: the same `NOT EXISTS`.
  - Use replacements, or `sequelize.escape` inside `literal`; never concatenate
    input.
  - Include `required: true` when a collection applies, so `count` is correct.
- [ ] **Step 4: Prove the SQL against real Postgres.** Add to
      `validation/api_test_e2e.ts` if the isolated stack runs (`AGENTS.md`),
      with: 3 videos in a channel becomes a channel row; 2 becomes Other; each
      group's rows sum to the Unlisted total; a key with a quote returns nothing
      and no error. If the stack won't run, say so and **stop for an advisor
      checkpoint**.
- [ ] **Step 5: Run `deno task gen:api`, then the full backend check.**
      Expected: all pass.
- [ ] **Step 6: Commit, open the backend PR.**
      `feat(library): group Unlisted by channel automatically`.

### Task 5: Route and list filter (frontend)

**Files:** Modify `src/router/routes.js`, `src/hooks/useSubListRows.js`,
`src/components/App.jsx`, `src/components/SubList.jsx`. Tests
`tests/desktop/routes.test.js`, `useSubListRows.test.jsx`, `SubList.test.jsx`.

**Interfaces:** `Route` gains `collection: string | null` (param `c`), only
meaningful on `#/unlisted`. `SubList` gains the props `collection`,
`hideWatched`, `setHideWatched`.

- [ ] **Step 1: Write failing tests.**
  - Round trip: `#/unlisted?c=inbox` and a key with `:` and spaces.
    `#/playlist/x?c=inbox` drops `c`. `#/unlisted?v=https%3A%2F%2Fa&vp=342`
    still parses as before.
  - `useSubListRows` posts `collection` and `hideWatched`, and refetches when
    they change.
  - Changing collection resets to page 1, with a history entry.
  - A `v=` with `c=` that isn't on the page clears `c`, then asks `/locate`.
  - Header shows the channel title and count, and has the `Hide watched` switch
    (remembered in `localStorage`, try/catch around it).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Bring in the regenerated `apiTypes.js`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(library): open a collection from the URL`.

### Task 6: Channels tab (frontend)

**Files:** Create `src/hooks/useCollections.js`,
`src/components/CollectionList.jsx`, `src/components/LibraryRail.jsx`,
`tests/desktop/CollectionList.test.jsx`. Modify
`src/components/App.jsx:711-718, 751-753`, `src/components/Nav.jsx` (`Unlisted`
goes to `c=inbox`), `src/components/SubList.jsx`.

**Interfaces:** `useCollections({ api, query, start, stop })` returns
`{ rows, count, summary, loading, failed }`. `LibraryRail` renders tabs and
wraps `PlayList` (props passed through) and `CollectionList`.

- [ ] **Step 1: Write failing tests.**
  - Tabs: `Playlists` and `Channels`. The active tab comes from the route:
    `None` is Channels, a playlist is Playlists, and clicking a tab doesn't
    navigate.
  - Pinned rows above the list: `Inbox`, `Via bot`, `All unlisted`, each with a
    count, going to `?c=inbox`, `?c=bot` and no `c`.
  - A row shows cover, title and `42 videos`, and the current one is
    highlighted.
  - `Other from X` rows are visually grouped last only by sort; no special
    ordering.
  - Search filters, with debounce. Empty and failed states show text.
  - `"Monitor channel asks first and posts /list"`: on a channel collection with
    `channelUrl`, the button opens a confirm, and confirming posts
    `{ urlList: [channelUrl], monitoringType: "Full" }`.
  - No button without a `channelUrl`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `useThumbnailUrls` for covers by mapping rows
      into its `video_metadatum` shape. Keep the mobile slide: tapping a row
      navigates, and the route does the rest. Check `"Full"` against the
      monitoring values in `PlayList.jsx`.
- [ ] **Step 4: Full check, including a browser look** with `playwright-cli` at
      1440×900 and 800×1280.
- [ ] **Step 5: Commit, advisor checkpoint, open the frontend PR.**
      `feat(library): Channels tab, Inbox and Via bot`.

### After merging (run on the Pi, by you)

```bash
deno task facets:backfill
```
