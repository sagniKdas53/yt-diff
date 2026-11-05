# 04: Progress, ownership and notifications implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. No subagents.
> Read `README.md` first. Steps use checkboxes.

**Goal:** progress follows you between devices, each video records who asked for
it, and notifications survive a reload and say whether they were delivered.

**Architecture:** four new tables. Writes are best-effort and never block the
pipeline. Nothing filters by owner. **Tech stack:** Deno, Sequelize, React.
**Branches:** `feat/user-tracking` from `master`; `feat/watch-progress-ui` from
`material`. **Spec:** `README.md`.

## Global constraints

See `README.md`. All `user` and `chat` data is recorded only. **Do not add a
filter on owner anywhere.**

## Review focus

1. A 20-second clip at position 0 is under 30 s from its end and must **not**
   count as finished. The rule has to allow for short videos.
2. A progress write for a video deleted a moment earlier gets a clean 404, not
   a 500.
3. A database failure while recording an owner or a notification doesn't fail
   the download or the Telegram delivery.
4. Two users have separate progress, read state and delivered state on the same
   video.
5. A rewatch of a finished video starts at 0, and the link's `t=` always wins
   over saved progress.

---

### Task 1: Tables

**Files:** Modify `src/db/models.ts` (define after `UserAccount`, associations
with the others at the bottom), `docs/DATABASE_SCHEMA.md`. Test
`tests/models_tracking.test.ts`.

**Advisor checkpoint:** before Step 1, to check the schema against the confirmed
meaning of ownership and delivery in `README.md`.

