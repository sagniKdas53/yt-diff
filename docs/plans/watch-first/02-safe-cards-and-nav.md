# 02: Approved small fixes implementation plan (frontend)

> **For agentic workers:** use superpowers:executing-plans inline. Read
> `README.md` first, above all "Approved, rejected, open". Steps use checkboxes.

**Goal:** the small changes the owner approved on 2026-11-15, and nothing else.

**Cut on 2026-11-15:** this plan used to move card actions into a menu, rebuild
the nav, rename Watch and make titles play. The owner rejected all four. Don't
bring them back.

**Architecture:** frontend only. No API changes.

**Branch:** `fix/approved-small-fixes` from `material` in `frontend/`, after
[05b](./05b-library-views.md) merges: both edit `SubList.jsx` and
`SubListItemCard.jsx`.

## Review focus

1. The download icon on a saved video still downloads the file to the device.
   Only a video with no file changes behaviour.
2. Clicking it twice doesn't queue two downloads.
3. Nothing else on the card moved, and the title still opens the source.

---

### Task 1: The download icon queues a video that has no file

Today the icon under a card downloads the saved file to your device, and is
greyed out when there is no file. To fetch a video you tick it and use the
Download button in the header. The owner asked for the icon to queue it.

**Files:** `src/components/SubListItemCard.jsx:459-475`,
`src/components/SubList.jsx:881`. Tests
`tests/desktop/SubListItemCard.test.jsx`.

- [ ] **Failing tests.** `"a saved video's icon downloads the file"` (as now).
      `"a video with no file queues a download"`: one `POST /download` with that
      video and the open playlist.
      `"the icon is disabled while
      that video is queued or downloading"`.
      `"the tooltip says Queue
      download when there is no file"`.
- [ ] **Implement.** Reuse the request the header's Download button sends, for
      one video. The icon is the outline cloud-download while there is no file,
      in the normal icon colour so it reads as pressable.
- [ ] **Commit.** `feat(cards): queue a download from the card`.

### Task 2: Stop dimming downloaded thumbnails

**Files:** `src/components/SubListItemCard.jsx:342`. Test the same suite.

- [ ] **Failing test.**
      `"a downloaded video's thumbnail is at full
      opacity"`.
- [ ] **Implement.** Remove the 0.7 opacity. The play button over it stays, and
      is what tells a saved video from a link.
- [ ] **Commit.** `fix(cards): show downloaded thumbnails at full strength`.

### Task 3: Delete dialog, open row, paging labels

**Files:** `src/components/SubListDeleteDialog.jsx`,
`src/components/PlayList.jsx`, `src/components/PlayListItemRow.jsx`,
`src/components/SubList.jsx`, `src/components/Pagination.jsx`. Tests: the
matching suites.

- [ ] **Failing tests.** `"the delete dialog names the video"`,
      `"it says
      this can't be undone when the row or the file goes"`.
      `"the open
      playlist's row is highlighted and its button says Open"`.
      `"both lists
      say Per page, and page size 1 is gone"`.
      `"an unusual page size in an
      old link still renders"`.
      `"past 50 pages, the page control is a
      number field"`: 999 goes to
      the last page, 0 to the first.
- [ ] **Implement.** Watch, LIST and everything else in the playlists list stay
      as they are. No title above the videos: the search box already shows the
      playlist's name.
- [ ] **Commit.** `fix(ui): name what is deleted, mark the open row`.

### Task 4: Nothing moves you by itself, quieter connection status

**Files:** `src/contexts/NotificationContext.jsx`, `src/components/App.jsx`,
`src/hooks/useSocketEvents.js`. Tests `tests/desktop/useSocketEvents.test.jsx`,
`App*.test.jsx`.

**Interface:**
`setSnack(message, type?, action?: { label: string, onClick: () => void })`.

- [ ] **Failing tests** (and update the ones that expect navigation).
      `"a
      single item finishing does not move you off Unlisted"`: the
      toast has an action labelled Open.
      `"a playlist finishing with nothing open
      offers Open and does not navigate"`.
      `"a chunk finishing does not
      navigate"`.
      `"the first connection is silent, and a reconnect says
      so"`.
      `"no connection toast while the player is open"`.
- [ ] **Implement.** The action calls `setPlayListUrl` when clicked.
- [ ] **Commit.**
      `fix(sockets): stop moving people when background work
      finishes`.

### Task 5: Loading and empty states

**Files:** `src/hooks/useSubListRows.js`, `src/components/SubList.jsx`,
`src/components/PlayList.jsx`, `src/components/SubListItemCard.jsx`.

**Interface:** `useSubListRows` also returns `loading` and `failed`.

- [ ] **Failing tests.** `"a loading list shows skeletons"`,
      `"no results
      says so and names the search"`,
      `"an empty playlist says so"`,
      `"a
      downloaded row waits for its local thumbnail"`,
      `"a failed image falls
      back to the placeholder"`.
- [ ] **Implement**, then **commit.**
      `feat(ui): real loading and empty
      states`.

The downloads drawer summary is approved too, and is built in
[07](./07-download-queue.md), which redoes the drawer.

### Last task: full check and PR

- [ ] `npx vitest run`, `npm run lint && npm run typecheck`.
- [ ] Browser check at 1440×900, 800×1280 and 390×844 against the seed.
- [ ] PR to `material`.
