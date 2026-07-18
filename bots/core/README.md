# yt-diff Bot Core

Shared TypeScript library for yt-diff bot platform adapters (Discord, Telegram).

## What it does

- **URL parser** — extracts YouTube Shorts, regular YouTube videos, x.com posts, and other yt-dlp-supported URLs from chat messages. Rejects playlists and channels.
- **API client** — typed wrapper around the yt-diff REST API. Handles the full bot workflow: lookup → index → download → get signed URL.
- **Bot authentication** — uses the `X-Bot-Key` header with the `BOT_API_KEY` shared secret.

## Usage

```typescript
import { YtdiffApiClient, parseUrl } from "./mod.ts";

const client = new YtdiffApiClient({
  mode: "persistent",
  ephemeralTtlHours: 24,
  ytdiffApiBase: "http://localhost:8888/ytdiff",
  ytdiffAuthToken: Deno.env.get("BOT_API_KEY")!,
  maxDirectFileSize: 50 * 1024 * 1024,
  signedUrlTtlSeconds: 86400,
});

// Flow: lookup → index → download → signed URL
const result = await client.lookup("https://youtu.be/dQw4w9WgXcQ");
if (result.needsListing) await client.submitForListing(url);
if (result.needsDownload) await client.startDownload(url);
const signed = await client.getSignedUrl(fileName, saveDirectory);
```

## Test

```bash
deno test --allow-read bots/core/url-parser.test.ts
```
