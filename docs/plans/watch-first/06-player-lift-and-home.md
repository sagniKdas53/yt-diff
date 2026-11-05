# 06: Player lift and Home implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** the player works anywhere with its own queue, and `#/` is a place to
watch from.

**Architecture:** a small invalidation store replaces `reFetch` strings. The URL
becomes the only owner of the current page. A new `usePlayQueue` frees the
player from `SubList`, and a `PlayerHost` renders it from `App`. Home is then
one screen built on existing data.

**Tech stack:** React 18, `useSyncExternalStore`, Vitest, Deno for one small
column and endpoint. **Branches:** `feat/player-lift` from `material`;
`feat/home-feed` from `master`. **Spec:** `README.md`, "Layouts". Findings A1,
A2, A3, L1, L4, L5, P9.

## Global constraints

See `README.md`. No custom mini-player. This plan has the highest regression
risk, so keep `tests/desktop/SubListPlayerRoute.test.jsx`'s behaviours alive as
they move: Back closes the player, moving tracks replaces history, and pasted
links open.

## Review focus

1. Next past the last row of a window loads more and plays, and skips
   undownloaded rows across window boundaries.
2. Next at the true end of a list stops cleanly, showing the end rather than
   looping or spinning.
3. A bot link to a video that isn't indexed, or was deleted, clears `v=` with a
   message rather than hanging on a spinner.
4. An old `#/?pp=26` link opens the Library on that page, not Home.
5. A download finishing while the player is open doesn't re-render `VideoPlayer`
   (assert by render count), and doesn't reset playback.

---

### Task 1: Invalidation store (A1, A2)

**Files:** Create `src/lib/invalidation.js`,
`tests/desktop/invalidation.test.jsx`. Modify `src/hooks/useSubListRows.js`,
`src/components/PlayList.jsx:82-83, 146, 286, 355`,
`src/hooks/useSocketEvents.js`,
`src/components/App.jsx:378-379, 488-489, 673-674, 690-691`,
`src/components/SubList.jsx:562-564, 595-638`.

**Interfaces:**

```js
invalidate(key: string, { coalesceMs = 0 } = {}): void   // keys: "playlists", "videos:<url>", "collections"
useInvalidationVersion(key: string): number
publishRowPatch(videoUrl: string, fields: object): void
useRowPatches(onPatch: (videoUrl, fields) => void): void
```

- [ ] **Step 1: Write failing tests.**
  - The version bumps only for the key's subscribers.
  - Three coalesced calls bump once, after the delay.
  - Two `publishRowPatch` calls in the same tick both reach `onPatch` (this is
    the batched-download bug A2).
  - `useSubListRows` refetches when `videos:<url>` is invalidated, and not for
    another URL.
  - It applies a row patch without refetching.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with a module-level `Map` and
      `useSyncExternalStore`. Add a `reset()` export for tests.
- [ ] **Step 4: Migrate, deleting as you go.** Remove the `reFetch*` props,
      `setReFetch*`, the tag strings, and the `downloadedItem` ref.
      `useSocketEvents` keeps its batching rule by passing `coalesceMs: 3000`
      during a batch. Downloaded-first sorting invalidates, as `SubList.jsx:597`
      does now.
- [ ] **Step 5: Run `npx vitest run`.** Expected: all pass, after updating tests
      that passed those props.
- [ ] **Step 6: Commit.**
      `refactor(data): replace reFetch strings with keyed invalidation`.

### Task 2: One owner for the page, and quieter renders (A1, A3)

**Files:** Modify `src/components/App.jsx:351-370, 500-546, 800-825`,
`src/components/PlayList.jsx`,
`src/components/SubList.jsx:103-107, 177-186, 660-676`,
`src/hooks/useSocketEvents.js`. Create `src/components/GlobalProgressBar.jsx`,
`src/components/AppSnackbar.jsx`.

**Advisor checkpoint:** before Step 1. This is the riskiest refactor in the set,
so agree which effects can go.

- [ ] **Step 1: Write failing tests.**
  - `"the list page comes only from the route"`: changing `vp` changes `start`
    and `stop` with no extra fetch. One `/getsub` per navigation, asserted by
    call count.
  - `"a stale page past the end shows the last page"`: `vp=999` on a 10-page
    list settles on page 10 with two fetches at most, and no loop.
  - `"progress ticks do not re-render App's children"`: count renders of a
    stubbed `SubList` across 10 `updateActiveDownloads` calls. Expected: 0
    extra.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `subListIndex`, `playListIndex`, their
      effects and their setters. Derive `start`, `stop` and `page` from route
      values. Move the progress bar and snackbar into their own components, and
      subscribe only there. `SubList` reads `activeDownloads` and `queuedItems`
      only for its cards, so split `DownloadContext` into a state and an actions
      context if the render test still fails.
