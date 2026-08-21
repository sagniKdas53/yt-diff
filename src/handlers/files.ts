import type { Redis } from "ioredis";

import { config } from "../config.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { isFile } from "../utils/fs.ts";
import { basename, extname, resolveWithin } from "../utils/path.ts";

import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";

interface FileHandlerDependencies {
  redis: Redis;
}

export interface SignedFileRequestBody {
  saveDirectory?: string;
  fileName: string;
}

/**
 * One entry of a bulk request.
 *
 * `fileName` is optional here and required on the single-file endpoint on
 * purpose: the caller batches one entry per row on screen, including videos it
 * has not downloaded yet and so cannot name. Those are skipped, not fatal to
 * the batch — the same contract as the null entries in the response.
 */
export interface BulkSignedFileRequest {
  saveDirectory?: string;
  fileName?: string;
}

export interface RefreshSignedUrlRequestBody {
  fileId: string;
}

export interface BulkRefreshSignedUrlsRequestBody {
  fileIds: string[];
}

export interface BulkSignedFilesRequestBody {
  files: BulkSignedFileRequest[];
}

export interface BulkSignedFileResponseEntry {
  signedUrlId: string;
  expiry: number;
}

export interface RefreshedSignedFileResponseEntry {
  expiry: number;
}

export function createFileHandlers({
  redis,
}: FileHandlerDependencies) {
  const jsonMimeType = MIME_TYPES[".json"];
  const mimeTypes = new Map<string, string>(Object.entries(MIME_TYPES));

  /**
   * Mints a signed-URL entry in Redis for an already-validated absolute path.
   *
   * Callers are responsible for path-traversal and existence checks; this only
   * writes the entry. Every entry gets the same lifetime — web UI and chat bot
   * alike — so the three renewal paths (`?fileId=` access, refreshSignedUrl,
   * refreshSignedUrls) cannot disagree about how long a link should live.
   *
   * @param absPath - Absolute, already-validated path to the file
   */
  async function createSignedUrlForPath(
    absPath: string,
  ): Promise<BulkSignedFileResponseEntry> {
    const signedUrlId = crypto.randomUUID();
    const expiry = Date.now() + config.cache.maxAge * 1000;

    await redis.set(
      `signed:${signedUrlId}`,
      JSON.stringify({
        filePath: absPath,
        // Lowercased: extname preserves the case on disk, and a file named
        // "Clip.MP4" is still video/mp4.
        mimeType: mimeTypes.get(extname(absPath).toLowerCase()) ||
          "application/octet-stream",
        expiry,
      }),
      "EX",
      config.cache.maxAge,
    );

    return { signedUrlId, expiry };
  }

  async function makeSignedUrl(
    requestBody: SignedFileRequestBody,
    response: HttpResponseLike,
  ) {
    const saveDirectory = requestBody.saveDirectory || "";
    const fileName = requestBody.fileName;

    const resolvedPath = resolveWithin(
      config.saveLocation,
      saveDirectory,
      basename(fileName),
    );
    if (resolvedPath === null) {
      logger.warn("serveFileByPath attempted path traversal", {
        saveDirectory,
        fileName,
      });
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({ status: "error", message: "Invalid file path" }),
      );
    }
    logger.debug(`Resolved Path ${resolvedPath}`, {
      saveDirectory,
      fileName,
    });
    if (!(await isFile(resolvedPath))) {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "error",
          message: "File could not be found",
        }),
      );
    }

    const { signedUrlId, expiry } = await createSignedUrlForPath(resolvedPath);

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", signedUrlId, expiry }));
  }

  async function refreshSignedUrl(
    requestBody: RefreshSignedUrlRequestBody,
    response: HttpResponseLike,
  ) {
    const cachedEntry = await redis.get(`signed:${requestBody.fileId}`);
    if (cachedEntry) {
      await redis.expire(`signed:${requestBody.fileId}`, config.cache.maxAge);
      const now = Date.now();
      const expiry = now + config.cache.maxAge * 1000;

      const parsedEntry = JSON.parse(cachedEntry);
      parsedEntry.expiry = expiry;
      await redis.set(
        `signed:${requestBody.fileId}`,
        JSON.stringify(parsedEntry),
        "EX",
        config.cache.maxAge,
      );

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({ status: "success", expiry }));
    }

    response.writeHead(404, generateCorsHeaders(jsonMimeType));
    return response.end(
      JSON.stringify({
        status: "error",
        message: "fileId not found or expired",
      }),
    );
  }

  async function refreshSignedUrls(
    requestBody: BulkRefreshSignedUrlsRequestBody,
    response: HttpResponseLike,
  ) {
    const results = new Map<string, RefreshedSignedFileResponseEntry | null>();
    const now = Date.now();

    for (const fileId of requestBody.fileIds) {
      if (fileId.length === 0) {
        continue;
      }

      const cachedEntry = await redis.get(`signed:${fileId}`);
      if (!cachedEntry) {
        results.set(fileId, null);
        continue;
      }

      const expiry = now + config.cache.maxAge * 1000;
      const parsedEntry = JSON.parse(cachedEntry);
      parsedEntry.expiry = expiry;

      await redis.set(
        `signed:${fileId}`,
        JSON.stringify(parsedEntry),
        "EX",
        config.cache.maxAge,
      );

      results.set(fileId, { expiry });
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    return response.end(
      JSON.stringify({ status: "success", files: Object.fromEntries(results) }),
    );
  }

  async function makeSignedUrls(
    requestBody: BulkSignedFilesRequestBody,
    response: HttpResponseLike,
  ) {
    const results = new Map<string, BulkSignedFileResponseEntry | null>();

    for (const file of requestBody.files) {
      const { saveDirectory, fileName } = file;
      if (!fileName) continue;

      const resolvedPath = resolveWithin(
        config.saveLocation,
        saveDirectory || "",
        basename(fileName),
      );

      if (resolvedPath === null || !(await isFile(resolvedPath))) {
        results.set(fileName, null);
        continue;
      }

      // Resolves the real MIME type instead of the blanket octet-stream this
      // used to write, which forced a download even with ?inline=true because
      // serveNativeFile sets Content-Type from the stored value.
      results.set(fileName, await createSignedUrlForPath(resolvedPath));
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(
      JSON.stringify({ status: "success", files: Object.fromEntries(results) }),
    );
  }

  return {
    createSignedUrlForPath,
    makeSignedUrl,
    makeSignedUrls,
    refreshSignedUrl,
    refreshSignedUrls,
  };
}
