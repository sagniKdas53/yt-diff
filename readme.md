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
- **Telegram Bot** — Submit links, browse playlists, and pull downloads straight from Telegram. Locked to an explicit chat allowlist (it refuses to start unrestricted), with `ephemeral` or `persistent` retention for submitted media.
- **Batch Re-index** — Re-list every monitored playlist in one pass to repair drifted metadata, with per-playlist progress streamed to the UI and a determinate progress bar.
- **Built-in Video Player** — Range-request streaming with a custom React player: queue management, continuous playback, and network resiliency.
- **Automated Background Jobs** — Process cleanup, scheduled playlist updates, and orphan video pruning all run on configurable cron schedules.
- **URL Deduplication** — Incoming URLs are canonicalized before storage: YouTube video IDs are extracted from any URL form (`youtu.be`, `m.youtube.com`, `watch?v=&list=...`), iwara.tv title slugs are stripped, and tracking parameters (`utm_*`, `si=`, `pp=`) are removed globally. A `/dedup` endpoint lets you scan and merge any existing duplicate records in one shot.

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
| **pgAdmin** | Web UI for direct database management — starts by default on port `8686` and is routed at `/pgadmin`; comment the service out if you don't want it |
| **Gluetun** | Optional VPN gateway (routes yt-dlp traffic through OpenVPN) |

## Quick Start

### Using Docker Compose (recommended)

1. **Clone the repo**

   ```bash
   git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
   cd yt-diff
   ```

2. **Configure environment** — edit `envs/base.env` for shared defaults and the deployment env file for host-specific values:

   ```ini
   # envs/base.env holds shared defaults

   # envs/local.env / envs/pi5.env / envs/pi4.env hold deployment-specific values
   HOSTNAME=your.hostname.here
   HOST_SAVE_PATH=/path/to/video/storage
   DB_LOCATION=/path/to/postgres/data
   DB_BACKUP_LOCATION=/path/to/backups
   ```

3. **Set up secrets** — create these files in the `secrets/` directory:

   | File | Contents |
   | :--- | :------- |
   | `secrets/db_password.txt` | PostgreSQL password |
   | `secrets/secret_key.txt` | JWT signing key (any random string) |
   | `secrets/proxy_string.txt` | *(optional)* HTTP proxy URL |
   | `secrets/iwara.json` | *(optional)* `{"username": "...", "password": "..."}` |
   | `secrets/bot_token.txt` | *(optional)* Telegram bot token — see [docs/BOT.md](docs/BOT.md) |

4. **Generate `.env` for your deployment**

   ```bash
   make local   # or: make pi5 / make pi4
   ```

5. **Start everything**

   ```bash
   docker compose up -d

   # Or build locally
   make local && make build && docker compose up -d
   ```

6. **Verify** — `curl http://localhost:8888/ytdiff/ping` should return `pong`

7. **Register** — open the web UI and create your first user account.

### Pre-built Image

Published to both registries on every merge to `master`, and public — no login needed to pull.

```bash
docker pull ghcr.io/sagnikdas53/yt-diff:latest
docker pull purevert/yt-diff:latest
```

| Tag | Points at | Use it for |
| --- | --- | --- |
| `latest` | current `master` | Deployments. This is the tag Watchtower follows, and what `docker-compose.yml` references. |
| `master`, `main` | current `master` | Aliases of `latest`. Both exist so neither branch-name guess fails. |
| `1.3.0` | that release | Pinning to an exact version. Note there is **no** leading `v`; the git tag is `v1.3.0` but `docker/metadata-action` strips it. |
| `1.3` / `1` | newest 1.3.x / 1.x | Auto-updating within a minor or major line. |
| `sha-a1b2c3d` | one commit | Rollback to a specific build. Kept for 7 days. |

