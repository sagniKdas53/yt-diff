# yt-diff Bot Integration — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a platform-agnostic bot layer that allows users to send a YouTube Shorts or x.com link via Discord/Telegram, receive the video file back directly (for small files) or a signed URL (for large files), with configurable ephemeral (auto-delete after 24h) or persistent mode.

**Architecture:** A new `bots/` directory in the monorepo containing a shared core library (`bot-core`) that wraps the existing yt-diff API (URL canonicalization, listing, downloading, signed file serving) and exposes it via a platform-agnostic handler interface. Platform adapters (Discord, Telegram) consume this core and handle platform-specific message formatting, size limits, and delivery mechanics. The core is written in TypeScript/Deno to share types and utilities with the backend, while platform adapters can be Deno or Node.js as needed. The entire bot stack ships as an optional Docker Compose service alongside yt-diff.

**Tech Stack:** Deno/TypeScript (shared with backend), yt-diff REST API (internal), Discord.js or discord-http for Discord, grammY or telegraf for Telegram, Docker for deployment.

---

## Repository Improvements Discovered During Analysis

These are issues in the existing codebase worth documenting before the bot work:

### 1. `src/handlers/pipeline/types.ts` is empty
**File:** `/opt/data/yt-diff/src/handlers/pipeline/types.ts` — reads as 0 bytes / 0 lines. The import chain expects `types.ts` to exist (pipeline/index.ts imports from it, listing.ts imports from it heavily). This file appears empty after fresh clone, which means the pipeline handlers likely import from the wrong path. **Investigate before starting bot work** — if this is genuinely missing, the backend won't compile.

### 2. `config.ts` mutates global state
The `config` object is exported as a mutable global and is directly mutated in `index.ts`:
```typescript
config.cookiesFile = false;  // line 90
config.proxy_string = "";    // line 99
```
This is fragile — modules importing `config` may see different values depending on import order. **Documented, not blocking.**

### 3. Signed URL TTL is tied to `cache.maxAge` (1 hour default)
The `/getfile` endpoint creates signed URLs that expire after `config.cache.maxAge` seconds (default 3600 = 1 hour). For bot use cases where a user might click a link hours later, this is too short. The bot should generate fresh signed URLs on-demand or use a longer-lived mechanism. **This is a design constraint the bot plan must address.**

### 4. No API endpoint to lookup video by URL directly
There's no single endpoint that says "given a URL, tell me if it's downloaded, its size, and its file path." The bot needs to:
1. Call `/getsub` with a playlist filter (requires knowing the playlist)
2. Or query the DB directly

**The bot plan adds a new `/lookup` endpoint** to solve this cleanly.

### 5. `playlistRegex` in types.ts matches playlists — useful for distinguishing single videos from playlists
The regex `/playlist|list=|creators|videos$\b/i` is used to detect playlist URLs. The bot can reuse this to reject playlist URLs (user sends a single video).

---

## Architecture Decision Record

### ADR-1: Bot-core is Deno/TypeScript, lives in the monorepo
**Decision:** The shared bot logic is a Deno library in `bots/core/` that directly imports types and utilities from `src/`. Platform adapters consume it as a library.
**Rationale:** Reuses URL canonicalization, site detection, and type definitions. Avoids duplicating the 200+ line URL normalizer. Single source of truth for API contracts.
**Trade-off:** Platform adapters that need Node.js-specific libraries (Discord.js) must run separately, but the core can be vendored or re-bundled.

### ADR-2: Bot speaks to yt-diff via its REST API, not direct DB access
**Decision:** All bot operations go through the HTTP API (or a new internal endpoint). No direct PostgreSQL/Redis access.
**Rationale:** Maintains single auth surface, rate limiting, and validation. Avoids bot becoming a second backend.
**Trade-off:** Slightly higher latency vs direct DB queries. Acceptable for a bot responding to human-speed interactions.