| Model                  | Table columns                                                                                                                                                                                                                                                    |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WatchProgress`        | `id` UUID PK, `userId` UUID FK `user_account` CASCADE, `videoUrl` STRING FK `video_metadata` CASCADE. Unique `(userId, videoUrl)`. `positionSeconds` FLOAT, `durationSeconds` FLOAT null, `completedAt` DATE null, timestamps. Index `(userId, updatedAt)`.      |
| `VideoOwner`           | `id` UUID PK, `videoUrl` FK CASCADE, `ownerKey` STRING (`user:<id>` or `chat:<platform>:<chatId>`), `source` STRING (`web`, `bot`, `backfill`), timestamps. Unique `(videoUrl, ownerKey)`. Index `(source)`.                                                     |
| `Notification`         | `id` UUID PK, `kind` STRING, `severity` STRING, `message` TEXT, `videoUrl` STRING null with **no FK** (history outlives the video), `playlistUrl` STRING null, `ownerKey` STRING null, `createdAt`, `updatedAt`. Index `(createdAt)`.                            |
| `NotificationDelivery` | `id` UUID PK, `notificationId` UUID FK CASCADE, `channel` STRING (`web`, `telegram`), `recipient` STRING (`user:<id>` or chat key). Unique `(notificationId, channel, recipient)`. `deliveredAt`, `readAt`, `failedAt` DATE null, `error` TEXT null, timestamps. |

Every table uses a single UUID `id` plus a unique index, as
`PlaylistVideoMapping` does, because that pattern is known to survive
`sync({ alter: true })`. Upserts name the unique columns in `conflictFields`.

Set `tableName` explicitly, or Sequelize pluralises the names and plan 05's raw
SQL breaks: `watch_progress`, `video_owner`, `notification`,
`notification_delivery`.

- [ ] **Step 1: Write a failing test** that each model exposes the attributes
      above, its `tableName`, and its unique index (read
      `Model.getAttributes()`, `Model.getTableName()` and
      `Model.options.indexes`; no database needed).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** the models, in the file's existing style with
      `comment:` on each column, and document them.
- [ ] **Step 4: Run it, then `deno task test:unit`.** Expected: PASS.
- [ ] **Check it on a real database.** Boot the app twice against a scratch
      Postgres (the isolated stack in `AGENTS.md`). `initializeDatabase` catches
      sync errors and only logs them, and a failure there also skips creating
      the `None` playlist. Expected: no `Unable to create table` in the log, and
      `\d` shows each table with its unique index. If you can't run the stack,
      stop for an advisor checkpoint.
- [ ] **Step 5: Commit.**
      `feat(db): tables for watch progress, owners and notifications`.

### Task 2: Progress API

**Files:** Create `src/handlers/progress.ts`, `tests/progress.test.ts`. Modify
`src/middleware/validator.ts`, `src/routes/endpoints.ts`,
`src/routes/openapi.ts`, `index.ts`,
`src/handlers/playlists/queries.ts:163-166, 292-335`.

**Interfaces:**

```ts
isFinished(position: number, duration: number | null): boolean
// POST /progress { videoUrl, position, duration? } → { status: "success", completed }
// POST /continue { limit? (default 12, max 50) } →
//   { items: [{ videoUrl, positionSeconds, durationSeconds, updatedAt, playlistUrl,
//               video: { title, fileName, saveDirectory, thumbNailFile, onlineThumbnail } }] }
findProgress(userId: string, urls: string[]): Promise<Map<string, RowProgress>>
// RowProgress = { positionSeconds, durationSeconds, completed: boolean }
```

- [ ] **Step 1: Write failing tests.**
  - `isFinished`: `(95, 100)` true. `(94, 100)` false. `(0, 20)` false.
    `(19.5, 20)` true. `(575, 600)` true, since under 30 s left on a video of 5
    minutes or more. `(10, null)` false. `(0, 0)` false.
  - Schema: `position` must be finite and non-negative; `Infinity`, `NaN` and
    `-1` are rejected.
  - Handler with an injected store: a missing `context.userId` gives 401; a save
    with a too-large position clamps to duration; a foreign-key error gives 404;
    two users stay separate; `completedAt`, once set, survives a later lower
    position.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** using the five-place endpoint recipe, with
      `admission: "none"`. Inject the store as `src/bot/keepfile.ts` does,
      bridged in `index.ts`. `/continue` returns rows that aren't finished, with
      position above 5 s, newest first, and whose video is still downloaded.
      `playlistUrl` comes from `resolveVideoPlaylist` (`?? "None"`).
- [ ] **Step 4: Add `progress` to `/getsub` rows.**
      `getSubListVideos(body, res, context)` calls `findProgress` once per page,
      the same shape as `findBotExpiries`. Null when there is no `userId`. Add
      it to `SubListVideoRowSchema`.
- [ ] **Step 5: Run `deno task gen:api`, then `deno task test:unit`.** Expected:
      PASS.
- [ ] **Step 6: Commit.**
      `feat(progress): save and read per-user watch position`.

### Task 3: Ownership

**Files:** Create `src/handlers/ownership.ts`, `scripts/owners_backfill.ts`,
`tests/ownership.test.ts`. Modify `src/handlers/pipeline/download.ts:210-218`,
`src/bot/deliver.ts:251`, `src/handlers/playlists/queries.ts`,
`src/routes/openapi.ts`, `deno.json`.

**Interfaces:**

```ts
ownerKeyForUser(userId: string): string       // "user:<id>"
ownerKeyForChat(platform: string, chatId: string): string  // "chat:<platform>:<id>"
recordOwners(urls: string[], ownerKey: string, source: "web" | "bot" | "backfill"): Promise<void>
findAddedVia(urls: string[]): Promise<Map<string, "bot" | "web">>
```

- [ ] **Step 1: Write failing tests.**
  - `recordOwners` passes `ignoreDuplicates: true`, and a store that throws
    resolves without rejecting and logs.
  - `findAddedVia`: `bot` when any owner is a chat, otherwise `web`.
  - `"download - a request records its owner"`: `processDownloadRequest` with
    `context.userId` records `user:<id>` for the accepted URLs, and only those
    (`items`, not `notIndexed`).
  - `"download - an owner failure does not fail the download"`.
  - `"bot - delivery records the chat as an owner"`: in
    `tests/bot_delivery.test.ts`, after `settle(… "delivered" …)`.
  - `"getsub does not filter by owner"`: rows owned by another key are still
    returned.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The chat comes from `entry.target`, which is
      `{ platform, chatId }`. Inject the function into bot deps, following how
      `locateVideo` is injected. Add `addedVia` to `/getsub`.
- [ ] **Step 4: Write the backfill.** Task `owners:backfill`: every
      `BotSubmission` with `status: "delivered"` and a `canonicalUrl` becomes a
      `bot` owner. With `--assign-unowned <username>`, every downloaded video
      with no owner gets that user with source `backfill`. Dry run unless
      `--apply` is passed. Batch 500.
- [ ] **Step 5: Run `deno task gen:api`, `deno task test:unit`.** Expected:
      PASS.
- [ ] **Step 6: Commit.** `feat(ownership): record who asked for each video`.

### Task 4: Notification log

**Files:** Create `src/notifications/store.ts`, `src/notifications/recorder.ts`,
`tests/notifications.test.ts`. Modify `src/events.ts:114-124` (add
`listing-playlist-complete` to `APP_EVENT_NAMES` and its payload to the event
map), `src/middleware/validator.ts`, `src/routes/endpoints.ts`,
`src/routes/openapi.ts`, `index.ts`, `src/bot/deliver.ts`,
`src/jobs/index.ts:242`.

**Advisor checkpoint:** before Step 3.

**Interfaces:**

```ts
recordNotification(input: {
  kind: string; severity: "success" | "error" | "info" | "warning"; message: string;
  videoUrl?: string | null; playlistUrl?: string | null; ownerKey?: string | null;
  delivery?: { channel: "telegram"; recipient: string; ok: boolean; error?: string };
}): Promise<void>                                    // never rejects
listNotifications(userId, { limit?: number, before?: string }): Promise<{ rows, unread: number }>
markRead(userId, { ids?: string[], all?: boolean }): Promise<number>
pruneNotifications(olderThanDays = 90): Promise<number>
subscribeNotificationRecorder(bus: AppEventBus): void
// POST /notifications { limit?, before? }, POST /notifications/read { ids?, all? }
```

Each row returned:
`{ id, kind, severity, message, videoUrl, createdAt, readAt, deliveries: [{ channel, recipient, deliveredAt, failedAt, error }] }`.

- [ ] **Step 1: Write failing tests.**
  - The recorder turns `download-done` into `success` with the title, falling
    back to the URL when the title is null. `download-failed` and
    `listing-error` become `error`. `listing-playlist-complete` becomes
    `success`.
  - A store that throws doesn't stop other bus handlers.
  - `listNotifications` for a user upserts a `web` delivery with `deliveredAt`,
    for the rows it returns, and doesn't change an earlier `deliveredAt`.
  - `markRead` affects only that user. `all: true` only touches rows that exist
    by then.
  - Unread counts rows with no `readAt` for that user, including ones never
    delivered.
  - Telegram outcome: a successful delivery records `deliveredAt`, and a failure
    records `failedAt` and `error`, as a `bot-delivered` or
    `bot-delivery-failed` notification.
  - `pruneNotifications` removes rows older than the cutoff.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Web recipients are created lazily when a user
      lists; there's no fan-out to every user. No correlation between the
      event's row and the bot's row: the bot writes its own row, which avoids an
      ordering race between two bus subscribers. Subscribe the recorder in
      `index.ts` near `createBotService`. Call `pruneNotifications` in the
      existing prune job.
- [ ] **Step 4: Run `deno task gen:api`, then the full backend check.**
      Expected: all pass.
- [ ] **Step 5: Commit, advisor checkpoint, open the backend PR.**
      `feat(notifications): keep a log, with delivery per channel`.

### Task 5: Player progress and card bars (frontend)

**Files:** Create `src/hooks/useWatchProgress.js`,
`tests/desktop/useWatchProgress.test.jsx`. Modify `src/api/client.js:77-90`
(pass `keepalive` through), `src/components/VideoPlayer.jsx:539-555, 674-686`,
`src/components/SubList.jsx:966-986`, `src/components/SubListItemCard.jsx`.

**Interfaces:**
`useWatchProgress({ api, videoUrl, videoRef }): { report(seconds: number): void }`.
`VideoPlayer` gains the prop `sourceUrl`, the row's `videoUrl`.

- [ ] **Step 1: Write failing tests.**
  - `report` posts `/progress` with position and `videoRef.current.duration`,
    and skips when `sourceUrl` is null or duration isn't finite.
  - A failed post is swallowed, with no snackbar and no retry loop.
  - `pagehide` posts with `keepalive: true`.
  - Resume order in `VideoPlayer`: `startAt` from the link wins, else the row's
    saved position, else 0. `completed: true` starts at 0. A recovery re-mint
    doesn't re-apply it.
  - Card: `"a partly watched video shows a progress bar"` and
    `"a finished video says Watched"`.
  - Card: `"a video added by the bot says via bot"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Call `report` from `writeStartAt`, keeping its
      existing 10 s and pause cadence, so nothing adds a second timer. Merge the
      saved position into the same `appliedStartAtRef` logic.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(player): save progress and resume from it`.

### Task 6: Notification drawer (frontend)

**Files:** Create `src/hooks/useServerNotifications.js`. Modify
`src/components/Nav.jsx` (`NotificationDrawer`), `src/hooks/useSocketEvents.js`.
Test `tests/desktop/Nav.test.jsx`.

**Why a hook and not the provider:** `NotificationProvider` sits above the API
client's users, and `apiFetch` already reports through it, so fetching from
inside it would be circular.

- [ ] **Step 1: Write failing tests.**
  - The drawer lists server rows, and the badge shows `unread`.
  - It merges client-only messages from `addNotification`, newest first.
  - Dismiss posts `/notifications/read`, and Clear all posts `{ all: true }`.
  - A failed Telegram delivery shows its error line, and a delivered one shows
    `Sent to Telegram`.
  - A socket `download-done` refreshes the list, debounced at 1 s.
  - The list still renders client messages if the fetch fails.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `addNotification` from socket handlers whose
      kinds the server now records (`download-done`, `download-failed`,
      `listing-error`, playlist complete), and leave toasts in place.
- [ ] **Step 4: Full check.** `npx vitest run`,
      `npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit, advisor checkpoint, open the frontend PR.**
      `feat(notifications): show the saved log and its delivery status`.

### After merging (run on the Pi, by you)

```bash
deno task owners:backfill                                  # read the dry run
deno task owners:backfill --apply --assign-unowned <you>   # <you> is your username
```
