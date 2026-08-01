# Chat Bot

Send a video link to a Telegram chat and get the **video file back in the chat**.
A download link is the fallback for files too big to upload, not the norm.

The bot adds no new yt-dlp logic. It is an intake and delivery layer over the
existing pipeline — the same listing, download queue, semaphores, cookies and
proxy settings the web UI uses.

---

## 1. Running without a bot (the default)

**The bot is off unless you turn it on, and an instance that never configures it
is completely unaffected.** Upgrading an existing deployment requires no action.

With `BOT_ENABLED` unset or `false`:

- `createBotService` returns a no-op — no adapter is constructed, no Telegram
  connection is opened, nothing polls.
- No `BotSubmission` rows are ever written.
- **No retention cron job is registered.** Only the usual three run.
- Nothing is logged about the bot at all.

Verified on a run with every `BOT_*` variable unset:

```
Started cleanup job    schedule="*/10 * * * *"
Started update job     schedule="*/10 * * * *"
Started prune job      schedule="*/10 * * * *"
```

The `bot_submissions` table is still created by `sequelize.sync({ alter: true })`
because the model is always registered. Adding a table is safe under `alter`, it
stays empty, and it costs nothing.

> [!IMPORTANT]
> **Upgrading an existing instance:** the `bot_token` secret in
> `docker-compose.yml` is **commented out by default**. Leave it that way unless
> you are enabling the bot. A secret whose `file:` does not exist makes
> `docker compose up` fail outright — not just the bot, the whole stack:
>
> ```
> Error response from daemon: invalid mount config for type "bind":
> bind source path does not exist: .../secrets/bot_token.txt
> ```
>
> Every `BOT_*` variable in the compose file also has an inline default, so an
> `envs/*.env` without the bot rows resolves cleanly with no warnings.

### Fail-closed

`BOT_ENABLED=true` with an empty `BOT_ALLOWED_CHAT_IDS` **does not start an open
bot**. It logs an error and starts nothing:

```
level=error msg="Chat bot is disabled due to a configuration error"
  error="BOT_ENABLED is true but BOT_ALLOWED_CHAT_IDS is empty; refusing to start an unrestricted bot"
```

Same for a missing token or an invalid `BOT_RETENTION_MODE`. An open bot on a
yt-dlp box lets anyone who can message it make your server fetch arbitrary URLs
and fill the disk.

---

## 2. Enabling the bot