### ADR-3: Add a `/lookup` endpoint to the backend
**Decision:** Create `POST /ytdiff/lookup` that accepts `{ url: string }` and returns video metadata including download status, file path, and size.
**Rationale:** The bot's primary flow — "user sends URL → bot responds with video" — requires answering "is this downloaded? how big is it?" in one call. Existing endpoints can't do this without knowing the playlist.
**Trade-off:** New API surface to maintain. But it's a thin read-only wrapper over existing DB queries.

### ADR-4: Ephemeral mode uses a TTL column, not cron-based deletion
**Decision:** Add an `ephemeral_ttl` column to `video_metadata` (nullable timestamp). When set, the existing prune cron job checks it and deletes expired entries + files.
**Rationale:** Reuses the existing prune infrastructure (`PRUNE_INTERVAL` cron). Simple to implement. No new cron jobs needed.
**Trade-off:** Deletion granularity is limited to the prune interval (default 30 min). Acceptable — ephemeral means "delete after ~24h," not "delete at exactly 24h."

### ADR-5: Platform adapters are separate processes, not embedded in Deno backend
**Decision:** Discord adapter is a Node.js process (due to Discord.js requirement). Telegram adapter can be Deno or Node.js. Both run as Docker Compose services alongside yt-diff.
**Rationale:** Discord.js v14 requires Node.js ≥18. Embedding Node in the Deno backend is a packaging nightmare. Separate processes communicate via the REST API.
**Trade-off:** More containers. But Docker Compose hides this from the operator — one `docker compose up` starts everything.

### ADR-6: File delivery: ≤50MB direct, >50MB signed URL
**Decision:** The bot sends files ≤50MB as direct attachments (Discord has 25MB limit for non-boosted, 50MB for level 1; Telegram has 50MB bot API limit). Files >50MB get a freshly generated signed URL with a 24-hour TTL.
**Rationale:** Matches platform limits. Signed URL TTL extended from 1 hour to 24 hours for bot use (configurable via `BOT_SIGNED_URL_TTL`).
**Trade-off:** 24-hour signed URLs are less secure than 1-hour. Mitigated by limiting the signed URL endpoint to authenticated bot requests.

---

## Step-by-Step Plan

### Phase 0: Fix Critical Issue — Verify & Repair types.ts

#### Task 0.1: Verify `types.ts` is functional
**Objective:** Confirm `src/handlers/pipeline/types.ts` has content and the project compiles.

**Files:**
- Read: `src/handlers/pipeline/types.ts`
- Check: `deno check index.ts`

**Step 1: Read the file and verify content**
```bash
wc -l /opt/data/yt-diff/src/handlers/pipeline/types.ts
# Expected: 246 lines (from fresh clone)
# If 0: investigate git history or restore from submodule
```

**Step 2: Run type-check**
```bash
cd /opt/data/yt-diff && deno check index.ts
# Expected: no errors
```

**Step 3: If broken, restore from git**
```bash
cd /opt/data/yt-diff && git show HEAD:src/handlers/pipeline/types.ts > src/handlers/pipeline/types.ts
```

---

### Phase 1: Add `/lookup` Endpoint to Backend

#### Task 1.1: Create lookup handler
**Objective:** Build a handler that, given a single URL, returns video metadata with download status and file size.

**Files:**
- Create: `src/handlers/lookup.ts`
- Modify: `index.ts` (register the handler)
- Modify: `src/routes/api.ts` (add route)

