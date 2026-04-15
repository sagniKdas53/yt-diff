import { config } from "../config.ts";
import { logger } from "../logger.ts";

// --- Types ---

export interface YouTubeApiItem {
  videoId: string;
  title: string;
  thumbnail: string | null;
  position: number;
  videoUrl: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

interface PlaylistItemsResponse {
  kind: string;
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: Array<{
    snippet: {
      resourceId: {
        videoId: string;
      };
      title: string;
      position: number;
      thumbnails?: {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
        maxres?: { url: string };
      };
    };
    status?: {
      privacyStatus: string;
    };
  }>;
}

interface ChannelsResponse {
  items: Array<{
    id: string;
    contentDetails: {
      relatedPlaylists: {
        uploads: string;
      };
    };
  }>;
}

// --- Token Management ---

let tokenCache: TokenCache | null = null;

/**
 * Get auth parameters for YouTube API requests.
 * - OAuth mode: refreshes the access token and returns an Authorization header
 * - API key mode: returns the key as a query parameter
 */
async function getAuth(): Promise<{
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}> {
  const ytConfig = config.youtubeApi;
  if (!ytConfig) {
    throw new Error("YouTube API credentials not configured");
  }

  if (ytConfig.mode === "oauth") {
    const accessToken = await refreshAccessToken();
    return {
      headers: { Authorization: `Bearer ${accessToken}` },
      queryParams: {},
    };
  }

  // API key mode
  return {
    headers: {},
    queryParams: { key: ytConfig.apiKey! },
  };
}

/**
 * Refresh the OAuth2 access token using the refresh token.
 * Caches the token and only refreshes when expired (with 60s buffer).
 */
async function refreshAccessToken(): Promise<string> {
  const ytConfig = config.youtubeApi;
  if (!ytConfig || ytConfig.mode !== "oauth") {
    throw new Error("OAuth credentials not configured");
  }

  // Return cached token if still valid
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  logger.info("Refreshing YouTube API access token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ytConfig.clientId!,
      client_secret: ytConfig.clientSecret!,
      refresh_token: ytConfig.refreshToken!,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to refresh YouTube access token: ${response.status} ${errorBody}`,
    );
  }

  const data = await response.json();
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };

  logger.info("YouTube API access token refreshed successfully", {
    expiresIn: data.expires_in,
  });

  return tokenCache.accessToken;
}

// --- URL Helpers ---

/**
 * Extract the playlist ID from a YouTube URL.
 * Returns null for system playlists (WL, LL) that the YouTube API cannot access.
 *
 * Handles:
 *   - https://www.youtube.com/playlist?list=PLxxxx
 *   - https://www.youtube.com/watch?v=xxx&list=PLxxxx
 *
 * NOTE: Watch Later (WL) and Liked Videos (LL) are system playlists that
 * Google blocked from the Data API in 2016. They always return 0 items
 * even with valid OAuth2 credentials. These MUST use yt-dlp with cookies.
 */
export function extractPlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const listParam = parsed.searchParams.get("list");
    if (listParam) {
      // System playlists that the YouTube API cannot access
      const blockedIds = ["WL", "LL"];
      if (blockedIds.includes(listParam)) {
        logger.info(
          `Playlist ${listParam} is a system playlist, skipping YouTube API (must use yt-dlp with cookies)`,
        );
        return null;
      }
      return listParam;
    }

    const playlistMatch = /\/playlist\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
    if (playlistMatch) {
      return playlistMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect if a URL is a YouTube channel URL.
 * Matches:
 *   - https://www.youtube.com/@handle
 *   - https://www.youtube.com/@handle/videos
 *   - https://www.youtube.com/channel/UCxxxx
 *   - https://www.youtube.com/c/name/videos
 */
export function isChannelUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return /^\/@[^/]+/.test(pathname) ||
      /^\/channel\/UC[A-Za-z0-9_-]+/.test(pathname) ||
      /^\/c\/[^/]+/.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Resolve a YouTube channel URL to its uploads playlist ID.
 *
 * Every YouTube channel has a hidden "uploads" playlist. The playlist ID
 * is derived from the channel ID by replacing the 2nd character:
 * UC... → UU...
 *
 * For /@handle URLs, we need to call the channels.list API to resolve
 * the handle to a channel ID first.
 *
 * @param url - A YouTube channel URL
 * @returns The uploads playlist ID (UU...), or null if resolution fails
 */
export async function resolveChannelUploadsPlaylistId(
  url: string,
): Promise<string | null> {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    // Direct channel ID: /channel/UCxxxx
    const channelIdMatch = /^\/channel\/(UC[A-Za-z0-9_-]+)/.exec(pathname);
    if (channelIdMatch) {
      const uploadsId = "UU" + channelIdMatch[1].slice(2);
      logger.info("Resolved channel ID to uploads playlist", {
        channelId: channelIdMatch[1],
        uploadsPlaylistId: uploadsId,
      });
      return uploadsId;
    }

    // Handle-based URL: /@handle or /c/name
    const handleMatch = /^\/(@[^/]+)/.exec(pathname) ||
      /^\/c\/([^/]+)/.exec(pathname);
    if (!handleMatch) {
      return null;
    }

    const handle = handleMatch[1];
    logger.info("Resolving YouTube channel handle to uploads playlist", {
      handle,
      url,
    });

    const auth = await getAuth();
    const params = new URLSearchParams({
      part: "contentDetails",
      forHandle: handle.startsWith("@") ? handle.slice(1) : handle,
      ...auth.queryParams,
    });

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?${params}`,
      { headers: auth.headers },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `YouTube API channels.list failed: ${response.status} ${errorBody}`,
      );
    }