1. Talk to [@BotFather](https://t.me/BotFather), create a bot, copy the token.
2. Save it: `echo '<token>' > secrets/bot_token.txt`
3. Get your chat ID — message [@userinfobot](https://t.me/userinfobot), or send
   your bot a message and read `chatId` from the debug log.
4. In `docker-compose.yml`, **uncomment all three**:
   - the `bot_token:` secret definition
   - the `- bot_token` entry under the service's `secrets:`
   - the `- BOT_TELEGRAM_TOKEN_FILE=/run/secrets/bot_token` environment line
5. In your `envs/*.env`:

   ```
   BOT_ENABLED=true
   BOT_ALLOWED_CHAT_IDS=123456789
   BOT_PUBLIC_BASE_URL=https://your.host/   # externally reachable origin
   ```

6. `docker compose up -d`

Locally, `deno task bot` does all of this from `secrets/` with no compose edits.

`BOT_PUBLIC_BASE_URL` matters: `HOSTNAME` is usually container-internal, and
download links are built from this value. Get it wrong and links resolve to an
address your phone cannot reach.

---

## 3. Retention: ephemeral vs persistent

### Persistent — keep everything on disk

```
BOT_RETENTION_MODE=persistent
```

That is the whole change. In this mode:

- delivered files stay on disk forever
- `expiresAt` is written as `NULL` on every submission
- **the retention cron job is never registered** — not registered-and-idle,
  genuinely absent, since nothing could ever be eligible

Verified:

```
Started cleanup job    schedule="*/10 * * * *"
Started update job     schedule="*/10 * * * *"
Started prune job      schedule="*/10 * * * *"
Chat bot started       platforms="telegram" retention="persistent"
```

Note the absence of `Started botRetention job`.

### Ephemeral — reap files after a while (default)

```
BOT_RETENTION_MODE=ephemeral
BOT_RETENTION_HOURS=24
BOT_REAP_INTERVAL=0 * * * *
```

Files the **bot itself downloaded** are deleted `BOT_RETENTION_HOURS` after
delivery. Full mechanics, guards and the verified run are in
[`AUTOMATED_JOBS.md`](./AUTOMATED_JOBS.md#4-bot-retention-job-reaper).

The rule worth repeating: **the reaper never deletes a file the bot did not
download.** Web-UI downloads, and anything the bot merely re-delivered from an
existing file, are recorded `downloadedByBot=false` and are untouchable.

`BOT_RETENTION_HOURS` accepts fractions — `0.25` is 15 minutes, useful for
testing.

---

## 4. Regenerating a download link

Links live in Redis and self-evict on their own TTL (`BOT_SIGNED_URL_TTL`,
default 6h). The file on disk is a separate matter. So "my link stopped working"
has two different answers:

### The file is still on disk (persistent mode, or before the reaper ran)

Send **`/link <url>`**. You get a fresh link with **no re-download**:

- dedupe tier 1 sees the row is downloaded and the file is present
- it delivers immediately — no listing, no yt-dlp process at all
- `/link` forces a signed URL instead of an upload

This is the answer for persistent mode. Re-sending the bare URL works too, but
that uploads the file again if it fits; `/link` always gives you the link.

### The file was reaped

Send the **URL again** (or `/get <url>`). The `VideoMetadata` row survived the
reap, so:

- no re-indexing happens — dedupe tier 2 goes straight to the download queue
- the file is re-downloaded and delivered, with a fresh link

Either way you never need the old `fileId`; it is gone from Redis and there is
nothing to refresh.

| Situation | Command | Re-downloads? |
| :-- | :-- | :-- |
| File on disk, link expired | `/link <url>` | No |
| File on disk, want the file itself | `<url>` | No |
| File reaped | `<url>` or `/get <url>` | Yes (no re-index) |

---

## 5. Commands

| Input | Behaviour |
| :-- | :-- |
| `<link>` | index → download → send the file back |
| `/get <link>` | same, spelled out |
| `/link <link>` | always reply with a download link, never upload |
| `/index <link>` | catalogue only — searchable, **not** downloaded |
| `/index <link> Start\|End\|Full` | also monitor the playlist for updates |
| `/search <text>` | search indexed videos by title or link |
| `/history [n]` | recent submissions; the short code is the `<id>` |
| `/status` | current download queue |
| `/keep <id>` | make an ephemeral submission persistent |
| `/rm <id>` | delete a submission's files now |
| `/help` | command list |

`<id>` values come from `/history` — the eight-character code at the start of
each entry.

Messages from a chat not in `BOT_ALLOWED_CHAT_IDS` are **silently ignored**. No
"unauthorized" reply, which would confirm the bot exists to anyone probing.

---

## 6. Sizes and progress

**Uploads are preferred; links are the fallback.** Above
`BOT_TELEGRAM_MAX_UPLOAD` (default 50 MB — raise to ~2 GB with a local Bot API
server) the file is delivered as a link, and the reply says so with the measured
size:

> That's 65 MB — too big to upload here (limit 48 MB), so here's a download link
> instead.

`BOT_LARGE_FILE_WARN` (default 100 MB) additionally warns *before* downloading,
but only when yt-dlp actually provides an estimate.

> [!NOTE]
> Many sites — x.com in particular — report no size estimate at all
> (`approximateSize = -1`, normalised to 0 = unknown). For those the
> pre-download warning cannot fire, and the post-download message above is the
> reliable one.

Progress is a **heartbeat, not a progress bar**: silent for the first 45 s, then
at most one update per minute. Small files finish inside the quiet window and
produce no progress messages at all. Telegram rate-limits edits aggressively, so
an unthrottled progress bar gets the bot temporarily banned.

---

## 7. Cookies, proxy and auth

The bot inherits everything from `buildSiteArgs` — the same code path the web UI
uses for both listing and downloading. No bot-specific configuration:

- `X_COOKIES_FILE` / `YOUTUBE_COOKIES_FILE` / `COOKIES_FILE`
- `PROXY_STRING_FILE` (applied to x.com and iwara.tv)
- iwara credentials

If a link works in the web UI it works in the bot, and vice versa.

> [!NOTE]
> A tweet that returns `TweetTombstone` is unavailable to the account your
> cookies belong to — deleted, suspended, protected, or age-restricted. yt-dlp
> reports `No video could be found in this tweet`. Check the tweet in a browser
> logged in as that account, and that **Settings → Privacy and safety → Display
> media that may contain sensitive content** is enabled.

---

## 8. Known gaps

- **`--audio` and quality flags are not supported.** `downloadOptions` is frozen
  at import time (`pipeline/types.ts`), built once from global config, so
  per-request format selection needs the arg-builder refactor logged as Future
  Milestone #1 in `ISSUES_AND_IMPROVEMENTS.md`.
- **Only one bot instance can poll a token at a time.** Running `deno task bot`
  while a containerised bot is live makes them fight over `getUpdates` and
  neither reliably receives messages.
- **Telegram only.** `BotAdapter` is platform-agnostic so Discord can be added
  without touching `BotCore`, but no Discord adapter exists yet.

---
*Last updated at: 2026-08-02*