- [ ] **Step 4: Run `npx vitest run`.** Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(routing): the URL alone decides the page`.

### Task 3: `usePlayQueue`

**Files:** Create `src/hooks/usePlayQueue.js`,
`tests/desktop/usePlayQueue.test.jsx`. Backend, on a branch from `master`:
`src/handlers/pipeline/locate.ts` and `LocateRequestBodySchema` gain an optional
`collection` string, using `buildCollectionFilter`.

**Advisor checkpoint:** before Step 3, on the window design.

**Interfaces:**

```js
usePlayQueue({ api, playlistUrl, collection, sortDownloaded, videoUrl, windowSize = 32 }) → {
  current: Row | null, items: Row[], loading: boolean, notFound: boolean,
  hasNext: boolean, hasPrev: boolean,
  nextPlayable(): Promise<Row | null>, prevPlayable(): Promise<Row | null>,
  loadMore(direction: "up" | "down"): Promise<void>,
}
```

- [ ] **Step 1: Write failing tests,** with a fake `api` serving a 100-row list.
  - It calls `/locate` once, then `/getsub` for the window holding the video.
  - `current` matches by `videoUrl`. When `videoUrl` is in the window, no new
    fetch.
  - `nextPlayable` skips undownloaded rows, and loads the next window when it
    runs out.
  - At the true end it returns `null`, and `hasNext` is false.
  - `/locate` with `page: null` sets `notFound`.
  - A stale response from a previous `videoUrl` is ignored.
  - It never touches the route.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep a contiguous `items` array and the offset of
      its first row, so `loadMore` can prepend or append. Patch rows with
      `useRowPatches`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(player): a queue that doesn't depend on the list page`.

### Task 4: `PlayerHost`

**Files:** Create `src/components/PlayerHost.jsx`,
`tests/desktop/PlayerHost.test.jsx` (move the behaviours from
`SubListPlayerRoute.test.jsx`). Modify `src/components/App.jsx`,
`src/components/SubList.jsx:122-139, 170-175, 188-288, 326-460, 734-748, 964-988`,
`src/components/VideoPlayer.jsx:114-134, 244-253`,
`src/components/PlayerPlaylistDrawer.jsx`. Delete
`src/hooks/usePlaylistNavigation.js`.

**Advisor checkpoint:** before Step 2. GitNexus marks this LOW, which
understates it, since 19 props move.

**Interfaces:**

- `PlayerHost()`: reads the route, renders the fullscreen `Dialog` and
  `VideoPlayer` when `videoUrl` is set.
- `VideoPlayer` props become
  `{ row, queue, startAt, onStartAtChange, onClose }`.
- `PlayerPlaylistDrawer` takes `queue`, renders a scrolling list, and calls
  `queue.loadMore` near either end. No page numbers.
- `SubList`'s `onPlay(videoUrl)` just navigates with `{ videoUrl, startAt: 0 }`.

