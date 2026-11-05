# 03: Formats and media info implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** new MKVs become MP4 with no quality change, existing ones can be
converted safely, and the player knows before loading when a browser can't play
a file.

**Architecture:** yt-dlp format choice is untouched. A new `mediaInfo` column is
filled by `ffprobe` beside chapters, with a backfill. The client checks it with
`MediaCapabilities`.

**Tech stack:** Deno, Sequelize, yt-dlp, ffmpeg, React. **Branches:**
`feat/media-info` from `master`, and `feat/playability-check` from `material` in
`frontend/`. **Spec:** `README.md`; findings P2, P10.

## Global constraints

See `README.md`. **No `-f` or `-S`.** Never delete a source file until its
replacement is verified and the row is updated.

## Tested facts

Run against yt-dlp 2026.06.09 with a real VP9 and AAC download:

- `--remux-video "mkv>mp4"` writes an `.mp4` with both streams copied.
- The existing `post_process:"fileName:…"` print **still says `.mkv`** after the
  remux. Trusting it would store a file name that doesn't exist.
- `after_move:"fileName:…"` says `.mp4`. It prints later, and the parser at
  `download.ts:603-606` overwrites on each match, so the last print wins.
- `--merge-output-format mp4/webm/mkv` doesn't prevent VP9 and AAC becoming MKV,
  so it isn't used.

## Review focus

