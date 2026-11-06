# 05b: Library views implementation plan (frontend)

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first, then "The design" in `05-unlisted-filing.md`. Steps
> use checkboxes.

**Goal:** the Library opens on what's useful. Clips, Archive and Channels each
have a place, and finding an old video takes a filter, not a scroll.

**Architecture:** one more state in the URL. `SubList` keeps rendering every
list, with `view` and filter values added to its `/getsub` request. A new rail
replaces the plain playlist column.

**Tech stack:** React 18, MUI 5, Vitest. **Branch:** `feat/library-views` from
`material`, after plans 02 and 05 merge, because plan 02 edits `Nav`, `App` and
`SubList`. Bring in the regenerated `apiTypes.js`.

## Global constraints

See `README.md`. Every link the bot has sent must keep opening.

## Review focus

1. Filters live in the URL, so reload and Back restore them.
2. `#/unlisted?v=…&vp=342` with no new parameters behaves as it does today.
3. A `v=` that isn't on the filtered page clears the filters, then asks
   `/locate`.
4. Archive opens on Saved. Links only is one tap away, and its count is always
   shown.
5. A filter value is always encoded, whatever characters a site or creator
   contains.

---

### Task 1: Views and filters in the URL

**Files:** Modify `src/router/routes.js`, `src/hooks/useSubListRows.js`,
`src/components/App.jsx`, `src/components/SubList.jsx`. Tests
`tests/desktop/routes.test.js`, `useSubListRows.test.jsx`, `SubList.test.jsx`.

**Interfaces:** `Route` gains `view` (param `view`) and `filter` (params
`saved`, `site`, `y`, `m`, `ch`, `len`). `view` only means something on
`#/unlisted`; `filter` works on any list. `SubList` gains the props `view`,
`filter` and `setFilter`.

- [ ] **Step 1: Write failing tests.**
  - Round trip: `#/unlisted?view=archive&saved=1&site=a.example&y=2026&m=3`, and
    a creator key with `:`, spaces and `'`.
  - `#/playlist/x?view=clips` drops `view`.
  - `#/unlisted?v=https%3A%2F%2Fa&vp=342` still parses as before.
  - Junk values such as `y=abc`, `m=13` and `len=huge` are dropped, and don't
    throw.
  - `useSubListRows` posts `view` and `filter`, and refetches when they change.
  - Changing a filter resets to page 1, with a history entry.
  - A `v=` that isn't on the filtered page clears the filters, then asks
    `/locate`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(library): put views and filters in the URL`.

### Task 2: The rail

**Files:** Create `src/hooks/useLibrarySummary.js`,
`src/components/LibraryRail.jsx`, `src/components/ChannelList.jsx`,
`tests/desktop/LibraryRail.test.jsx`. Modify
`src/components/App.jsx:711-718, 751-753`, `src/components/Nav.jsx` (`Unlisted`
goes to `view=inbox`), `src/components/PlayList.jsx`.

**Interfaces:** `useLibrarySummary({ api })` returns
`{ inbox, bot, clips, archive, all, loading, failed }`. `LibraryRail` renders
the tabs, and wraps `PlayList` (props passed through, plus `kind: "playlist"`)
and `ChannelList`.

- [ ] **Step 1: Write failing tests.**
  - Tabs are `Playlists` and `Channels`. The active tab comes from the route,
    and clicking a tab doesn't navigate.
  - Above both tabs: `Inbox`, `Via bot`, `Clips`, `Archive` and `All unlisted`,
    each with a count. `Archive` goes to `?view=archive&saved=1`.
  - `Channels` posts `kind: "channel"`. A row shows its title and `42 videos`,
    the current one is highlighted, and search filters with a debounce.
  - `Playlists` posts `kind: "playlist"`.
  - Empty and failed states show text.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the mobile slide: tapping a row navigates, and
      the route does the rest.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): rail with views, Channels and Playlists`.

### Task 3: The filter bar

**Files:** Create `src/hooks/useLibraryFacets.js`,
`src/components/LibraryFilters.jsx`, `tests/desktop/LibraryFilters.test.jsx`.
Modify `src/components/SubList.jsx`.

**Interfaces:** `useLibraryFacets({ api, view, filter })` returns
`{ saved, sites, years, months, lengths, creators, loading, failed }`.
`LibraryFilters({ facets, filter, onChange, onClear })`.

- [ ] **Step 1: Write failing tests.**
  - Shown on Unlisted lists: `Saved 283` and `Links only 1,456` as a toggle,
    then menus for `Site`, `Added` (year, then month), `Length` and `Creator`.
  - Each menu lists its options with counts, and hides an option with none.
  - Choosing one calls `onChange`. `Clear` removes them all, and only appears
    when there's something to clear.
  - `Clips` hides `Length`.
  - A failed count request leaves the list working, and hides the menus.
  - On a phone, the bar scrolls sideways and the page doesn't.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Refetch counts when the filter changes, with a
      debounce.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(library): filter by saved, site, time, length and creator`.

### Task 4: Monitor channel, and two fixes filing needs

**Files:** Modify `src/components/SubList.jsx`,
`src/hooks/useSocketEvents.js:471`, `src/components/App.jsx`. Tests
`SubList.test.jsx`, `useSocketEvents.test.jsx`.

- [ ] **Step 1: Write failing tests.**
  - On a channel with a `channelUrl`, `Monitor channel` opens a confirm.
    Confirming posts `/channels/monitor` and navigates to the returned URL.
  - There's no button without a `channelUrl`.
  - **Negative positions:** the "Already downloaded in X at position N" toast
    leaves out the position when it's below 1. A filed video has a negative one.
  - **List position:** a listing event opens its playlist by URL, rather than
    seeking to a page from `sortOrder`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Check the monitoring values against `PlayList.jsx`.
- [ ] **Step 4: Full check, including a browser look.** Run `seed/load.sh`,
      start the backend with its `DB_*` values and the frontend as in
      `AGENTS.md`, and log in as `seed-admin` / `seed-password`. Use
      `playwright-cli` at 1440×900 and 800×1280. Files don't exist for this
      data, so check the lists and filters, not playback.
- [ ] **Step 5: Commit, advisor checkpoint, open the frontend PR.**
      `feat(library): Monitor channel, and filed videos in messages`.
