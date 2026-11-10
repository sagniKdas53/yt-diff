# 02: Safe cards, nav and states implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** deleting takes a deliberate step, labels say what they mean,
background work stops moving you, and lists are never just blank.

**Architecture:** frontend only. No API changes.

**Tech stack:** React 18, MUI 5, Vitest. **Branch:** `fix/safe-cards-and-nav`
from `material` in `frontend/`. **Spec:** `README.md`; findings D1 to D15, L3,
L7.

## Global constraints

See `README.md`.

## Review focus

1. A row with no thumbnail and no online thumbnail, or whose remote image fails,
   shows the placeholder rather than a broken image.
2. A `?vs=1` or other unusual page size in an old link must not crash now that 1
   is out of the menu.
3. Adding a playlist from the Add dialog shows a toast with an Open action. It
   doesn't navigate on its own. (My call; see Task 5.)
4. A search that finds nothing, a list still loading, and a truly empty list
   each show different text.
5. Typing a page number outside the range clamps rather than requesting an empty
   page.

---

### Task 1: Card actions (D1, D2, D8)

**Files:** Modify
`src/components/SubListItemCard.jsx:321-345, 368-387, 410-523`,
`src/components/SubList.jsx:863-882`. Test
`tests/desktop/SubListItemCard.test.jsx`.

**Interfaces:** adds the card prop `onArchive(videoUrl: string): void`.
`SubList` implements it with
`queueDownloads([{ url, playlistUrl: loadedPlayList, positionInPlaylist }])`.

- [ ] **Step 1: Write failing tests** (and update tests that find the old
      icons).
  - `"a downloaded card shows no delete button until the menu is open"`: no
    element named `delete downloaded files` until `more actions` is clicked.
  - `"the menu names each action"` for a downloaded row: `Save to this device`,
    `Remove from playlist`, `Delete files`, `Delete from database`.
  - `"an undownloaded card offers Save to archive"`: the button calls
    `onArchive`, and the menu has no `Save to this device` or `Delete files`.
  - `"thumbnails are not dimmed"`: the image has no `opacity: 0.7`.
  - `"the title plays a downloaded video and a small link goes to the source"`.
  - `"keep and fetch-missing items still appear in the menu"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Replace the `ButtonGroup` with `Save to archive` (undownloaded only) and one
    `MoreVert` button labelled `more actions`, using the existing `Menu`.
  - Delete items use `color: "error.main"` and a divider above them. Green stays
    off anything destructive.
  - Remove the opacity rule.
  - The title button calls `onPlay` when downloaded; an `OpenInNew` icon button
    labelled `open source page` keeps the external link.
  - The icon buttons for Fetch missing and Keep become menu items only. The
    chips stay.
- [ ] **Step 4: Make the delete dialog specific.** In `SubListDeleteDialog.jsx`,
      show the video title and, for `Delete files` and `Delete from database`,
      the sentence `This can't be undone.` Add one test.
- [ ] **Step 5: Run the card, `SubList` and dialog tests.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `fix(cards): put deletes behind a menu, and stop dimming what can be watched`.

### Task 2: Nav bar (D4, D5)

**Files:** Modify `src/components/Nav.jsx:123-311, 351-374`. Tests: both
`Nav.test.jsx` suites.

