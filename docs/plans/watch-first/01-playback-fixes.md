# 01: Playback fixes implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** a file that can't play says so, a stall looks like a stall, and the
player behaves properly on touch.

**Architecture:** frontend only. Recovery rules go in a pure module, and the UI
in small new components beside `VideoPlayer.jsx`.

**Tech stack:** React 18, MUI 5, Vitest. **Branch:** `fix/playback-failures`
from `material` in `frontend/`. **Spec:** `README.md`; findings P1, P3 to P8.

## Global constraints

See `README.md`. `<` and `>` stay as speed. Autoplay never skips past a failed
file without you seeing it.

## Review focus

1. A file that plays for a minute, then hits a decode error at the same spot
   every time, must stop retrying rather than count that minute as success
   forever.
2. A paused video whose signed URL expired still recovers on resume, silently.
3. A tap while controls are hidden reveals them and doesn't pause, even though
   the browser also fires a synthetic `mousemove` before `click`.
4. Leaving fullscreen with Esc or a system gesture updates the icon.
5. With no Media Session support (older browsers), the player still works.

---

### Task 1: One definition of mobile

**Files:** Create `src/hooks/useIsMobile.js`. Modify
`src/components/App.jsx:414-416`, `src/components/VideoPlayer.jsx:137`,
`src/components/PlayerControlBar.jsx`. Test `tests/mobile/VideoPlayer.test.jsx`.

**Interfaces:** Produces `useIsMobile(theme?: Theme): boolean`.

- [ ] **Step 1: Write the failing test.**
      `"a touch tablet wider than sm gets the
      mobile control bar"`: with
      the mobile project's `matchMedia` reporting
      `(hover: none) and (pointer: coarse)` at 900 px wide, the volume button
      acts on tap (single tap opens the overlay), and the play button's computed
      `minWidth` style is `44px`.
- [ ] **Step 2: Run it.**
      `npx vitest run --project mobile tests/mobile/VideoPlayer.test.jsx`.
      Expected: FAIL.
- [ ] **Step 3: Implement `useIsMobile`.** `true` when below the `md` breakpoint
      or when `(hover: none) and (pointer: coarse)` matches. `theme` defaults to
      `useTheme()`; `App` passes `appliedTheme` because it renders above the
      `ThemeProvider`. Use it in both components.
- [ ] **Step 4: Fix the control bar.** When `isMobile`, every `IconButton` gets
      `minWidth: 44, minHeight: 44`. The bar's row of actions gets
      `flexWrap: "wrap"`, so the fullscreen button stays reachable with the
      drawer open.
- [ ] **Step 5: Run the test and both `VideoPlayer` suites.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `fix(player): use one definition of mobile, and real tap targets`.

### Task 2: Stop the retry loop and show a failure screen (P1)

**Files:** Create `src/lib/playbackRecovery.js`,
`src/components/PlaybackFailure.jsx`, `tests/desktop/playbackRecovery.test.js`.
Modify `src/components/VideoPlayer.jsx:580-591`. Test
`tests/desktop/VideoPlayer.test.jsx`.

**Interfaces:**

```js
// state: { retries: number, lastErrorAt: number | null }
initialRecovery(): RecoveryState
onMediaError(state, code, currentTime): { action: "retry" | "fail" | "ignore", state }
onPlaybackAdvanced(state, currentTime): RecoveryState
```

`PlaybackFailure` props:
`{ title, videoUrl, hasNext, onNext, onClose, onTryAnyway? }`.

**Advisor checkpoint:** before Step 3, confirm the rules below still cover
signed-URL expiry on a long pause.

- [ ] **Step 1: Write failing unit tests.**
  - Code 4: first error is `retry`, second is `fail`.
  - Codes 2 and 3: two `retry`, third is `fail`.
  - Code 1 (aborted) and null: `ignore`, with no change to `retries`.
  - `onPlaybackAdvanced` resets `retries` only when
    `currentTime - lastErrorAt >= 10`.
  - An error at 60 s, retry, a resume to 61 s, and an error again is `fail` for
    code 4, with no reset.
- [ ] **Step 2: Run them.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement the module.** No React. Limits are constants:
      `MAX_RETRIES = { 4: 1, 2: 2, 3: 2 }`, `RESET_AFTER_SECONDS = 10`.
- [ ] **Step 4: Write failing component tests in `VideoPlayer.test.jsx`.**
  - `"a file the browser cannot play stops at one retry and says so"`: fire
    `error` with `{ code: 4 }` twice. `/getfile` mints exactly 2 times. Text
    `This browser
    can't play this file` is visible, and no `<video>`
    remains.
  - `"playback that keeps going resets the budget"`: error, retry, `timeUpdate`
    15 s later, error, and a third mint happens.
- [ ] **Step 5: Wire it into `handleError`.** Hold state in a ref, reset when
      `fileName` changes (the effect at `VideoPlayer.jsx:180`), and call
      `onPlaybackAdvanced` from `handleTimeUpdate`. On `fail`, set `failed`
      state and render `PlaybackFailure` in place of the video.