    const data: ChannelsResponse = await response.json();
    if (!data.items || data.items.length === 0) {
      logger.warn("No channel found for handle", { handle });
      return null;
    }

    const uploadsPlaylistId =
      data.items[0].contentDetails.relatedPlaylists.uploads;
    logger.info("Resolved channel handle to uploads playlist", {
      handle,
      channelId: data.items[0].id,
      uploadsPlaylistId,
    });

    return uploadsPlaylistId;
  } catch (error) {
    logger.error("Failed to resolve channel uploads playlist", {
      url,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Check if a URL is a YouTube URL.
 */
export function isYouTubeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const youtubeHosts = [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "m.youtube.com",
    ];
    return youtubeHosts.some((h) => hostname === h || hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

/**
 * Check if the YouTube API is configured (any auth mode).
 */
export function isYouTubeApiConfigured(): boolean {
  return config.youtubeApi !== null;
}

// --- Chunked Streaming API ---

/**
 * Fetch playlist items from the YouTube API and yield them in chunks.
 *
 * This is an AsyncGenerator that yields arrays of yt-dlp-compatible JSON strings,
 * `chunkSize` items at a time. The caller gets immediate feedback as each chunk
 * arrives rather than waiting for the full fetch to complete.
 *
 * Each page from the API returns up to 50 items. Chunks are assembled from
 * accumulated items and yielded as soon as a full chunk is ready.
 *
 * @param playlistId - The YouTube playlist ID
 * @param chunkSize - Number of items per yielded chunk
 */
export async function* fetchPlaylistItemsChunked(
  playlistId: string,
  chunkSize: number,
): AsyncGenerator<{ items: string[]; chunkStartIndex: number; totalExpected: number }> {
  let nextPageToken: string | undefined;
  let pageCount = 0;
  let totalItemsYielded = 0;
  let buffer: YouTubeApiItem[] = [];
  let totalExpected = 0;

  logger.info("Starting YouTube API chunked playlist fetch", {
    playlistId,
    chunkSize,
  });

  do {
    const auth = await getAuth();

    const params = new URLSearchParams({
      part: "snippet,status",
      playlistId: playlistId,
      maxResults: "50",
      ...auth.queryParams,
    });

    if (nextPageToken) {
      params.set("pageToken", nextPageToken);
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
      { headers: auth.headers },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `YouTube API playlistItems failed: ${response.status} ${errorBody}`,
      );
    }

    const data: PlaylistItemsResponse = await response.json();
    pageCount++;
    totalExpected = data.pageInfo.totalResults;

    // Parse items from this page
    for (const item of data.items) {
      const videoId = item.snippet.resourceId.videoId;
      const thumbnails = item.snippet.thumbnails;
      const thumbnail = thumbnails?.maxres?.url ||
        thumbnails?.high?.url ||
        thumbnails?.medium?.url ||
        thumbnails?.default?.url ||
        null;

      const isAvailable = !item.status ||
        item.status.privacyStatus !== "private";

      buffer.push({
        videoId,
        title: isAvailable ? item.snippet.title : "[Private video]",
        thumbnail,
        position: item.snippet.position,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }

    // Yield full chunks from the buffer
    while (buffer.length >= chunkSize) {
      const chunk = buffer.splice(0, chunkSize);
      const chunkStartIndex = totalItemsYielded + 1; // 1-indexed
      totalItemsYielded += chunk.length;

      yield {
        items: chunk.map(toYtDlpJsonString),
        chunkStartIndex,
        totalExpected,
      };
    }

    nextPageToken = data.nextPageToken;

    if (pageCount % 20 === 0) {
      logger.info("YouTube API fetch progress", {
        playlistId,
        pagesCompleted: pageCount,
        itemsFetched: totalItemsYielded + buffer.length,
        totalExpected,
      });
    }
  } while (nextPageToken);

  // Yield any remaining items in the buffer
  if (buffer.length > 0) {
    const chunkStartIndex = totalItemsYielded + 1;
    totalItemsYielded += buffer.length;

    yield {
      items: buffer.map(toYtDlpJsonString),
      chunkStartIndex,
      totalExpected,
    };
  }

  logger.info("YouTube API chunked playlist fetch complete", {
    playlistId,
    totalItems: totalItemsYielded,
    totalPages: pageCount,
  });
}

/**
 * Convert a YouTubeApiItem into a fake yt-dlp JSON string.
 * This allows the items to feed directly into processStreamingVideoInformation()
 * without any changes to the existing DB upsert logic.
 */
export function toYtDlpJsonString(item: YouTubeApiItem): string {
  return JSON.stringify({
    webpage_url: item.videoUrl,
    url: item.videoUrl,
    id: item.videoId,
    title: item.title,
    thumbnail: item.thumbnail,
    filesize_approx: "NA",
  });
}
