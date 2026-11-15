# 05b: Unlisted in the left panel implementation plan (frontend)

> **For agentic workers:** use superpowers:executing-plans inline. Read
> `README.md` first, above all "Approved, rejected, open". Steps use checkboxes.

**Goal:** pressing UNLISTED fills the left panel with the Unlisted groups and
job-made channels. Everything else looks and works as it does today.

**Replaces** the rail, tabs and Channels list this file used to describe.

**Architecture:** frontend only. `PlayList.jsx` renders one of two lists. The
right panel is `SubList.jsx` as it is, with filter controls added to its
existing header row in Unlisted mode.

**Branch:** `feat/unlisted-left-panel` from `material` in `frontend/`.
**Needs:** [05d](./05d-filing-adjustments.md) Task 3 merged and its types
regenerated.

## What must not change

- The app opens on the playlists list. Unlisted mode is entered only by the
  UNLISTED button, or by a link that already opens Unlisted.
- The playlists list: columns, Watch, LIST buttons, paging, sorting.
- The card: thumbnail plays, title links to the source, icons under it.
- The UNLISTED button: same place, same label, no count.
- The phone layout, beyond the list contents.
- Every link the bot has sent. `#/unlisted` keeps opening Unlisted.

## Review focus

1. Reload in Unlisted mode with a group open: same mode, same group, same page,
   same filters.
2. Back and forward step between groups and between the two modes.
3. A filter that leaves no videos shows empty text, not a blank panel, and Clear
   brings them back.
4. With the filing job never run (the preview's state before a sweep), the
   groups still list, with Clips, Archive and channels at 0 or absent, and All
   unlisted holding everything.
5. Checked at 1440×900, 800×1280 and 390×844.

---

### Task 1: The mode and the group in the URL

**Files:** `src/router/routes.js`, `src/hooks/usePlaylistNavigation.js`,
`src/components/App.jsx`, `src/components/Nav.jsx`. Tests
`tests/desktop/routes.test.js`, `App*.test.jsx`.

- [ ] **Failing tests.** `"#/unlisted opens Unlisted mode on All unlisted"`,
      `"a group and its filters round-trip through the URL"`,
      `"the
      UNLISTED button toggles the mode and is marked pressed"`,
      `"the app
      opens in playlists mode"`,
      `"an old Unlisted link still opens"`.
- [ ] **Implement.** Add `view` (`inbox`, `bot`, `clips`, `archive`, `all`),
      `saved` (for the Archive split) and the filter values to the route.
      UNLISTED gets `aria-pressed`. Pressing it while in Unlisted mode returns
      to the playlist that was open before.
- [ ] **Commit.** `feat(unlisted): keep the mode and group in the URL`.

### Task 2: The groups list

**Files:** Create `src/components/UnlistedGroups.jsx`,
`src/hooks/useUnlistedGroups.js`. Modify `src/components/PlayList.jsx` to render
it in Unlisted mode. Tests `tests/desktop/UnlistedGroups.test.jsx`.

Rows, in this order, each with its count and the same LIST button the playlist
rows use:

| Row                   | Opens                           | Count from                  |
| :-------------------- | :------------------------------ | :-------------------------- |
| All unlisted          | `/getsub` `view: "all"`         | `summary.all`               |
| Inbox                 | `view: "inbox"`                 | `summary.inbox`             |
| Via bot               | `view: "bot"`                   | `summary.bot`               |
| Clips                 | `view: "clips"`                 | `summary.clips`             |
| Archive · saved       | `view: "archive"`, saved only   | `summary.archiveSaved`      |
| Archive · links only  | `view: "archive"`, links only   | `summary.archiveLinks`      |
| each job-made channel | `/getsub` with its playlist URL | `/getplay` `origin: "auto"` |

- [ ] **Failing tests.**
      `"the groups list shows six groups then the
      channels"`,
      `"each row shows its count"`,
      `"the open row's button is
      the pressed one"` (the same marking
      playlists use today), `"the filter
      box narrows channels by name"`,
      `"channels page like playlists do"`,
      `"a failed summary shows the rows without counts"`.
- [ ] **Implement.** Reuse `PlayListItemRow` styling so the list reads as the
      same table. One request to `/library/summary`, one paged request to
      `/getplay`. Refetch both on the socket events that already refresh the
      playlists list.
- [ ] **Phone.** The same list as the first screen; a row slides in its videos
      through the existing slide.
- [ ] **Commit.** `feat(unlisted): list the groups in the left panel`.

### Task 3: Filters in the header row

**Files:** Modify `src/components/SubList.jsx` (the header row),
`src/hooks/useSubListRows.js`. Create `src/components/UnlistedFilters.jsx`.
Tests `tests/desktop/SubList*.test.jsx`.

The owner asked for the filters to share the row that already holds the
select-all box, the Title box and the sort. No second row.

- [ ] **Failing tests.** `"filters show only in Unlisted mode"`,
      `"choosing
      a site refetches with it and resets to page 1"`,
      `"the creator menu
      searches as you type"` (uses `creatorQuery`),
      `"Added can switch to
      Uploaded"`, `"Clear removes every filter"`,
      `"under 900 px the filters
      collapse to one Filters button"`.
- [ ] **Implement.** Four menus fed by `/library/facets` for the open group. An
      active filter shows its value on the button.
- [ ] **Commit.**
      `feat(unlisted): filter a group by site, date, length and
      creator`.

### Task 4: Full check and PR

- [ ] `npx vitest run`, `npm run lint && npm run typecheck`.
- [ ] Browser check against the seed, after a sweep run with
      `deno task filing:run` on the seed database only.
- [ ] Advisor checkpoint, then PR to `material`.

## Not in this plan

Monitor channel on a channel row, newest-first paging, and Clips playing
straight through. The owner hasn't ruled on them.