- [ ] **Step 1: Write failing tests.**
  - Everything from `SubListPlayerRoute.test.jsx`, against `PlayerHost`.
  - `"Next at a window edge does not change vp"`: the route's `vp` is unchanged.
  - `"the queue drawer shows rows beyond the list's page"`.
  - `"a finished download does not re-render the player"`: render count (P9).
  - `"a link to a missing video clears v and says so"`.
  - `"the player opens from Home with no SubList mounted"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Delete the player state, `locateLinkVideo`,
      `showPlayer`, `hidePlayer`, `openPlayer` and the location effect from
      `SubList`. `useThumbnailUrls` runs on `queue.items` inside `PlayerHost`.
      Render `PlayerHost` once, at the top of `App`, in the signed-in branch.
- [ ] **Step 4: Run `npx vitest run`, `npm run lint && npm run typecheck`.**
      Expected: all pass.
- [ ] **Step 5: Try it in a browser** with `playwright-cli`: open a video, Next
      through a page boundary, Back closes the player, reload resumes, and a
      pasted link opens.
- [ ] **Step 6: Commit.** `feat(player): host the player at the app level`.

### Task 5: Home and Library routes

**Files:** Modify `src/router/routes.js`, `src/router/RouterProvider.jsx`,
`src/components/App.jsx`, `src/components/Nav.jsx`,
`src/hooks/useSocketEvents.js`. Test `tests/desktop/routes.test.js`,
`AppRouting.test.jsx`, `tests/mobile/AppRouting.test.jsx`.

**Requires the owner's approval of the layouts in `README.md`.** If that isn't
recorded there as approved, stop and ask.

**Advisor checkpoint:** before Step 3, because the routing grammar is changing.

**Interfaces:** `Route` gains `view: "home" | "library"`. `playlistUrl` stays
`NO_PLAYLIST` for both.

- [ ] **Step 1: Write failing tests.**
  - `#/` and an empty hash are `view: "home"`.
  - `#/library` is `view: "library"`, and round-trips with `pp` and `ps`.
  - `#/?pp=26` is `view: "library"`, page 26, and formats back to
    `#/library?pp=26`.
  - `#/unlisted`, `#/playlist/x`, with any of `v`, `t`, `vp`, `vs`, `c`, are
    unchanged, `view: "library"`.
  - A malformed location is Home.
  - Desktop: `#/library` replaces itself with `#/unlisted?c=inbox`. Mobile: it
    stays and shows the rail.
  - Nav shows `Home` and `Library`, replacing `Unlisted`.
  - `clearList` and the mobile back arrow go to `#/library`.
  - A listing finishing on Home doesn't navigate.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `listIsOpen` logic in `formatRoute` stays. Update
      the grammar comment at the top of `routes.js`, and the `init` checks that
      remain.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(routing): Home at #/, and the two-panel view at #/library`.

### Task 6: Home screen

**Backend files:** Modify `src/db/models.ts` (`downloadedAt` DATE null),
`src/handlers/pipeline/download.ts` (set beside `downloadStatus: true`),
`scripts/facets_backfill.ts` (fill null from `updatedAt` for downloaded rows),
plus an endpoint by the README recipe. Test `tests/recent.test.ts`.

**Frontend files:** Create `src/components/Home.jsx`,
`src/components/WatchCard.jsx`, `src/hooks/useHomeFeed.js`,
`tests/desktop/Home.test.jsx`, `tests/mobile/Home.test.jsx`. Modify
`src/components/App.jsx`.

**Interfaces:** `POST /recent { limit? (default 24, max 60) }` returns
`{ items: [{ videoUrl, playlistUrl, downloadedAt, video: {…same as /continue…} }] }`.
`useHomeFeed()` returns
`{ continue: Item[], recent: Item[], collections: Row[], loading, failed }`.

- [ ] **Step 1: Write failing backend tests,** then implement `/recent`.
      Downloaded only, newest `downloadedAt` first, null last, with `limit`
      capped at 60. Run `deno task gen:api`.
- [ ] **Step 2: Write failing frontend tests.**
  - Rails render in order: `Continue watching`, `Recently saved`,
    `Channels and playlists with new videos`.
  - Empty sections are hidden, and an empty library shows one line with an Add
    button.
  - One failing request hides only its section.
  - A card's click navigates to `#/unlisted?v=…` or `#/playlist/<url>?v=…` from
    its `playlistUrl`, and a continue card adds `t=`.
  - A card has no delete or manage control. It shows the progress bar and
    `12m left`.
  - A collection card goes to `#/unlisted?c=<key>`.
  - `"search treats what you type as text"`: `a+b(` posts `query` with regex
    characters escaped under `global:`, and doesn't throw on invalid regex.
  - Mobile: rails scroll horizontally, and the page has no sideways scroll.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.** Follow the Home layout in `README.md`.
      `Search everything…` shows results inline as `WatchCard`s (limit 24) with
      a 400 ms debounce. Use `useThumbnailUrls` by mapping items into its row
      shape. Refresh when `collections` or `videos:*` is invalidated, and on
      window focus.
- [ ] **Step 5: Full check and a browser look.** Backend and frontend suites,
      lint, typecheck, then `playwright-cli` screenshots of Home and Library at
      1440×900 and 800×1280.
- [ ] **Step 6: Commit, advisor checkpoint, open both PRs.**
      `feat(home): a place to watch from`.

### After merging

Run `deno task facets:backfill` once more on the Pi, to fill `downloadedAt`,
then update `docs/VIDEO_PLAYER.md` and `docs/API_ENDPOINTS.md`.
