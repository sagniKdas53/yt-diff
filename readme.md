# yt-diff

[![Build](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-build-and-push.yml/badge.svg)](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-build-and-push.yml)
![Top Lang](https://img.shields.io/github/languages/top/sagniKdas53/yt-diff)
![License](https://img.shields.io/github/license/sagniKdas53/yt-diff)

A self-hosted video archival platform powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). Index, monitor, and download videos from YouTube and [hundreds of other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) — all through a web interface with real-time progress tracking.

## Features

- **Playlist & Channel Monitoring** — Track playlists and channels with configurable strategies: scan from the top (`Start`), bottom (`End`), or do a full re-scan (`Full`). New videos are detected automatically on a cron schedule.
- **Concurrent Downloads** — Semaphore-controlled download queue with duplicate detection, WebSocket progress updates, and stale process cleanup.
- **Video Metadata Storage** — Every indexed video's metadata is stored in PostgreSQL, including thumbnails, descriptions, and pruned raw yt-dlp JSON output for future use.
- **Flexible Deletion** — Granular control over what gets deleted: playlist mappings, database records, and/or physical files on disk. Downloaded orphans are automatically preserved in a "None" bucket.
- **Powerful Search** — Regex and partial-match search across video titles and URLs, with a `global:` prefix for cross-playlist searches.
- **Signed File URLs** — Secure, time-limited download tokens prevent unauthenticated file access.
- **Site-Specific Support** — Built-in handling for Iwara credentials, browser cookie injection, and HTTP proxy routing through Gluetun VPN.
- **Automated Background Jobs** — Process cleanup, scheduled playlist updates, and orphan video pruning all run on configurable cron schedules.

## Architecture

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

| Component | Role |
| :-------- | :--- |
| **yt-diff** | Deno/TypeScript backend + React/MUI frontend (single container) |
| **PostgreSQL** | Stores video metadata, playlist info, user accounts, and playlist-video mappings |
| **Valkey** | Rate limiting and request caching |
| **pgbackups** | Automated daily database backups (7-day retention) |
| **pgAdmin** | Optional web UI for direct database management |
| **Gluetun** | Optional VPN gateway (routes yt-dlp traffic through OpenVPN) |

## Quick Start

### Using Docker Compose (recommended)

1. **Clone the repo**

   ```bash
   git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
   cd yt-diff
   ```

2. **Configure environment** — edit `.env` with your paths and preferences:

   ```ini
   HOSTNAME=your.hostname.here
   HOST_SAVE_PATH=/path/to/video/storage
   DB_LOCATION=/path/to/postgres/data
   DB_BACKUP_LOCATION=/path/to/backups
   ```

3. **Set up secrets** — create these files in the project root:

   | File | Contents |
   | :--- | :------- |
   | `db_password.txt` | PostgreSQL password |
   | `secret_key.txt` | JWT signing key (any random string) |
   | `proxy_string.txt` | *(optional)* HTTP proxy URL |
   | `iwara.json` | *(optional)* `{"username": "...", "password": "..."}` |

4. **Start everything**

   ```bash
   # Using pre-built image from GHCR
   make up

   # Or build locally
   make build && make up
   ```

5. **Verify** — `curl http://localhost:8888/ytdiff/ping` should return `pong`

6. **Register** — open the web UI and create your first user account.

### Pre-built Image

```
ghcr.io/sagnikdas53/yt-diff:master
```

### Local Development

```bash
git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
cd yt-diff

# Install backend deps
deno install

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Start Postgres + Valkey
docker compose --env-file .env --env-file .localenv up -d yt-db valkey

# Run the server (pick one)
deno task dev          # basic
deno task cookies      # with cookie auth
deno task proxy        # with proxy
deno task full         # everything enabled
```

## Requirements

| Dependency | Required | Notes |
| :--------- | :------: | :---- |
| **Deno** | ✅ | Runtime for the TypeScript backend |
| **PostgreSQL** | ✅ | Video/playlist metadata storage |
| **Valkey / Redis** | ✅ | Rate limiting and caching |
| **Python 3 + yt-dlp** | ✅ | `pip install -U "yt-dlp[default]"` |
| **Docker & Docker Compose** | ✅ | For production deployment |
| **ffmpeg** | Recommended | Media muxing and thumbnail extraction |
| **curl_cffi** | Optional | Browser impersonation for restrictive sites |
| **Linux** | ✅ | Not tested on Windows |

## Configuration

All configuration is done through environment variables. Key settings:

| Variable | Default | Description |
| :------- | :------ | :---------- |
| `PORT` | `8888` | HTTP listen port |
| `BASE_URL` | `/ytdiff` | URL prefix for all routes |
| `SAVE_PATH` | — | Root directory for downloaded files |
| `UPDATE_SCHEDULED` | `*/30 * * * *` | Cron schedule for playlist monitoring |
| `PRUNE_INTERVAL` | `*/30 * * * *` | Cron schedule for orphan cleanup |
| `MAX_DOWNLOADS` | `2` | Max concurrent download processes |
| `RESTRICT_FILENAMES` | `true` | Sanitize filenames for filesystem safety |

> For the full list of 30+ environment variables, see [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md#environment-variable-reference).

## Usage

### Adding Content

1. Open the web UI and click the **Add** button.
2. Paste a YouTube playlist URL, channel URL, or single video URL.
3. Choose a **monitoring type**:
   - `Start` — for channels where new uploads appear at the top
   - `End` — for playlists you append to at the bottom
   - `Full` — complete re-scan every cycle (bandwidth-intensive)
   - `N/A` — one-time index, no automatic monitoring
4. The server spawns `yt-dlp` to index all videos. Progress updates stream to the UI in real-time via WebSocket.

### Downloading

Select videos in the SubList panel and click **Download**. Files are saved to your configured `SAVE_PATH` organized by playlist subdirectory. The download queue uses a semaphore to limit concurrent processes and prevent duplicates.

### Searching

Both the playlist panel and video panel support search with special prefixes:

| Prefix | Scope | Example |
| :----- | :---- | :------ |
| *(none)* | Title (partial match) | `gaming` |
| `url:` | URL (partial match) | `url:@channelname` |
| `title:` | Title (regex) | `title:^My\|vlog` |
| `global:` | All playlists (regex) | `global:mmd` |

> See [docs/search.md](docs/search.md) for the full search syntax reference.

### Monitoring & Background Jobs

Three automated cron jobs run in the background:

| Job | Default Schedule | Purpose |
| :-- | :--------------- | :------ |
| **Cleanup** | Every 10 min | Kills stale yt-dlp processes |
| **Update** | Every 30 min | Re-scans monitored playlists for new videos |
| **Prune** | Every 30 min | Handles orphaned videos (move to "None" or delete) |

> See [docs/AUTOMATED_JOBS.md](docs/AUTOMATED_JOBS.md) for detailed behavior.

## Documentation

| Document | Description |
| :------- | :---------- |
| [Getting Started](docs/GETTING_STARTED.md) | Setup guide, env var reference, backup/restore |
| [API Endpoints](docs/API_ENDPOINTS.md) | HTTP endpoints and WebSocket events |
| [Database Schema](docs/DATABASE_SCHEMA.md) | Table definitions and relationships |
| [Listing & Updating](docs/LISTING_AND_UPDATING.md) | Playlist parsing and monitoring modes |
| [Download Behavior](docs/DOWNLOAD_BEHAVIOR.md) | Concurrency control and download pipeline |
| [Deletion Behavior](docs/DELETION_BEHAVIOR.md) | Playlist/video deletion and pruning flows |
| [Automated Jobs](docs/AUTOMATED_JOBS.md) | Background cron job details |
| [Search](docs/search.md) | Search syntax for the UI |

## Makefile Commands

```bash
make up                    # Start all containers
make up CONTAINER=yt-diff  # Start a specific container
make up-remote             # Start with remote env overrides
make build                 # Build without cache
make check                 # Validate compose config
make down                  # Stop all containers
make logs                  # Follow container logs
```

## License

ISC — see [LICENSE](LICENSE) for details.
