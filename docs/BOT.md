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
   ```

6. `docker compose up -d`

Locally, `deno task bot` does all of this from `secrets/` with no compose edits.

### Download link origin

`BOT_PUBLIC_BASE_URL` is an **override, not a requirement**. Left empty, links
are built from the same origin the server logs at startup:

```
Server listening on https://pi5.tail9ece4.ts.net/ytdiff
Chat bot started  linkBase="https://pi5.tail9ece4.ts.net/ytdiff" linkBaseFrom="server origin"
```

That is `PROTOCOL://HOSTNAME`, plus `:PORT` unless `HIDE_PORTS=true` — the same
`buildPublicOrigin()` both call, so the two lines cannot drift.

Set it only when that origin is not reachable from a phone:

- `HOSTNAME` is a container-internal name rather than the external one
- a reverse proxy answers on a different hostname than the app is configured with

The `Chat bot started` line reports which source was used (`server origin` vs
`BOT_PUBLIC_BASE_URL`), so a wrong link is visible at boot rather than at the
moment someone taps it.

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

Links live in Redis and self-evict on `CACHE_MAX_AGE` (default 1h), the same
lifetime web-UI links get, sliding forward on every access. The file on disk is
a separate matter. So "my link stopped working" has two different answers:

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
| `<video-link>` | index → download → send the file back |
| `<playlist-link>` | index the playlist — see §5.1; nothing is downloaded |
| `/get <link>` | same as pasting the link, spelled out |
| `/link <link>` | always reply with a download link, never upload |
| `/download <link>` | download it to the server and send **nothing** back |
| `/index <link>` | catalogue only — searchable, **not** downloaded |
| `/index <playlist-link> Start\|End\|Full` | also monitor it for updates |
| `/index <playlist-link> N/A` | stop monitoring it |
| `/search <text>` | search indexed videos by title or link |
| `/list` | the playlists the bot knows about |
| `/list <playlist-link> [start] [count]` | one page of a playlist's entries |
| `/history [n]` | recent submissions; the short code is the `<id>` |
| `/status` | current download queue |
| `/keep <id>` | make an ephemeral submission persistent |
| `/rm <id>` | delete a submission's files now |
| `/help` | command list |

`<id>` values come from `/history` — the eight-character code at the start of
each entry.

Monitoring types are matched **case-insensitively**: `end`, `End` and `END` are
the same request, and the canonical spelling is what reaches the pipeline.

Messages from a chat not in `BOT_ALLOWED_CHAT_IDS` are **silently ignored**. No
"unauthorized" reply, which would confirm the bot exists to anyone probing.

### 5.1 Playlists

**A playlist link is never a download.** Listing one produces hundreds of
videos, so pasting a playlist link — or `/get`, `/download` or `/index` on one —
catalogues it and stops there:

```
That's a playlist — indexing it. Nothing gets downloaded; browse it with
/list when it finishes.
Indexing Some Playlist — about 60 entries so far…
Indexed: Some Playlist
137 entries · watch mode: N/A

Browse it:  /list https://www.youtube.com/playlist?list=PL…
Then /get <video-link> for anything you want downloaded.
```

The progress line is driven by the pipeline's per-chunk listing events, at most
one message per 20 seconds. Before this the bot went quiet for the whole
listing and then failed with "produced no video entry", because a playlist has
no single video row to hand to the download queue.

A playlist the bot indexes gets **watch mode `N/A`** — the same value the web UI
shows for a playlist nobody is watching. `Start`/`End`/`Full` are only ever set
by asking for them explicitly with `/index <playlist-link> <mode>`, and `N/A`
takes it back off.

Browsing an indexed playlist:

```
/list                                        the playlists, with entry counts
/list <playlist-link>                        entries 1-10
/list <playlist-link> 10 10                  entries 11-20
```

Each entry shows its playlist position, whether the file is on disk, its title
and its link — so `/get <video-link>` on any line downloads just that one.
`count` is capped at 25, and a page that would exceed Telegram's message limit
is truncated rather than rejected.

### 5.2 Downloading without receiving

`/download <video-link>` runs the full download and leaves the file on the
server. Nothing is uploaded and no link is sent — the reply is just
`Downloaded: <title>`.

Those submissions are recorded as `downloaded` rather than `delivered`, with
`retention=persistent` and `expiresAt=NULL`, so **the reaper never touches
them** even in ephemeral mode: it only ever selects delivered submissions. Use
`/get` on the same link afterwards to have it sent to the chat.

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

## 6.1 How many at once

Send as many links as you like. Messages are accepted the moment they arrive and
handled off the polling loop, so nothing you send has to wait for whatever came
before it to finish.

Two limits shape what happens next:

| Limit | Default | What it bounds |
| :-- | :-- | :-- |
| `BOT_MAX_CONCURRENT_MESSAGES` | 20 | Link submissions worked on at once. Extras queue in the order they were sent — none are dropped. |
| `BOT_MAX_PENDING_PER_CHAT` | 20 | Downloads plus playlist listings one chat may have in flight. Past this the reply is *"You already have the maximum number of requests in flight"*. |

Questions — `/status`, `/list`, `/search`, `/history`, `/help` — are answered
straight away and never queue behind downloads, because they are a database read
and a reply.

Note that `MAX_LISTINGS` and `MAX_DOWNLOADS` (both 1 by default) still decide how
much yt-dlp runs at once. Twenty accepted submissions are twenty acknowledgements
and a queue, not twenty parallel downloads; the ack says how many are ahead.

> [!NOTE]
> Before 2026-09-04 a single slow submission stopped the bot reading Telegram at
> all — grammy awaits each update's handler before fetching the next batch, and a
> playlist probe that wedged inside yt-dlp took the whole bot down with it for an
> hour. See
> [`RCA_PLAYLIST_INDEXING_DEADLOCK.md`](./RCA_PLAYLIST_INDEXING_DEADLOCK.md).

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
  without touching `BotCore`, but no Discord adapter exists yet — deferred, see
  [`TODO.md`](./TODO.md) item 23.

---
*Last updated at: 2026-09-04*