**Implementation:**
```typescript
// src/handlers/lookup.ts
import { config } from "../config.ts";
import { VideoMetadata, PlaylistVideoMapping } from "../db/models.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { normalizeUrl } from "./pipeline/process-manager.ts";
import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
import { exists, stat } from "../utils/fs.ts";
import { join } from "../utils/path.ts";

export interface LookupRequestBody {
  url: string;
}

export interface LookupResponse {
  status: "found" | "not_found" | "error";
  video?: {
    videoId: string;
    title: string;
    videoUrl: string;
    downloadStatus: string;
    fileName: string | null;
    saveDirectory: string | null;
    fileSizeBytes: number | null;
    fileExists: boolean;
    thumbnailUrl: string | null;
    site: string;
  };
  message?: string;
}

export async function processLookupRequest(
  requestBody: LookupRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  const jsonMimeType = MIME_TYPES[".json"];

  try {
    if (!requestBody.url || typeof requestBody.url !== "string") {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "error",
        message: "url is required",
      }));
    }

    const normalizedUrl = normalizeUrl(requestBody.url);
    logger.debug("Lookup request", { original: requestBody.url, normalized: normalizedUrl });

    const video = await VideoMetadata.findOne({
      where: { videoUrl: normalizedUrl },
    });

    if (!video) {
      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "not_found",
        message: "URL not yet indexed. Submit it via /list first.",
      }));
    }

    // Determine file existence and size
    let fileExists = false;
    let fileSizeBytes: number | null = null;
    const fileName = video.getDataValue("fileName") as string | null;
    const saveDirectory = video.getDataValue("saveDirectory") as string | null;

    if (fileName && saveDirectory !== undefined) {
      const filePath = join(config.saveLocation, saveDirectory ?? "", fileName);
      try {
        if (await exists(filePath)) {
          const fileStats = await stat(filePath);
          fileSizeBytes = fileStats.size;
          fileExists = true;
        }
      } catch {
        // file doesn't exist — leave as false/null
      }
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({
      status: "found",
      video: {
        videoId: video.getDataValue("videoId") as string,
        title: video.getDataValue("title") as string,
        videoUrl: video.getDataValue("videoUrl") as string,
        downloadStatus: video.getDataValue("downloadStatus") as string,
        fileName,
        saveDirectory,
        fileSizeBytes,
        fileExists,
        thumbnailUrl: video.getDataValue("thumbnailUrl") as string | null,
        site: video.getDataValue("site") as string,
      },
    }));
  } catch (error) {
    logger.error("Lookup error", { error: (error as Error).message });
    response.writeHead(500, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({
      status: "error",
      message: "Internal server error",
    }));
  }
}
```

**Verification:** `deno check src/handlers/lookup.ts` passes.

---

#### Task 1.2: Add lookup route to API routes
**Objective:** Wire the `/lookup` endpoint into the route table.

**Files:**
- Modify: `src/routes/api.ts` (add route entry and dependency interface)

**Changes:**
1. Add to `ApiRouteDependencies` interface:
```typescript
processLookupRequest: BodyHandler;
```

2. Add to `createApiRoutes` destructuring and route array:
```typescript
{
  method: "POST",
  path: config.urlBase + "/lookup",
  run: (req, res) => authenticateRequest(req, res, processLookupRequest),
},
```

**Verification:** `deno check src/routes/api.ts` passes.

---

#### Task 1.3: Register lookup handler in index.ts
**Objective:** Wire the new handler into the main server entry point.

**Files:**
- Modify: `index.ts` (add import, instantiation, route registration)

**Changes:**
1. Import: `import { processLookupRequest } from "./src/handlers/lookup.ts";`
2. Pass `processLookupRequest` into `createApiRoutes(...)` call

**Verification:** `deno check index.ts` passes, `deno task check` passes.

---

#### Task 1.4: Add ephemeral_ttl column to database schema
**Objective:** Add `ephemeral_ttl` column to `video_metadata` table for TTL-based auto-deletion.

**Files:**
- Modify: `src/db/models.ts` (add column to VideoMetadata model)

**Implementation:**
```typescript
// In VideoMetadata.init(), add:
ephemeralTtl: {
  type: DataTypes.DATE,
  allowNull: true,
  defaultValue: null,
  comment: "If set, video+file will be deleted after this timestamp",
},
```

