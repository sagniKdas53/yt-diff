# YouTube Authentication & Scraping Behavior

This document describes how yt-diff decides which method to use when listing (indexing) and downloading YouTube content.

## Overview

yt-diff supports three authentication methods for YouTube, each suited to different use cases:

| Method | Env Vars | Use Case |
|---|---|---|
| **OAuth2** | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | All playlists and channels (public, unlisted, private) |
| **API Key** | `YOUTUBE_API_KEY` | Public and unlisted playlists/channels only |
| **Cookies** | `COOKIES_FILE` | Watch Later, Liked Videos, and any site requiring login (x.com, etc.) |

> **Note:** OAuth2 takes priority over API Key when both are configured.

## Listing (Indexing Playlist/Channel Items)

When a URL is submitted for listing, the following decision flow determines the method used:

```mermaid
flowchart TD
    A["URL submitted for listing"] --> B{"Is it a YouTube URL?"}
    B -->|No| C["yt-dlp\n(with cookies if configured)"]
    B -->|Yes| D{"Is it Watch Later (WL)\nor Liked Videos (LL)?"}
    D -->|Yes| E["yt-dlp + cookies\n(API blocked by Google)"]
    D -->|No| F{"YouTube API\ncredentials configured?"}
    F -->|OAuth2 configured| G["YouTube Data API v3\n(OAuth2 Bearer token)"]
    F -->|API Key configured| H["YouTube Data API v3\n(API key query param)"]
    F -->|Neither| C
    G -->|API fails| C
    H -->|API fails| C
```

### YouTube Data API Path (Fast)

Used for **all YouTube playlists and channels** when API credentials are configured.

- Fetches items via `playlistItems.list` endpoint (50 items/page)
- A 5,000-item playlist completes in ~50 seconds
- Channel URLs (`/@handle/videos`) are resolved to their uploads playlist via `channels.list`
- Items are converted to yt-dlp-compatible format for seamless DB integration
- Falls back to yt-dlp on any API failure

### yt-dlp Path (Slow, but universal)

Used as a fallback, or when no API credentials are configured.

- Fetches full metadata per video via `yt-dlp --dump-json`
- A 5,000-item playlist takes ~5 hours
- Protected by the smarter cleanup logic that prevents premature process termination
- Requires `COOKIES_FILE` for private content

### System Playlists (WL, LL)

Google intentionally blocked API access to Watch Later and Liked Videos in 2016. These always return 0 items via the API, even with valid OAuth2 credentials. They **must** use yt-dlp with cookies.

## Downloading (Fetching Video Files)

Downloads **always use yt-dlp**, regardless of API configuration. The YouTube Data API cannot download video files.

If `COOKIES_FILE` is set, yt-dlp receives `--cookies <file>` for YouTube URLs. This is needed for:

- Age-restricted videos
- Members-only content
- Any video requiring authentication

## Channel URL Support

Channel URLs are resolved to their uploads playlist via the YouTube Data API:

| URL Format | Example | Resolution |
|---|---|---|
| `/@handle` | `/@Hibiki_dad/videos` | `channels.list?forHandle=Hibiki_dad` → uploads playlist `UU...` |
| `/channel/UCxxxx` | `/channel/UC1234` | Direct conversion: `UC1234` → `UU1234` |
| `/c/name` | `/c/ChannelName/videos` | `channels.list?forHandle=ChannelName` → uploads playlist `UU...` |

The resolved uploads playlist is then fetched using the same `playlistItems.list` pagination as regular playlists.

## Cookie Files

Cookie files use the Netscape format and are configured via environment variables. Each site can have its own cookie file, with a global fallback:

| Env Var | Applies To | Notes |
|---|---|---|
| `X_COOKIES_FILE` | x.com only | Site-specific, highest priority for x.com |
| `YOUTUBE_COOKIES_FILE` | youtube.com only | Site-specific, needed for WL/LL and authenticated downloads |
| `COOKIES_FILE` | Any site (global fallback) | Used when no site-specific var is set |

**Resolution order per site:**
- **x.com**: `X_COOKIES_FILE` → `COOKIES_FILE`
- **YouTube**: `YOUTUBE_COOKIES_FILE` → `COOKIES_FILE`

This means you can safely set `X_COOKIES_FILE` for x.com without cookies being passed to YouTube, and vice versa. If you only want cookies for x.com and YouTube API for playlists, just set `X_COOKIES_FILE` — YouTube won't receive any cookies.

### Cookie file format

```
# Netscape HTTP Cookie File
.youtube.com    TRUE    /    FALSE    0    SID        <value>
.x.com          TRUE    /    TRUE     0    auth_token <value>
```

> **Note:** Even within a single cookie file, yt-dlp only sends cookies to their matching domain. YouTube cookies are never sent to x.com and vice versa. The per-site env vars are an extra layer of control over which sites receive cookies at all.

## API Quota

The YouTube Data API v3 has a daily quota of **10,000 units** on the free tier.

| Operation | Cost | Example |
|---|---|---|
| `playlistItems.list` (1 page, up to 50 items) | 1 unit | 5,000-item playlist = 100 units |
| `channels.list` (resolve handle) | 1 unit | Once per channel URL |

This allows ~100 full scrapes of 5,000-item playlists per day.

## Playlist Duplicate Handling

YouTube allows the same video at multiple positions in a playlist. yt-diff matches this behavior:

- **Real playlists**: Duplicates are allowed. Each occurrence creates a separate mapping at its own position.
- **"None" playlist** (unlisted/unplaylisted videos): Duplicates are **not** allowed. Adding a video that already exists updates its position instead of creating a duplicate.

## Configuration Examples

### Scenario: x.com cookies only, YouTube via API (no YouTube cookies)

```bash
X_COOKIES_FILE=x_cookies.txt YOUTUBE_CLIENT_ID=<id> YOUTUBE_CLIENT_SECRET=<secret> YOUTUBE_REFRESH_TOKEN=<token>
```

- x.com: yt-dlp with cookies ✓
- YouTube public playlists/channels: API ✓
- YouTube WL/LL: Not accessible (no YouTube cookies set)

### Scenario: Both sites with separate cookie files + YouTube API

```bash
X_COOKIES_FILE=x_cookies.txt YOUTUBE_COOKIES_FILE=yt_cookies.txt YOUTUBE_CLIENT_ID=<id> YOUTUBE_CLIENT_SECRET=<secret> YOUTUBE_REFRESH_TOKEN=<token>
```

- x.com: yt-dlp with `x_cookies.txt` ✓
- YouTube public playlists/channels: API ✓
- YouTube WL/LL: yt-dlp with `yt_cookies.txt` ✓
- No cookie cross-contamination between sites

### Scenario: Single shared cookie file (simple, backward-compatible)

```bash
COOKIES_FILE=all_cookies.txt
```

- x.com: yt-dlp with `all_cookies.txt` ✓
- YouTube: yt-dlp with `all_cookies.txt` ✓ (no API — uses yt-dlp for everything)

### Docker Compose

```yaml
environment:
  # YouTube API (for fast playlist/channel listing)
  - YOUTUBE_CLIENT_ID=<id>
  - YOUTUBE_CLIENT_SECRET=<secret>
  - YOUTUBE_REFRESH_TOKEN=<token>
  # Per-site cookies (isolated, no cross-contamination)
  - X_COOKIES_FILE=/run/secrets/x_cookies
  - YOUTUBE_COOKIES_FILE=/run/secrets/yt_cookies
  # OR use a single global file for all sites:
  # - COOKIES_FILE=/run/secrets/all_cookies
```
