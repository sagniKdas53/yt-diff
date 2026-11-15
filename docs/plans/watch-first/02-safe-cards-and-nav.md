# 02: Approved small fixes implementation plan (frontend)

> **For agentic workers:** use superpowers:executing-plans inline. Read
> `README.md` first, above all "Approved, rejected, open". Steps use checkboxes.

**Goal:** the handful of small changes the owner approved on 2026-11-15, and
nothing else.

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

### Task 3 onward: waiting on the owner

The eight rows under "Open" in `README.md`. Each is one small task once
confirmed. The old text of this plan, in git history at `b51c594`, has the tests
and file ranges for six of them (its Tasks 3, 5 and 6).

### Last task: full check and PR

- [ ] `npx vitest run`, `npm run lint && npm run typecheck`.
- [ ] Browser check at 1440×900, 800×1280 and 390×844 against the seed.
- [ ] PR to `material`.