- [ ] **Step 6: Build `PlaybackFailure`.** A centred card on black, in this
      order:
  - Title `This browser can't play this file`, then the video's title.
  - **Download file:** `<a download>` to `videoUrl` with `&inline=true` removed.
  - **Copy stream link:** `navigator.clipboard.writeText` of the absolute URL,
    with a `Copied` confirmation. Fall back to selecting a visible text field if
    the clipboard API is missing (plain HTTP).
  - **Open in VLC:** only when the user agent includes `Android`: `vlc://` +
    URL.
  - **Play next:** only when `hasNext`.
  - **Go back:** `onClose`.
- [ ] **Step 7: Run both test files.** Expected: PASS.
- [ ] **Step 8: Commit.**
      `fix(player): stop re-signing a file that cannot play, and say so`.

### Task 3: Buffering indicator and poster (P3, P4)

**Files:** Modify `src/components/VideoPlayer.jsx:657-698`. Test
`tests/desktop/VideoPlayer.test.jsx`.

- [ ] **Step 1: Write failing tests.**
  - `"a stall shows a spinner and playing clears it"`: `waiting` shows
    `role="progressbar"` with the name `Buffering`, and `playing` removes it.
  - `"the poster is the row's signed thumbnail"`: with
    `items[0].video_metadatum.thumbNailFile = "a.jpg"` and
    `thumbUrls = { "a.jpg": "http://x/thumb" }`, `<video>` has that `poster`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add `isBuffering` state: true on `onWaiting` and
      `onStalled`, false on `onPlaying`, `onCanPlay`, `onSeeked`, and on track
      change. Render the spinner when `(loading && !videoUrl) || isBuffering`,
      wrapped in MUI `Fade` with a 250 ms `transitionDelay`, so short stalls
      don't flash. Derive the poster from `thumbUrls` and the current row; pass
      `undefined` when absent.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**
      `feat(player): show buffering, and start on the thumbnail`.

### Task 4: Fullscreen state and the first tap (P5, P6)

**Files:** Modify `src/components/VideoPlayer.jsx:281-284, 388-396, 745-756`.
Tests: both `VideoPlayer.test.jsx` suites.

- [ ] **Step 1: Write failing tests.**
  - Desktop: `"leaving fullscreen outside the app updates the icon"`: after
    entering, set `document.fullscreenElement = null`, dispatch
    `fullscreenchange`, and the button's label is back to enter-fullscreen.
  - Mobile: `"a tap on hidden controls reveals them without pausing"`: playing,
    with controls auto-hidden using fake timers. Fire `pointerDown`,
    `mouseMove`, `click`. `pause` isn't called and the controls are visible.
  - Mobile: `"a tap on visible controls pauses"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Fullscreen.** Add a `fullscreenchange` listener in an effect
      that sets `isFullscreen` from `document.fullscreenElement`, and remove
      both manual `setIsFullscreen` calls.
- [ ] **Step 4: First tap.** On touch, `mousemove` fires before `click`, so
      reading `showControls` in `onClick` is always true. On the overlay, record
      `showControls` in a ref during `onPointerDown`. In `onClick`, if
      `isMobile` and that ref was false, only reveal controls and restart the
      hide timer; otherwise `togglePlay`.
- [ ] **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `fix(player): track real fullscreen state, and let a tap reveal controls`.

### Task 5: Media Session, shortcuts, Up next (P8)

**Files:** Create `src/hooks/useMediaSession.js`,
`src/components/UpNextOverlay.jsx`. Modify `src/hooks/usePlaylistNavigation.js`,
`src/components/VideoPlayer.jsx:455-498, 524-529`. Test
`tests/desktop/VideoPlayer.test.jsx`.

**Interfaces:**

- `useMediaSession({ title, posterUrl, onPlay, onPause, onPrev, onNext, onSeekBy })`:
  sets `MediaMetadata` and action handlers, clears handlers on unmount, and does
  nothing when `"mediaSession" in navigator` is false.
- `usePlaylistNavigation` additionally returns `nextTitle: string | null` and
  `hasNext: boolean`. `hasNext` is also true when another page exists.
- `UpNextOverlay` props: `{ title, seconds = 5, onPlayNow, onCancel }`.

- [ ] **Step 1: Write failing tests.**
  - `"Media Session actions drive the player"`: stub `navigator.mediaSession`;
    calling the stored `nexttrack` handler calls `openPlayer`.
  - `"no Media Session support is not an error"`: renders with it undefined.
  - `"Shift+N and Shift+P move tracks and do not change speed"`.
  - `"the end of a video counts down, then plays next"`: autoplay on, fire
    `ended`. With fake timers, `Up next` is visible, `openPlayer` isn't called
    at 4 s, and is called at 5 s.
  - `"cancelling Up next stays on this video"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Shortcuts go in the existing `onKeyDown`, matching
      `event.key === "N"` and `"P"`. In `handleVideoEnded`, show the overlay
      when autoplay is on and `hasNext`, instead of calling `handleNext`
      directly. The title may be null at a page boundary; show just `Up next`.
- [ ] **Step 4: Run the whole frontend check.** `npx vitest run`, then
      `npm run lint && npm run typecheck`. Expected: at least 316 tests, all
      passing.
- [ ] **Step 5: Commit.**
      `feat(player): lock-screen controls, track shortcuts and an Up next countdown`.
- [ ] **Step 6: Advisor checkpoint, then open the PR** to `material`.