1. A remux that fails (a codec MP4 can't hold) must leave a working `.mkv`
   download, not a failed download or a row pointing at nothing.
2. A cancel during download still deletes its partials. `before_dl:filePath`
   keeps naming the `.mkv`, which is what the partials are called.
3. The backfill re-run on a library with missing files logs and carries on.
4. An MKV conversion interrupted halfway leaves the original untouched and the
   row correct, and a re-run finishes the job.
5. A `null` `mediaInfo` (not backfilled yet) is treated as "unknown" and just
   tries to play. Only a definite "unsupported" stops playback, and there's
   always `Try anyway`.

---

### Task 1: Remux MKV to MP4 on download

**Files:** Modify `src/handlers/pipeline/types.ts:118-141`. Test
`tests/download_flow.test.ts`.

**Advisor checkpoint:** before Step 3, because this is on the download path.

- [ ] **Step 1: Write failing tests**, with the existing fake yt-dlp helper
      (line 191).
  - `"download - the file name after the remux wins"`: the script writes
    `v.mp4`, prints `post_process:"fileName:v.mkv"` and then
    `after_move:"fileName:v.mp4"`, exit 0. Expect `status: "success"`, stored
    `fileName: "v.mp4"`.
  - `"download - a failed remux keeps the original"`: the script writes `v.mkv`,
    prints only `post_process:"fileName:v.mkv"`, and exits 1. Expect success
    with `v.mkv`.
  - `"downloadOptions asks for the remux and both prints"`: contains
    `--remux-video`, `mkv>mp4`, and an `after_move:` print. `extrasOnlyOptions`
    has neither `--remux-video` nor an `after_move:` print.
- [ ] **Step 2: Run them.** `deno test --allow-all tests/download_flow.test.ts`.
      Expected: the first and third fail.
- [ ] **Step 3: Implement.** Add to `downloadOptions`, not `sidecarOptions`:
      `"--remux-video", "mkv>mp4"`, and `"--print"`, then the same `fileName:`
      template with `after_move:`. Keep the `post_process` print for the extras
      path and the failed-remux case. If the `ytdlpSleepRequests` splice at line
      145 relies on array position, keep the progress template last.
- [ ] **Step 4: Verify on a real file.** In a temp directory:
      `venv/bin/yt-dlp -f "bv[vcodec^=vp]+ba[ext=m4a]" --remux-video "mkv>mp4" --print 'after_move:"fileName:%(id)s.%(ext)s"' -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=jNQXAC9IVRw"`.
      Expected: prints `.mp4`, and `ffprobe` shows `vp9` and `aac`.
- [ ] **Step 5: Run `deno task test:unit`.** Expected: all pass.
- [ ] **Step 6: Commit.**
      `feat(download): remux MKV to MP4 losslessly, and read the final file name`.

### Task 2: Record media info

**Files:** Create `src/handlers/pipeline/mediaInfo.ts`,
`tests/media_info.test.ts`, `tests/fixtures/ffprobe-streams.json` (capture from
a real file with `ffprobe -v error -show_streams -show_format -of json <file>`).
Modify `src/handlers/pipeline/chapters.ts` (export `RunCommand`'s default as
`defaultRun`), `src/db/models.ts`, `src/handlers/pipeline/download.ts:756-763`,
`src/handlers/playlists/queries.ts:258-275, 315-335`,
`src/routes/openapi.ts:37+`.

**Interfaces:**

```ts
export interface MediaInfo {
  container: string; // ffprobe format_name
  videoCodec: string | null; // codec_name: "h264", "hevc", "vp9", "av1"
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null; // parsed from avg_frame_rate "30000/1001"
  bitDepth: number | null; // from bits_per_raw_sample, or pix_fmt ending 10le/12le
  bitRate: number | null; // format.bit_rate
  durationSeconds: number | null;
}
export function parseMediaInfo(output: unknown): MediaInfo | null;
export function readMediaInfo(
  filePath: string,
  run?: RunCommand,
): Promise<MediaInfo | null>;
```

- [ ] **Step 1: Write failing tests.** The fixture parses to the exact expected
      object. Audio-only has `videoCodec: null`. `avg_frame_rate` of `"0/0"`
      gives `fps: null`. Garbage input gives `null`. `readMediaInfo` on a
      missing file gives `null` without calling `run`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** beside `chapters.ts`, in the same shape. A probe
      failure is `null`, never a throw.
- [ ] **Step 4: Store it.** Column `mediaInfo` as `JSONB`, nullable. In
      `download.ts`, set `updates.mediaInfo` next to `updates.chapters`, and
      include it in the `/getsub` attributes, the safe row, and
      `SubListVideoRowSchema`.
- [ ] **Step 5: Run `deno task gen:api`, then `deno task test:unit`.** Expected:
      all pass.
- [ ] **Step 6: Commit.**
      `feat(media): record each file's codecs at download time`.

### Task 3: Backfill and MKV conversion scripts

**Files:** Create `scripts/media_info_backfill.ts`, `scripts/remux_mkv.ts`,
`tests/remux_mkv.test.ts`. Modify `deno.json` (tasks, modelled on
`chapters:backfill`).

**Interfaces:**
`remuxOne(row, deps: { run, stat, rename, remove, updateRow }): Promise<"converted" | "skipped" | "failed">`.

- [ ] **Step 1: Write `media_info_backfill.ts`,** copying the batch and cursor
      pattern from `scripts/chapters_backfill.ts`. Filter `mediaInfo: null`.
      Task name `media:backfill`. No new test, since it only reuses tested
      parts.
- [ ] **Step 2: Write failing tests for `remuxOne`.**
  - Success order: run ffmpeg to `<name>.remux.mp4`, probe, rename to
    `<name>.mp4`, update row (`fileName`, `mediaInfo`), remove `<name>.mkv`, in
    exactly that order.
  - ffmpeg fails: `failed`, temp file removed, original kept, row untouched.
  - Duration differs by more than 1 s: `failed`, same result.
  - `updateRow` throws: `failed`, the `.mkv` is still there.
  - `<name>.mp4` already exists: `skipped`, nothing overwritten.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement `remux_mkv.ts`.** ffmpeg arguments:
      `-v error -i <in> -map 0:v
      -map 0:a? -map_metadata 0 -map_chapters 0 -c copy -movflags +faststart <out>`.
      Default is a dry run listing what would change. `--apply` does it. Select
      `downloadStatus: true` and `fileName` ending in `.mkv` (`Op.iLike`). Task
      name `media:remux-mkv`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.**
      `feat(scripts): backfill media info, and convert existing MKVs safely`.

### Task 4: Fix range parsing (P10)

**Files:** Modify `src/routes/helpers/serveNativeFile.ts:74-90`. Create
`tests/serve_native_file.test.ts`.

- [ ] **Step 1: Write failing tests** with a 1000-byte temp file.
  - `bytes=-100` gives 206, `Content-Range: bytes 900-999/1000`, 100 bytes.
  - `bytes=-5000` gives 206 with the whole file.
  - `bytes=-0` gives 416.
  - `bytes=900-5000` gives 206, `bytes 900-999/1000`.
  - `bytes=1000-` and `bytes=5-2` give 416.
  - `bytes=0-` gives 206 with the whole file.
- [ ] **Step 2: Run them.** Expected: the suffix and clamp cases fail.
- [ ] **Step 3: Extract and fix.**
      `parseRange(header, totalSize): {start, end} | "unsatisfiable" | null`,
      exported and used by `tryServeNativeFile`.
- [ ] **Step 4: Full check.** `deno task test:unit`, `deno task fmt:check`,
      `deno lint index.ts src/ tests/ scripts/`,
      `deno check index.ts src/ tests/ scripts/`.
- [ ] **Step 5: Commit, advisor checkpoint, open the backend PR.**
      `fix(files): follow RFC 7233 for suffix and overlong ranges`.

### Task 5: Check before playing (frontend)

**Files:** Create `src/lib/playability.js`, `tests/desktop/playability.test.js`.
Modify `src/components/VideoPlayer.jsx`, `src/components/PlaybackFailure.jsx`.
Bring in the regenerated `apiTypes.js`.

**Interfaces:**
`checkPlayability(mediaInfo, nav = navigator): Promise<"smooth" | "may-stutter" | "unsupported" | "unknown">`.

- [ ] **Step 1: Write failing tests,** stubbing
      `mediaCapabilities.decodingInfo`.
  - `null` info is `unknown`, with no call.
  - `{supported: false}` is `unsupported`.
  - `{supported: true, smooth: false}` is `may-stutter`.
  - `{supported: true, smooth: true}` is `smooth`.
  - No `mediaCapabilities` and `canPlayType` returning `""` is `unsupported`;
    returning `"maybe"` is `unknown`.
  - `decodingInfo` rejecting is `unknown`.
  - The request maps codecs: `h264` to `avc1.640028`, `hevc` to
    `hvc1.1.6.L120.B0`, `vp9` to `vp09.00.40.08`, `av1` to `av01.0.08M.08`;
    `aac` to `mp4a.40.2`, `opus` to `opus`. An unmapped codec is `unknown`.
    Default the bitrate to 5,000,000 and fps to 30 when missing.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the pure module.
- [ ] **Step 4: Wire it, test first.** In `VideoPlayer.test.jsx`:
  - `"an unsupported file goes straight to the failure screen"`: no `<video>`.
  - `"Try anyway plays it"`: renders the video after the button.
  - `"a file that may stutter shows a dismissible note"`:
    `May stutter on this device`.
- [ ] **Step 5: Full check.** `npx vitest run`,
      `npm run lint && npm run typecheck`.
- [ ] **Step 6: Commit, advisor checkpoint, open the frontend PR.**
      `feat(player): warn before playing what this device can't handle`.

### After merging (run on the Pi, by you)

```bash
deno task media:backfill
deno task media:remux-mkv           # read the dry-run list first
deno task media:remux-mkv --apply   # take a backup first if the list is long
```

Check how `chapters:backfill` is run in your container, and use the same method.
