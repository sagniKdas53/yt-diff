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

// --- Token Management ---

let tokenCache: TokenCache | null = null;

/**
 * Get a valid access token, refreshing if expired or missing.
 * Uses the OAuth2 refresh token flow.
 */
async function getAccessToken(): Promise<string> {
  const ytConfig = config.youtubeApi;
  if (!ytConfig) {
    throw new Error("YouTube API credentials not configured");
  }

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  logger.info("Refreshing YouTube API access token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ytConfig.clientId,
      client_secret: ytConfig.clientSecret,
      refresh_token: ytConfig.refreshToken,
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

// --- Playlist ID Extraction ---

/**
 * Extract the playlist ID from a YouTube URL.
 * Handles:
 *   - https://www.youtube.com/playlist?list=PLxxxx
 *   - https://www.youtube.com/watch?v=xxx&list=PLxxxx
 *   - Watch Later (WL) and Liked Videos (LL) playlist IDs
 */
export function extractPlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const listParam = parsed.searchParams.get("list");
    if (listParam) {
      return listParam;
    }

    // Handle /playlist/XXXX format (rare but possible)
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
 * Check if a URL is a YouTube URL that could use the YouTube API.
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

// --- API Calls ---

/**
 * Get the total number of items in a playlist.
 * This is a lightweight call (1 API unit) that returns just the count.
 */
export async function getPlaylistItemCount(
  playlistId: string,
): Promise<number> {
  const accessToken = await getAccessToken();

  const params = new URLSearchParams({
    part: "snippet",
    playlistId: playlistId,
    maxResults: "1",
  });

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `YouTube API playlistItems count failed: ${response.status} ${errorBody}`,
    );
  }

  const data: PlaylistItemsResponse = await response.json();

  logger.info("YouTube API playlist item count", {
    playlistId,
    totalResults: data.pageInfo.totalResults,
  });

  return data.pageInfo.totalResults;
}

/**
 * Fetch all items from a playlist using pagination.
 * Returns items in playlist order (position 0, 1, 2, ...).
 *
 * Each page fetches 50 items (API maximum). A 5,000-video playlist
 * requires ~100 API calls ≈ 100 quota units.
 */
export async function fetchAllPlaylistItems(
  playlistId: string,
): Promise<YouTubeApiItem[]> {
  const items: YouTubeApiItem[] = [];
  let nextPageToken: string | undefined;
  let pageCount = 0;

  logger.info("Starting YouTube API playlist fetch", { playlistId });

  do {
    const accessToken = await getAccessToken();

    const params = new URLSearchParams({
      part: "snippet,status",
      playlistId: playlistId,
      maxResults: "50",
    });

    if (nextPageToken) {
      params.set("pageToken", nextPageToken);
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `YouTube API playlistItems failed: ${response.status} ${errorBody}`,
      );
    }

    const data: PlaylistItemsResponse = await response.json();
    pageCount++;

    for (const item of data.items) {
      const videoId = item.snippet.resourceId.videoId;
      const thumbnails = item.snippet.thumbnails;
      // Prefer highest quality thumbnail available
      const thumbnail = thumbnails?.maxres?.url ||
        thumbnails?.high?.url ||
        thumbnails?.medium?.url ||
        thumbnails?.default?.url ||
        null;

      const isAvailable = !item.status ||
        item.status.privacyStatus !== "private";

      items.push({
        videoId,
        title: isAvailable ? item.snippet.title : "[Private video]",
        thumbnail,
        position: item.snippet.position,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }

    nextPageToken = data.nextPageToken;

    if (pageCount % 20 === 0) {
      logger.info("YouTube API fetch progress", {
        playlistId,
        pagesCompleted: pageCount,
        itemsFetched: items.length,
        totalExpected: data.pageInfo.totalResults,
      });
    }
  } while (nextPageToken);

  logger.info("YouTube API playlist fetch complete", {
    playlistId,
    totalItems: items.length,
    totalPages: pageCount,
  });

  return items;
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

/**
 * Check if a YouTube playlist should use the API path.
 * Returns the playlist ID if it should, null otherwise.
 */
export async function shouldUseYouTubeApi(
  url: string,
): Promise<{ playlistId: string; itemCount: number } | null> {
  const ytConfig = config.youtubeApi;
  if (!ytConfig) {
    logger.debug("YouTube API not configured, skipping API path");
    return null;
  }

  if (!isYouTubeUrl(url)) {
    return null;
  }

  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    logger.debug("Could not extract playlist ID from URL", { url });
    return null;
  }

  try {
    const itemCount = await getPlaylistItemCount(playlistId);
    if (itemCount > ytConfig.threshold) {
      logger.info(
        `Playlist ${playlistId} has ${itemCount} items (threshold: ${ytConfig.threshold}), using YouTube API`,
      );
      return { playlistId, itemCount };
    }

    logger.info(
      `Playlist ${playlistId} has ${itemCount} items (threshold: ${ytConfig.threshold}), using yt-dlp`,
    );
    return null;
  } catch (error) {
    logger.error("Failed to check playlist size via YouTube API, falling back to yt-dlp", {
      url,
      playlistId,
      error: (error as Error).message,
    });
    return null;
  }
}
