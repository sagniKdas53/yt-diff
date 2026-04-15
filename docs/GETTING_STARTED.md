# Getting Started with yt-diff

A step-by-step guide to get `yt-diff` running locally for development or
deployed via Docker Compose for production.

---

## What is yt-diff?

`yt-diff` is a self-hosted web application for indexing, monitoring, and
downloading videos using [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). It
tracks playlists and channels, detects new uploads, and lets you archive videos
to local storage — all through a React + Material UI web interface backed by a
Deno/TypeScript server.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Docker Compose                      │
│                                                         │
│  ┌───────────┐   ┌──────────┐   ┌──────────────────┐   │
│  │  Valkey   │   │ Postgres │   │    pgbackups     │   │
│  │  (Redis)  │   │   (DB)   │   │ (daily backups)  │   │
│  └─────┬─────┘   └────┬─────┘   └────────┬─────────┘   │
│        │              │                   │             │
│        └──────┬───────┘                   │             │
│               │                           │             │
│        ┌──────┴──────┐                    │             │
│        │   yt-diff   │────────────────────┘             │
│        │ (Deno + UI) │                                  │
│        └──────┬──────┘                                  │
│               │                                         │
│        ┌──────┴──────┐                                  │
│        │   Gluetun   │  (optional VPN proxy)            │
│        └─────────────┘                                  │
└─────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Dependency | Purpose | Install |
| :--------- | :------ | :------ |
| **Deno** | Runtime for the TypeScript backend | [deno.land](https://deno.land/#installation) |
| **PostgreSQL** | Relational database for video/playlist metadata | via Docker or system package |
| **Valkey** (or Redis) | Rate limiting and caching | via Docker or system package |
| **Python 3** | Required by `yt-dlp` | System package |
| **yt-dlp** | Video extraction engine | `pip install -U "yt-dlp[default]"` |
| **curl_cffi** | Browser impersonation for sites that need it | `pip install curl_cffi` |
| **ffmpeg** | Media post-processing (muxing, thumbnails) | [ffmpeg.org](https://ffmpeg.org/) |
| **Node.js & npm** | Building the React frontend (dev only) | [nodejs.org](https://nodejs.org/) |
| **Docker & Docker Compose** | Production deployment | [docker.com](https://docs.docker.com/get-docker/) |

---

## Option A: Local Development

### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
cd yt-diff
```

> [!NOTE]
> The frontend is a git submodule. The `--recurse-submodules` flag ensures it's
> cloned alongside the backend.

### 2. Install Backend Dependencies

```bash
deno install
```

### 3. Build the Frontend

```bash
cd frontend
npm install
npm run build
cd ..
```

The built assets land in `dist/` and are served as static files by the backend.

### 4. Set Up PostgreSQL and Valkey

Run them via Docker (simplest option):

```bash
docker compose --env-file .env --env-file .localenv up -d yt-db valkey
```

Or install them natively and ensure they're running on the default ports
(`5432` for Postgres, `6379` for Valkey/Redis).

### 5. Configure Secrets

Create these files in the project root:

| File | Contents |
| :--- | :------- |
| `db_password.txt` | Your PostgreSQL password (must match the `yt-db` container) |
| `secret_key.txt` | A random JWT signing key (any string) |

Optional:

| File | Contents |
| :--- | :------- |
| `cookie_secret.txt` | Netscape-format cookies for `yt-dlp` (used for x.com, YouTube WL/LL, etc.) |
| `proxy_string.txt` | HTTP proxy URL (e.g., `http://user:pass@host:port/`) |
| `iwara.json` | `{"username": "...", "password": "..."}` for Iwara credentials |

### 6. Start the Server

Choose a task based on what you need:

```bash
# Basic — just DB password + secret key
deno task dev

# With cookies (for x.com, YouTube WL/LL)
deno task cookies

# With YouTube API (OAuth) — fast playlist/channel listing
deno task youtube

# With proxy
deno task proxy

# With Iwara credentials
deno task iwara

# Everything enabled
deno task full
```

The server starts on `http://localhost:8888/ytdiff` by default.

### 7. Register a User

Open the UI in your browser, click **Sign Up**, and create your first account.
The server logs a warning on startup if no users exist yet.

---

## Option B: Docker Deployment

### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
cd yt-diff
```

### 2. Configure Environment

Edit the `.env` file — the key variables to customize:

```ini
# Server identity
PROTOCOL=https
PORT=8888
HOSTNAME=your.hostname.here
BASE_URL=/ytdiff

# Paths (host machine)
HOST_SAVE_PATH=/path/to/your/video/storage
DB_LOCATION=/path/to/postgres/data
DB_BACKUP_LOCATION=/path/to/backup/dir
HOST_COOKIES_FILE=/path/to/cookies.txt  # global fallback
# HOST_X_COOKIES_FILE=/path/to/x_cookies.txt       # x.com only (optional)
# HOST_YOUTUBE_COOKIES_FILE=/path/to/yt_cookies.txt # YouTube only (optional)

# Database
DB_USERNAME=ytdiff
DB_HOST=yt-db

# Scheduling
UPDATE_SCHEDULED=0 */12 * * *
PRUNE_INTERVAL=0 */12 * * *
TZ_PREFERRED=Asia/Kolkata
```

Create the secret files (`db_password.txt`, `secret_key.txt`, etc.) as
described in [Option A, Step 5](#5-configure-secrets).

### 3. Build & Start

Using the pre-built image from GHCR:

```bash
make up
```

Or build locally:

```bash
make build
make up
```

This starts all services: `yt-db`, `valkey`, `yt-diff`, `pgbackups`, `pgadmin`,
and `gluetun` (VPN).

### 4. Verify

```bash
curl -f http://localhost:8888/ytdiff/ping
# → pong
```

Open `https://your.hostname/ytdiff` in your browser to access the UI.

---

## First Steps After Setup

1. **Register** — create your user account through the registration page.
2. **Add a Playlist** — paste a YouTube playlist, channel, or single video URL.
   Choose a monitoring type:
   - `Start` — new videos at the top (channels)
   - `End` — new videos at the bottom (playlists you add to)
   - `Full` — complete re-scan every cycle
   - `N/A` — no automatic monitoring
3. **Wait for Listing** — the server indexes all videos. For YouTube playlists
   and channels, this uses the YouTube Data API (seconds) if configured, or
   falls back to `yt-dlp` (minutes to hours). Watch progress via the real-time
   WebSocket updates in the UI.
4. **Download** — select videos and click download. Files are saved to your
   configured `SAVE_PATH`.

---

## Environment Variable Reference

### Server

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `PROTOCOL` | `http` | Protocol for URL generation (`http` or `https`) |
| `HOSTNAME` | `localhost` | Server hostname |
| `PORT` | `8888` | HTTP listen port |
| `BASE_URL` | `/ytdiff` | URL prefix for all routes |
| `HIDE_PORTS` | `false` | Omit port from logged URLs (behind a reverse proxy) |
| `USE_NATIVE_HTTPS` | `false` | Enable built-in HTTPS (requires `SSL_KEY`, `SSL_CERT`) |
| `NO_COLOR` | `false` | Disable ANSI colors in log output |

### Database

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `DB_HOST` | `localhost` | PostgreSQL hostname |
| `DB_USERNAME` | `ytdiff` | PostgreSQL username |
| `DB_PASSWORD_FILE` | — | Path to file containing the DB password |
| `DB_PASSWORD` | — | Direct DB password (fallback if file not set) |

### Redis / Valkey

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `REDIS_HOST` | `localhost` | Redis/Valkey hostname |
| `REDIS_PORT` | `6379` | Redis/Valkey port |
| `REDIS_PASSWORD` | — | Redis/Valkey password (optional) |

### Downloads & Listings

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `SAVE_PATH` | `/home/.../yt-diff-data/` | Root directory for downloaded files |
| `COOKIES_FILE` | — | Path to Netscape-format cookies file (global fallback for all sites) |
| `X_COOKIES_FILE` | — | Path to cookies file for x.com only (overrides `COOKIES_FILE`) |
| `YOUTUBE_COOKIES_FILE` | — | Path to cookies file for YouTube only (overrides `COOKIES_FILE`) |
| `PROXY_STRING_FILE` | — | Path to file containing HTTP proxy URL |
| `PROXY_STRING` | — | Direct proxy URL (fallback) |
| `SLEEP` | `3` | Seconds to wait before starting jobs on boot |
| `CHUNK_SIZE_DEFAULT` | `10` | Videos per processing chunk during listing |
| `MAX_DOWNLOADS` | `2` | Max concurrent download processes |
| `MAX_LISTINGS` | `2` | Max concurrent listing processes |
| `SAVE_SUBTITLES` | `true` | Download subtitle files |
| `SAVE_DESCRIPTION` | `true` | Download description files |
| `SAVE_COMMENTS` | `true` | Download comments as JSON |
| `SAVE_THUMBNAIL` | `true` | Download thumbnail images |
| `RESTRICT_FILENAMES` | `true` | Use `yt-dlp --restrict-filenames` |
| `MAX_FILENAME_LENGTH` | — | Truncate filenames to this length |

### YouTube API (Optional)

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `YOUTUBE_API_KEY` | — | YouTube Data API v3 key (public/unlisted playlists only) |
| `YOUTUBE_CLIENT_ID` | — | OAuth2 client ID (all playlists including private) |
| `YOUTUBE_CLIENT_SECRET` | — | OAuth2 client secret |
| `YOUTUBE_REFRESH_TOKEN` | — | OAuth2 refresh token |

> **Note:** OAuth2 takes priority over API key if both are set. See
> [YouTube Auth & Scraping](YOUTUBE_AUTH_AND_SCRAPING.md) for full details.

### Scheduling

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `UPDATE_SCHEDULED` | `*/30 * * * *` | Cron expression for playlist update checks |
| `PRUNE_INTERVAL` | `*/30 * * * *` | Cron expression for orphan video pruning |
| `CLEANUP_INTERVAL` | `*/10 * * * *` | Cron expression for stale process cleanup |
| `PROCESS_MAX_AGE` | `300000` | Max process age in ms before cleanup kills it |
| `TZ_PREFERRED` | `Asia/Kolkata` | Timezone for cron job scheduling |

### Authentication

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `SECRET_KEY_FILE` | — | Path to file containing the JWT signing key |
| `SECRET_KEY` | — | Direct JWT key (fallback) |
| `ALLOW_REGISTRATION` | `true` | Allow new user sign-ups |
| `MAX_USERS` | `15` | Maximum number of allowed user accounts |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `10` | Rate limit: max requests per IP per window. Set to 0 to disable throttling. |
| `RATE_LIMIT_ACTION_MAX_REQUESTS` | `10` | Rate limit: max requests for actions per window. Set to 0 to disable throttling. |
| `CACHE_MAX_AGE` | `3600` | Rate limit window in seconds |
| `CACHE_MAX_ITEMS` | `100` | Max entries in the rate limit cache in memory |
| `ACTION_WINDOW_SEC` | `3600` | Rate limit window for specific actions in seconds |

### Iwara (Optional)

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `IWARA_CONF_FILE` | — | Path to JSON file with `username` and `password` |
| `IWARA_CONF` | — | Direct JSON string (fallback) |
| `IWARA_USERNAME` | — | Iwara username (overrides JSON config) |
| `IWARA_PASSWORD` | — | Iwara password (overrides JSON config) |

---

## Database Backup & Restore

### Backups

The `pgbackups` container automatically takes **daily compressed backups**. Backups
are stored in the path configured by `DB_BACKUP_LOCATION` and retained for 7 days.

### Restore

Use the included `restore_db.sh` script:

```bash
# Restore into the existing database
./restore_db.sh /path/to/backup.sql.gz

# Drop and recreate the database first, then restore
./restore_db.sh /path/to/backup.sql.gz --drop
```

---

## Further Reading

- [API Endpoints](API_ENDPOINTS.md) — All HTTP endpoints and WebSocket events
- [Database Schema](DATABASE_SCHEMA.md) — Table definitions and relationships
- [Listing & Updating](LISTING_AND_UPDATING.md) — How playlists are parsed and
  monitored
- [YouTube Auth & Scraping](YOUTUBE_AUTH_AND_SCRAPING.md) — YouTube Data API,
  cookie handling, and authentication modes
- [Download Behavior](DOWNLOAD_BEHAVIOR.md) — Concurrency control and download
  pipeline
- [Deletion Behavior](DELETION_BEHAVIOR.md) — Playlist/video deletion flows
- [Automated Jobs](AUTOMATED_JOBS.md) — Background cron job details
- [Search](search.md) — Search syntax for the UI