- [ ] **Step 1: Write failing tests.**
  - `"notifications has its own button"`: label `Notifications`, with the unread
    count.
  - `"connection is only mentioned when lost"`: no `Connected` text with a
    connection id; `Offline` chip when empty.
  - `"re-index, theme and logout live in the overflow menu"`.
  - `"re-index hides chunk size until Advanced is open"`, and submitting still
    posts `start`, `stop`, `chunkSize`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Toolbar order: `yt-diff`, `Unlisted`, spacer,
      `Offline` chip when disconnected, `JobDrawer`, Notifications, `MoreVert`.
      Signed out, show only the theme toggle. In the dialog rename fields to
      `From playlist #` and `To playlist #`, keep the same exclusive and
      inclusive numbers, use a text `Cancel` and contained `Re-index`, and put
      `Chunk Size` under an `Advanced` `Accordion`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(nav): separate notifications from connection, and tuck admin actions away`.

### Task 3: Labels, tokens and paging (D3, D9, D10, D15)

**Files:** Modify `src/components/PlayList.jsx:559-567, 608, 671-678`,
`src/components/PlayListItemRow.jsx:136, 150-157`,
`src/components/SubList.jsx:791-830, 940-942`,
`src/components/Pagination.jsx:60`, `src/components/VideoPlayer.jsx:773-796`,
`src/components/PlayerControlBar.jsx:193, 204`,
`src/components/PlayerPlaylistDrawer.jsx:245-247`,
`src/components/SubListItemCard.jsx:359`. Test the matching suites plus
`tests/desktop/Pagination.test.jsx`.

- [ ] **Step 1: Write failing tests.**
  - `"the monitoring column says Auto-update"`, in the header, the row select
    label and the Add dialog.
  - `"the open playlist's button says Open and the row is highlighted"`: no
    `LIST` or `DONE` text.
  - `"both lists say Per page, and page size 1 is gone"`: options are 8, 16, 32,
    64 for videos. Playlists keep their existing 10, 25, 50.
  - `"an unusual page size in the link still renders"`: `rowsPerPage=1` doesn't
    throw.
  - `"the playlist title is visible above the search box"`, and search
    placeholder `Search this list`.
  - `"the sort control says Downloaded first"`.
  - `"past 50 pages, the page control is a number field"`: typing 999 and
    pressing Enter goes to the last page, and 0 goes to the first.
  - Player: `"autoplay has a visible label and an accessible name"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace `#1976d2` and `rgba(25,118,210,…)` with
      `primary.main` and `alpha(theme.palette.primary.main, …)`. The player is
      always dark, so verify contrast by eye on the drawer toggle.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix(ui): say what each control does`.

### Task 4: Layout without JavaScript heights (D14)

**Files:** Modify `src/components/App.jsx:418-437, 428, 676, 692, 705, 750-755`,
`src/components/PlayList.jsx`,
`src/components/SubList.jsx:752-758, 838, 889-937`, `src/style.scss`,
`index.html`. Tests: `App` and list suites.

**Advisor checkpoint:** before starting, because this removes a prop from three
components.

- [ ] **Step 1: Remove `tableContainerHeight` and `fullHeight`.** The root
      becomes a column at `height: 100dvh` (with a `100vh` fallback first).
      Header fixed height, main `flex: 1; min-height: 0`, panels fill it, and
      each scrolling area gets `flex: 1; overflow: auto; min-height: 0`.
- [ ] **Step 2: Handle safe areas and FAB overlap.** Add `viewport-fit=cover` to
      `index.html`. FABs use `bottom: calc(24px + env(safe-area-inset-bottom))`.
      The playlist list gets the same `pb: "88px"` the video list has, on
      mobile.
- [ ] **Step 3: Update tests** that pass the removed prop, then run
      `npx vitest run`. Expected: all pass.
- [ ] **Step 4: Check it in a browser.** Use the `playwright-cli` skill against
      `npm run dev` with mocked or local API at 1440×900, 800×1280 and 390×844. Confirm
      no page scrollbar, pagination visible, and the last list row clear of the
      FAB.
- [ ] **Step 5: Commit.**
      `refactor(layout): size panels with flex and dvh, not resize listeners`.

### Task 5: No background navigation (L3, D12)

**Files:** Modify `src/contexts/NotificationContext.jsx:61-69`,
`src/components/App.jsx:800-825`,
`src/hooks/useSocketEvents.js:206-234, 362-378, 405-410, 439-451`. Tests
`tests/desktop/useSocketEvents.test.jsx`, `App*.test.jsx`.

**Interfaces:**
`setSnack(message, type?, action?: { label: string, onClick: () => void })`.

**My call:** a listing never navigates. The Add dialog also gets a toast with
Open, because socket events can't tell who started a listing.

- [ ] **Step 1: Write failing tests** (and update those expecting navigation).
  - `"a single item finishing does not move you off Unlisted"`: with
    `playListUrlRef` `"None"`, `setPlayListUrl` and `setSubListIndex` aren't
    called, and `setSnack` receives an action labelled `View`.
  - `"a playlist finishing with nothing open offers Open and does not navigate"`.
  - `"a chunk finishing does not navigate"`.
  - `"the first connection is silent, and a reconnect says so"`.
  - `"no connection toast while the player is open"`.
  - `"the snackbar renders and runs the action"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Actions call `setPlayListUrl` when clicked. Add
      `{ push: true }` handling as needed, so a click leaves a history entry
      while nothing else does. Drop `onMobileSlideNeeded`, because the route
      drives the slide.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `fix(sockets): stop moving people when background work finishes`.

### Task 6: Jobs, loading, empty states, thumbnails (D7, D11, D13, L7)

**Files:** Modify `src/components/JobDrawer.jsx:170-195`,
`src/hooks/useJobQueue.js:13`, `src/hooks/useSubListRows.js`,
`src/components/SubList.jsx:837-887`, `src/components/PlayList.jsx`,
`src/components/SubListItemCard.jsx:321-345`. Tests: the matching suites.

**Interfaces:** `useSubListRows` also returns `loading: boolean` and
`failed: boolean`.

- [ ] **Step 1: Write failing tests.**
  - `"queued jobs are one line each, with the reassurance said once"`: 5 queued
    jobs, and `costs nothing` appears once.
  - `"the jobs button summarises"`: `2 downloading · 5 queued`, and a
    `role="status"` region announces a finished job.
  - `"open-drawer polling is 5 seconds"`: `POLL_OPEN_MS === 5000`.
  - `"a loading list shows skeletons"`,
    `"no results says so and names the search"`, and
    `"an empty playlist says so"`.
  - `"a downloaded row waits for its local thumbnail"`: with
    `thumbUrl === null`, no request to `onlineThumbnail` (the image isn't
    rendered).
  - `"a failed image falls back to the placeholder"`: fire `error` on the image.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `Skeleton` cards while
      `loading && items.length === 0`. Empty text: `No videos match "<query>"`
      or `This list is empty`. Card image: when downloaded with a
      `thumbNailFile` and `thumbUrl` not yet a string, show a `Skeleton`; add
      `onError` state that switches to the placeholder.
- [ ] **Step 4: Full check.** `npx vitest run`,
      `npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit.**
      `feat(ui): clearer job list, and real loading and empty states`.
- [ ] **Step 6: Advisor checkpoint, then open the PR** to `material`.
