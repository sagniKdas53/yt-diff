import { config } from "../config.ts";
import { VideoMetadata } from "../db/models.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { normalizeUrl } from "../handlers/pipeline/process-manager.ts";
import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
import { exists, stat } from "../utils/fs.ts";
import { join } from "../utils/path.ts";

export interface LookupRequestBody {
  url: string;
}

export interface LookupResponseVideo {
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
}

export async function processLookupRequest(
  requestBody: LookupRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  const jsonMimeType = MIME_TYPES[".json"];

  try {
    if (!requestBody.url || typeof requestBody.url !== "string") {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "error",
          message: "url is required",
        }),
      );
    }

    const normalizedUrl = normalizeUrl(requestBody.url);
    logger.debug("Lookup request", {
      original: requestBody.url,
      normalized: normalizedUrl,
    });

    const video = await VideoMetadata.findOne({
      where: { videoUrl: normalizedUrl },
    });

    if (!video) {
      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "not_found",
          message:
            "URL not yet indexed. Submit it via /list first.",
        }),
      );
    }

    // Determine file existence and size on disk
    let fileExists = false;
    let fileSizeBytes: number | null = null;
    const fileName = video.getDataValue("fileName") as string | null;
    const saveDirectory = video.getDataValue("saveDirectory") as
      | string
      | null;

    if (fileName && saveDirectory !== null && saveDirectory !== undefined) {
      const filePath = join(
        config.saveLocation,
        saveDirectory ?? "",
        fileName,
      );
      try {
        if (await exists(filePath)) {
          const fileStats = await stat(filePath);
          fileSizeBytes = fileStats.size;
          fileExists = true;
        }
      } catch {
        // File doesn't exist on disk — leave as false/null
      }
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(
      JSON.stringify({
        status: "found",
        video: {
          videoId: video.getDataValue("videoId") as string,
          title: video.getDataValue("title") as string,
          videoUrl: video.getDataValue("videoUrl") as string,
          downloadStatus: video.getDataValue("downloadStatus") as boolean,
          isAvailable: video.getDataValue("isAvailable") as boolean,
          fileName,
          saveDirectory,
          fileSizeBytes,
          fileExists,
          approximateSize: video.getDataValue("approximateSize") as
            | number
            | string,
          onlineThumbnail: video.getDataValue("onlineThumbnail") as
            | string
            | null,
        },
      }),
    );
  } catch (error) {
    logger.error("Lookup error", { error: (error as Error).message });
    response.writeHead(500, generateCorsHeaders(jsonMimeType));
    response.end(
      JSON.stringify({
        status: "error",
        message: "Internal server error",
      }),
    );
  }
}