Both images are `linux/amd64` and `linux/arm64`. Version tags are cut automatically from
[Conventional Commits](https://www.conventionalcommits.org/): a `feat:` on `master` bumps the
minor, a `fix:` bumps the patch, `BREAKING CHANGE:` bumps the major, and a merge with no
conventional prefix does not cut a release.

### Local Development

```bash
git clone --recurse-submodules https://github.com/sagniKdas53/yt-diff.git
cd yt-diff

# Warm the backend dependency cache
deno cache --lock=deno.lock index.ts

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Generate deployment env once, then start Postgres + Valkey
make local
docker compose up -d yt-db valkey

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
| `UPDATE_SCHEDULED` | `*/10 * * * *` | Cron schedule for playlist monitoring |
| `PRUNE_INTERVAL` | `*/10 * * * *` | Cron schedule for orphan cleanup |
| `MAX_DOWNLOADS` | `1` | Max concurrent download processes |
| `MAX_LISTINGS` | `1` | Max concurrent listing processes (the listing queue is strict FIFO, so a large batch delays later submissions) |
| `RESTRICT_FILENAMES` | `true` | Sanitize filenames for filesystem safety |
| `BOT_ENABLED` | `false` | Enable the Telegram bot (requires a token and a non-empty chat allowlist) |

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

> See [docs/SEARCH_SCOPED_AND_GLOBAL.md](docs/SEARCH_SCOPED_AND_GLOBAL.md) for the full search syntax reference.

### Monitoring & Background Jobs

Three automated cron jobs always run in the background, plus a fourth when the bot is enabled:

| Job | Default Schedule | Purpose |
| :-- | :--------------- | :------ |
| **Cleanup** | Every 10 min | Kills stale yt-dlp processes |
| **Update** | Every 10 min | Re-scans monitored playlists for new videos |
| **Prune** | Every 10 min | Handles orphaned videos (move to "None" or delete) |
| **Bot retention** | Hourly *(bot only)* | Reaps expired bot submissions in `ephemeral` mode |

Scheduled updates run silently by design — they do not push per-playlist progress to connected clients, unlike a user-initiated batch re-index.

> See [docs/AUTOMATED_JOBS.md](docs/AUTOMATED_JOBS.md) for detailed behavior.

## Documentation

| Document | Description |
| :------- | :---------- |
| [Getting Started](docs/GETTING_STARTED.md) | Setup guide, env var reference, backup/restore |
| [API Endpoints](docs/API_ENDPOINTS.md) | HTTP endpoints, URL normalization, and WebSocket events |
| [Database Schema](docs/DATABASE_SCHEMA.md) | Table definitions, indexes, deduplication logic |
| [Listing & Updating](docs/LISTING_AND_UPDATING.md) | Playlist parsing and monitoring modes |
| [Download Behavior](docs/DOWNLOAD_BEHAVIOR.md) | Concurrency control and download pipeline |
| [Deletion Behavior](docs/DELETION_BEHAVIOR.md) | Playlist/video deletion and pruning flows |
| [Automated Jobs](docs/AUTOMATED_JOBS.md) | Background cron job details |
| [Search](docs/SEARCH_SCOPED_AND_GLOBAL.md) | Search syntax for the UI |
| [Telegram Bot](docs/BOT.md) | Bot setup, commands, retention modes |
| [Video Player](docs/VIDEO_PLAYER.md) | Streaming backend and player UI |
| [YouTube Auth & Scraping](docs/YOUTUBE_AUTH_AND_SCRAPING.md) | Cookie auth and API-assisted listing |
| [Security & Quality Audit](docs/SECURITY_AND_QUALITY_AUDIT.md) | Full-tree audit findings, severities, and fix order |

## Makefile Commands

```bash
make local                 # Generate .env from base.env + local.env
make pi5                   # Generate .env from base.env + pi5.env
make pi4                   # Generate .env from base.env + pi4.env
make env TARGET=pi5        # Regenerate .env for a deployment and validate it
make build                 # Build without cache
make check                 # Validate compose config using generated .env
make down                  # Stop all containers
make logs                  # Follow container logs
```

## License

Copyright © 2026 Sagnik Das

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

See [LICENSE](LICENSE) for the full text, or visit <https://www.gnu.org/licenses/gpl-3.0.html>.