**Migration strategy:** Sequelize `sync({ alter: true })` handles this. No manual SQL needed.

**Verification:** `deno check src/db/models.ts` passes.

---

### Phase 2: Bot Core Library

#### Task 2.1: Create bot-core directory and types
**Objective:** Set up the shared bot library structure.

**Files:**
- Create: `bots/core/mod.ts` (public API surface)
- Create: `bots/core/types.ts` (shared types)
- Create: `bots/core/deno.json` (Deno imports)

**Implementation (`bots/core/types.ts`):**
```typescript
/** What the bot receives from the platform */
export interface BotIncomingMessage {
  text: string;
  senderId: string;
  chatId: string;
  platform: "discord" | "telegram";
}

/** URL extracted from a message with its canonical form */
export interface ParsedUrl {
  original: string;
  canonical: string;
  site: "youtube" | "x.com" | "other";
  isShorts: boolean;
  isValidVideo: boolean;
  reason?: string; // if invalid
}

/** Result of looking up a URL */
export interface VideoLookupResult {
  found: boolean;
  indexed: boolean;
  downloaded: boolean;
  title?: string;
  fileName?: string;
  fileSizeBytes?: number;
  fileExists: boolean;
  needsListing: boolean; // URL not yet in DB
  needsDownload: boolean; // URL indexed but not downloaded
}

/** What the bot sends back to the user */
export interface BotOutgoingMessage {
  chatId: string;
  text?: string;
  file?: {
    path: string;
    mimeType: string;
    sizeBytes: number;
    fileName: string;
  };
  signedUrl?: {
    url: string;
    expiryUnix: number;
    fileName: string;
    mimeType: string;
  };
  error?: string;
}

/** Bot configuration */
export interface BotConfig {
  mode: "ephemeral" | "persistent";
  ephemeralTtlHours: number;
  ytdiffApiBase: string;
  ytdiffAuthToken: string;
  maxDirectFileSize: number; // bytes, platform-dependent
  signedUrlTtlSeconds: number;
}
```

---

#### Task 2.2: Implement URL parser in bot-core
**Objective:** Parse incoming messages to extract URLs, determine site, and validate they're single videos (not playlists).

**Files:**
- Create: `bots/core/url-parser.ts`

**Implementation:**
```typescript
import type { ParsedUrl } from "./types.ts";

const YT_SHORTS_RE = /\/shorts\//;
const YT_VIDEO_RE = /youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\//;
const X_COM_RE = /(?:x\.com|twitter\.com)\/\w+\/status\/\d+/;
const PLAYLIST_RE = /[?&]list=|playlist\?list=/;

export function parseUrl(raw: string): ParsedUrl | null {
  const trimmed = raw.trim();
  
  // Extract URL from message text
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return null;
  
  const original = urlMatch[0];
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return { original, canonical: original, site: "other", isShorts: false, isValidVideo: false, reason: "Invalid URL" };
  }

  // Detect site
  const host = url.hostname.replace(/^www\./, "");
  
  if (["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) {
    const isShorts = YT_SHORTS_RE.test(url.pathname);
    const isPlaylist = PLAYLIST_RE.test(url.search) || /\/playlist/.test(url.pathname);
    
    if (isPlaylist) {
      return { original, canonical: original, site: "youtube", isShorts: false, isValidVideo: false, reason: "Playlists not supported — send a single video URL" };
    }

    // Canonicalize: extract video ID, rebuild as watch?v=ID
    let videoId: string | null = null;
    const v = url.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) videoId = v;
    if (!videoId) {
      const shortsMatch = url.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (shortsMatch) videoId = shortsMatch[1];
    }
    if (!videoId && (host === "youtu.be")) {
      const id = url.pathname.slice(1).split("/")[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) videoId = id;
    }

    if (!videoId) {
      return { original, canonical: original, site: "youtube", isShorts, isValidVideo: false, reason: "Could not extract video ID" };
    }

    const canonical = `https://www.youtube.com/watch?v=${videoId}`;
    return { original, canonical, site: "youtube", isShorts, isValidVideo: true };
  }

  if (["x.com", "twitter.com"].includes(host)) {
    // x.com status URLs are single videos/posts
    const isStatus = /\/status\/\d+/.test(url.pathname);
    return {
      original,
      canonical: original, // x.com URLs don't need canonicalization for yt-dlp
      site: "x.com",
      isShorts: false,
      isValidVideo: isStatus,
      reason: isStatus ? undefined : "x.com URLs must be status/post links",
    };
  }

  // Other sites — yt-dlp supports hundreds
  return { original, canonical: original, site: "other", isShorts: false, isValidVideo: true };
}
```

**Verification:** Write and run unit tests (see Task 2.4).

---

#### Task 2.3: Implement yt-diff API client in bot-core
**Objective:** Create a typed client that wraps the yt-diff REST API for bot operations.

**Files:**
- Create: `bots/core/api-client.ts`

**Implementation:**
```typescript
import type { BotConfig, VideoLookupResult } from "./types.ts";
import { parseUrl } from "./url-parser.ts";

