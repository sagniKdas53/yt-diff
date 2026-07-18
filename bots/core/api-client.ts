/**
 * yt-diff API client for bots.
 *
 * Wraps the yt-diff REST API with typed methods for the bot workflow:
 * lookup → list (index) → download → get signed URL.
 *
 * Uses the bot API key (`X-Bot-Key` header) for authentication.
 */

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
    downloadStatus: boolean;
    isAvailable: boolean;
    fileName: string | null;
    saveDirectory: string | null;
    fileSizeBytes: number | null;
    fileExists: boolean;
    approximateSize: number | string;
    onlineThumbnail: string | null;
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
  queue?: Array<{
    url: string;
    title: string;
    status: string;
    queuePosition: number;
  }>;
}

interface QueueStatusResponse {
  status: string;
  generation: number;
  queue: Array<{
    url: string;
    title: string;
    status: string;
    queuePosition: number;
  }>;
}

export class YtdiffApiClient {
  constructor(private config: BotConfig) {}

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.config.ytdiffApiBase}${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Key": this.config.ytdiffAuthToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `yt-diff API error: ${response.status} ${response.statusText}${
          errorText ? " — " + errorText : ""
        }`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Check if a URL exists in the yt-diff database and get its metadata.
   * Handles URL canonicalization internally.
   */
  async lookup(rawUrl: string): Promise<VideoLookupResult> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) {
      return {
        found: false,
        indexed: false,
        downloaded: false,
        needsListing: true,
        needsDownload: false,
        fileExists: false,
      };
    }

    try {
      const result = await this.post<LookupApiResponse>("/lookup", {
        url: parsed.canonical,
      });

      if (result.status === "not_found") {
        return {
          found: false,
          indexed: false,
          downloaded: false,
          needsListing: true,
          needsDownload: false,
          fileExists: false,
        };
      }

      if (result.status === "found" && result.video) {
        const v = result.video;
        return {
          found: true,
          indexed: true,
          downloaded: v.fileExists && v.downloadStatus,
          title: v.title,
          fileName: v.fileName ?? undefined,
          fileSizeBytes: v.fileSizeBytes ?? undefined,
          fileExists: v.fileExists,
          needsListing: false,
          needsDownload: !v.fileExists,
        };
      }

      return {
        found: false,
        indexed: false,
        downloaded: false,
        needsListing: true,
        needsDownload: false,
        fileExists: false,
      };
    } catch (error) {
      console.error("Lookup failed:", (error as Error).message);
      return {
        found: false,
        indexed: false,
        downloaded: false,
        needsListing: true,
        needsDownload: false,
        fileExists: false,
      };
    }
  }

  /**
   * Submit a URL for indexing (yt-dlp listing).
   * Uses monitoringType N/A for ephemeral mode (no re-scan),
   * or End for persistent mode (appends to playlist).
   */
  async submitForListing(rawUrl: string): Promise<boolean> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) return false;

    try {
      const result = await this.post<ListApiResponse>("/list", {
        urlList: [parsed.canonical],
        monitoringType: this.config.mode === "ephemeral" ? "N/A" : "End",
      });
      return result.status === "success";
    } catch (error) {
      console.error("Submit for listing failed:", (error as Error).message);
      return false;
    }
  }

  /**
   * Start download for a URL. The video must already be indexed.
   */
  async startDownload(
    rawUrl: string,
  ): Promise<{ queued: boolean; position?: number }> {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !parsed.isValidVideo) return { queued: false };

    try {
      const result = await this.post<DownloadApiResponse>("/download", {
        urlList: [parsed.canonical],
        playListUrl: this.config.mode === "ephemeral" ? "None" : undefined,
      });

      if (result.status === "success" && result.queue?.length) {
        return { queued: true, position: result.queue[0].queuePosition };
      }
      return { queued: false };
    } catch (error) {
      console.error("Start download failed:", (error as Error).message);
      return { queued: false };
    }
  }

  /**
   * Get a signed download URL for a video file.
   * The signed URL allows secure file access without JWT auth.
   */
  async getSignedUrl(
    fileName: string,
    saveDirectory: string,
  ): Promise<SignedUrlResponse> {
    return this.post<SignedUrlResponse>("/getfile", {
      fileName,
      saveDirectory,
    });
  }

  /**
   * Check the current download queue status.
   */
  async getQueueStatus(): Promise<
    Array<{ url: string; title: string; status: string; queuePosition: number }>
  > {
    try {
      const result = await this.post<QueueStatusResponse>("/queuestatus", {});
      return result.queue || [];
    } catch {
      return [];
    }
  }
}