interface SignedUrlResponse {
  status: string;
  signedUrlId?: string;
  expiry?: number;
  message?: string;
}

interface LookupApiResponse {
  status: string;
  video?: {
    videoId: string;
    title: string;
    videoUrl: string;
    downloadStatus: string;
    fileName: string | null;
    saveDirectory: string | null;
    fileSizeBytes: number | null;
    fileExists: boolean;
  };
  message?: string;
}

interface ListApiResponse {
  status: string;
  message?: string;
}

interface DownloadApiResponse {
  status: string;
  error?: string;
  queue?: Array<{ url: string; title: string; status: string; queuePosition: number }>;
}

export class YtdiffApiClient {
  constructor(private config: BotConfig) {}

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.config.ytdiffApiBase}${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.ytdiffAuthToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`yt-diff API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /** Check if a URL exists in the database and get its metadata */
  async lookup(rawUrl: string): Promise<VideoLookupResult> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) {
      return { found: false, indexed: false, downloaded: false, needsListing: true, needsDownload: false, fileExists: false };
    }

    try {
      const result = await this.post<LookupApiResponse>("/ytdiff/lookup", { url: parsed.canonical });
      
      if (result.status === "not_found") {
        return { found: false, indexed: false, downloaded: false, needsListing: true, needsDownload: false, fileExists: false };
      }

      if (result.status === "found" && result.video) {
        const v = result.video;
        return {
          found: true,
          indexed: true,
          downloaded: v.fileExists && v.downloadStatus === "downloaded",
          title: v.title,
          fileName: v.fileName ?? undefined,
          fileSizeBytes: v.fileSizeBytes ?? undefined,
          fileExists: v.fileExists,
          needsListing: false,
          needsDownload: !v.fileExists,
        };
      }

      return { found: false, indexed: false, downloaded: false, needsListing: true, needsDownload: false, fileExists: false };
    } catch {
      return { found: false, indexed: false, downloaded: false, needsListing: true, needsDownload: false, fileExists: false };
    }
  }

  /** Submit URL for indexing */
  async submitForListing(rawUrl: string): Promise<boolean> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) return false;

    try {
      const result = await this.post<ListApiResponse>("/ytdiff/list", {
        urlList: [parsed.canonical],
        monitoringType: this.config.mode === "ephemeral" ? "N/A" : "End",
      });
      return result.status === "success";
    } catch {
      return false;
    }
  }

  /** Start download for a URL */
  async startDownload(rawUrl: string): Promise<{ queued: boolean; position?: number }> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) return { queued: false };

    try {
      const result = await this.post<DownloadApiResponse>("/ytdiff/download", {
        urlList: [parsed.canonical],
        playListUrl: this.config.mode === "ephemeral" ? "None" : undefined,
      });

      if (result.status === "success" && result.queue?.length) {
        return { queued: true, position: result.queue[0].queuePosition };
      }
      return { queued: false };
    } catch {
      return { queued: false };
    }
  }

  /** Get a signed download URL for a video file */
  async getSignedUrl(fileName: string, saveDirectory: string): Promise<SignedUrlResponse> {
    return this.post<SignedUrlResponse>("/ytdiff/getfile", {
      fileName,
      saveDirectory,
    });
  }

  /** Check download queue status */
  async getQueueStatus(): Promise<Array<{ url: string; status: string; queuePosition: number }>> {
    try {
      const result = await this.post<{ status: string; queue: Array<{ url: string; title: string; status: string; queuePosition: number }> }>("/ytdiff/queuestatus", {});
      return result.queue || [];
    } catch {
      return [];
    }
  }
}
```

---

#### Task 2.4: Write unit tests for bot-core
**Objective:** Test URL parser and API client logic.

**Files:**
- Create: `bots/core/url-parser.test.ts`
- Create: `bots/core/api-client.test.ts`

**Test cases (url-parser):**
- YouTube Shorts URL → site=youtube, isShorts=true, isValidVideo=true
- YouTube watch URL → site=youtube, isValidVideo=true
- youtu.be URL → site=youtube, isValidVideo=true
- YouTube playlist URL → isValidVideo=false, reason contains "playlist"
- x.com status URL → site=x.com, isValidVideo=true
- Random garbage text → returns null
- URL without video ID (youtube.com/channel/...) → isValidVideo=false

**Verification:**
```bash
cd /opt/data/yt-diff && deno test --allow-read --allow-net bots/core/
# Expected: all pass
```

---

### Phase 3: Backend Changes for Ephemeral Mode

#### Task 3.1: Extend prune job to handle ephemeral_ttl
**Objective:** Modify the existing prune cron job to delete videos whose `ephemeralTtl` has passed.

**Files:**
- Modify: `src/jobs/index.ts` (add ephemeral check to prune logic)

**Implementation:** In the prune handler, after existing orphan logic, add:
```typescript
// Ephemeral cleanup: delete videos past their TTL
const expiredVideos = await VideoMetadata.findAll({
  where: {
    ephemeralTtl: { [Op.lt]: new Date() },
    ephemeralTtl: { [Op.ne]: null },
  },
});

for (const video of expiredVideos) {
  // Delete file on disk
  const saveDir = video.getDataValue("saveDirectory") as string;
  const fileName = video.getDataValue("fileName") as string;
  if (fileName && saveDir) {
    const filePath = join(config.saveLocation, saveDir, fileName);
    try { await Deno.remove(filePath); } catch { /* file may already be gone */ }
  }
  // Remove playlist mappings
  await PlaylistVideoMapping.destroy({ where: { videoUrl: video.getDataValue("videoUrl") } });
  // Remove video record
  await video.destroy();
  logger.info("Ephemeral video expired and deleted", { title: video.getDataValue("title") });
}
```

**Verification:** Unit test with mocked `Date` to verify expired videos are caught.

---

### Phase 4: Platform Adapters

#### Task 4.1: Create Discord bot adapter (Node.js)
**Objective:** Build a Discord bot that accepts YouTube/x.com links and delivers videos.

**Files:**
- Create: `bots/discord/package.json`
- Create: `bots/discord/src/index.ts` (entry point)
- Create: `bots/discord/src/handler.ts` (message handler)
- Create: `bots/discord/Dockerfile`
- Create: `bots/discord/.env.example`

**Flow:**
1. User sends message containing URL in a DM or channel
2. Bot extracts URL, calls `/lookup`
3. If not indexed → calls `/list` to index → polls `/queuestatus` → calls `/download`
4. If indexed but not downloaded → calls `/download` → polls `/queuestatus`
5. If downloaded → checks file size
6. ≤25MB (Discord free limit) → generates signed URL, fetches file, sends as attachment
7. >25MB → sends signed URL as message with expiry info
8. In ephemeral mode → sets ephemeralTtl when submitting to /list

**Package.json dependencies:**
```json
{
  "name": "yt-diff-discord-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.ts",
    "dev": "node --watch src/index.ts"
  },
  "dependencies": {
    "discord.js": "^14.16.0",
    "dotenv": "^16.4.0"
  }
}
```

---

#### Task 4.2: Create Telegram bot adapter (Deno)
**Objective:** Build a Telegram bot using grammY (Deno-compatible) with the same flow.

**Files:**
- Create: `bots/telegram/mod.ts`
- Create: `bots/telegram/handler.ts`
- Create: `bots/telegram/Dockerfile`
- Create: `bots/telegram/.env.example`

**Note:** The existing `telegram-integration` skill describes a Node.js/Telegraf bot. This new adapter is a clean Deno rewrite aligned with the shared bot-core library.

---

#### Task 4.3: Add bot services to docker-compose.yml
**Objective:** Make bots start alongside yt-diff.

**Files:**
- Modify: `docker-compose.yml` (add discord-bot and telegram-bot services)

**Implementation:**
```yaml
  discord-bot:
    build:
      context: ./bots/discord
    container_name: yt-diff-discord-bot
    restart: unless-stopped
    depends_on:
      yt-diff:
        condition: service_healthy
    networks:
      - revProxy-net
    environment:
      - DISCORD_TOKEN=${DISCORD_BOT_TOKEN}
      - YTDIFF_API_BASE=http://yt-diff:${PORT}${BASE_URL}
      - YTDIFF_AUTH_TOKEN=${BOT_AUTH_TOKEN}
      - BOT_MODE=${BOT_MODE:-persistent}
      - EPHEMERAL_TTL_HOURS=${EPHEMERAL_TTL_HOURS:-24}

  telegram-bot:
    build:
      context: ./bots/telegram
    container_name: yt-diff-telegram-bot
    restart: unless-stopped
    depends_on:
      yt-diff:
        condition: service_healthy
    networks:
      - revProxy-net
    environment:
      - TELEGRAM_TOKEN=${TELEGRAM_BOT_TOKEN}
      - YTDIFF_API_BASE=http://yt-diff:${PORT}${BASE_URL}
      - YTDIFF_AUTH_TOKEN=${BOT_AUTH_TOKEN}
      - BOT_MODE=${BOT_MODE:-persistent}
      - EPHEMERAL_TTL_HOURS=${EPHEMERAL_TTL_HOURS:-24}
```

---

### Phase 5: End-to-End Verification

#### Task 5.1: Integration test — full bot flow
**Objective:** Test the complete flow: URL submission → indexing → download → signed URL delivery.

**Files:**
- Create: `bots/core/integration.test.ts`

**Flow:**
1. POST `/ytdiff/lookup` with a YouTube URL → expect "not_found"
2. POST `/ytdiff/list` with the URL → expect "success"
3. Poll `/ytdiff/lookup` until `found.indexed === true`
4. POST `/ytdiff/download` → expect "success" with queue position
5. Poll `/ytdiff/lookup` until `downloaded === true`
6. POST `/ytdiff/getfile` → expect signed URL
7. GET signed URL → expect HTTP 200 with video file

**Verification:**
```bash
cd /opt/data/yt-diff && deno test --allow-all bots/core/integration.test.ts
```

---

## Configuration Variables (New)

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | — | Discord bot token from Developer Portal |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token from @BotFather |
| `BOT_AUTH_TOKEN` | — | JWT token for bot to authenticate with yt-diff API |
| `BOT_MODE` | `persistent` | `ephemeral` or `persistent` |
| `EPHEMERAL_TTL_HOURS` | `24` | Hours before ephemeral videos are auto-deleted |
| `BOT_MAX_DIRECT_FILE_SIZE` | `52428800` | Max bytes for direct file delivery (50MB) |
| `BOT_SIGNED_URL_TTL` | `86400` | TTL for signed URLs generated by bot (24h) |

---

## Risks & Open Questions

### Q1: Bot authentication — how does the bot get a JWT token?
**RESOLVED — Option A:** Add a `BOT_API_KEY` env var to the backend — a static shared secret that the bot sends in a `X-Bot-Key` header. Backend middleware checks it and bypasses JWT auth for bot-origin requests. Implementation: create `src/middleware/bot-auth.ts` that wraps `authenticateRequest` and checks for `X-Bot-Key` header before falling through to normal JWT auth.

### Q2: What happens when listing takes minutes and user is waiting?
**Risk:** yt-dlp listing a YouTube video takes 5-30 seconds. The user sends a link and expects a response in <5 seconds.
**Mitigation:** Bot responds immediately: "🔍 Fetching metadata..." then polls `/lookup` (which queries the DB) every 2 seconds. Once indexed, responds with the real result. If listing takes >30s, bot sends "Still processing…" and continues polling.

### Q3: Discord 25MB limit vs Telegram 50MB limit
**Risk:** Platform limits differ. Bot-core's `maxDirectFileSize` is per-platform. Discord adapter caps at 25MB (8MB for non-boosted servers); Telegram at 50MB. Files above the limit get signed URLs.
**Mitigation:** Per-adapter config overrides. Signed URLs always work regardless of size.

### Q4: x.com videos require cookies/auth — will bot work?
**Risk:** x.com (Twitter) often requires authentication cookies for yt-dlp to download. The backend already handles this via `COOKIES_FILE`.
**Mitigation:** Bot only controls listing/download flow. If the backend can't download due to auth, the bot surfaces the error: "⚠️ This video requires authentication. Ensure cookies are configured on the server."

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `src/handlers/pipeline/types.ts` | Verify/restore | 0 |
| `src/handlers/lookup.ts` | Create | 1 |
| `src/routes/api.ts` | Modify | 1 |
| `index.ts` | Modify | 1 |
| `src/db/models.ts` | Modify | 1 |
| `src/jobs/index.ts` | Modify | 3 |
| `bots/core/mod.ts` | Create | 2 |
| `bots/core/types.ts` | Create | 2 |
| `bots/core/url-parser.ts` | Create | 2 |
| `bots/core/api-client.ts` | Create | 2 |
| `bots/core/url-parser.test.ts` | Create | 2 |
| `bots/core/api-client.test.ts` | Create | 2 |
| `bots/core/integration.test.ts` | Create | 5 |
| `bots/discord/package.json` | Create | 4 |
| `bots/discord/src/index.ts` | Create | 4 |
| `bots/discord/src/handler.ts` | Create | 4 |
| `bots/discord/Dockerfile` | Create | 4 |
| `bots/telegram/mod.ts` | Create | 4 |
| `bots/telegram/handler.ts` | Create | 4 |
| `bots/telegram/Dockerfile` | Create | 4 |
| `docker-compose.yml` | Modify | 4 |
| `envs/base.env` | Modify (add bot vars) | 4 |

---

## Verification Checklist

- [ ] `deno check index.ts` passes (no type errors)
- [ ] `deno task test:unit` passes (existing tests intact)
- [ ] `POST /ytdiff/lookup` returns correct metadata for indexed video
- [ ] `POST /ytdiff/lookup` returns `not_found` for unknown URL
- [ ] URL parser correctly identifies YouTube Shorts, regular videos, x.com posts
- [ ] URL parser correctly rejects playlists
- [ ] Bot flow: submit URL → index → download → get signed URL (full circle)
- [ ] Ephemeral video auto-deleted after TTL expires
- [ ] `docker compose config` validates new bot services