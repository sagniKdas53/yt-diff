import type Redis from "ioredis";

import { config } from "../config.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { exists } from "../utils/fs.ts";
import {
  basename,
  extname,
  isWithinPath,
  join,
  resolve,
} from "../utils/path.ts";

import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";

interface FileHandlerDependencies {
  redis: Redis;
}

export interface SignedFileRequestBody {
  saveDirectory?: string;
  fileName?: string;
}

export interface RefreshSignedUrlRequestBody {
  fileId?: string;
}

export interface BulkRefreshSignedUrlsRequestBody {
  fileIds?: string[];
}

export interface BulkSignedFilesRequestBody {
  files?: SignedFileRequestBody[];
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
        mimeType: mimeTypes.get(extname(absPath)) || "application/octet-stream",
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
    let absolutePath = null;
    if (requestBody && (requestBody.saveDirectory || requestBody.fileName)) {
      const saveDirectory = requestBody.saveDirectory || "";
      const fileName = requestBody.fileName;
      if (!fileName || typeof fileName !== "string") {
        logger.warn("serveFileByPath invalid fileName", {
          saveDirectory,
          fileName,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ status: "error", message: "fileName is required" }),
        );
      }

      const joined = join(
        config.saveLocation,
        saveDirectory || "",
        basename(fileName),
      );
      const resolvedPath = resolve(joined);
      const saveRoot = resolve(config.saveLocation);
      if (!isWithinPath(saveRoot, resolvedPath)) {
        logger.warn("serveFileByPath attempted path traversal", {
          saveDirectory,
          fileName,
          resolved: resolvedPath,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ status: "error", message: "Invalid file path" }),
        );
      }
      logger.debug(`Resolved Path ${resolvedPath}`, {
        joined,
        resolved: resolvedPath,
        saveRoot,
      });
      if (await exists(resolvedPath)) {
        absolutePath = resolvedPath;
      } else {
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            status: "error",
            message: "File could not be found",
          }),
        );
      }
    } else {
      logger.warn("makeSignedUrl missing parameters", {
        requestBody: JSON.stringify(requestBody),
      });
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "error",
          message: "saveDirectory and fileName are required",
        }),
      );
    }

    const { signedUrlId, expiry } = await createSignedUrlForPath(absolutePath);

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", signedUrlId, expiry }));
  }

  async function refreshSignedUrl(
    requestBody: RefreshSignedUrlRequestBody,
    response: HttpResponseLike,
  ) {
    if (
      !requestBody || !requestBody.fileId ||
      typeof requestBody.fileId !== "string"
    ) {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({ status: "error", message: "fileId is required" }),
      );
    }

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
    if (
      !requestBody || !requestBody.fileIds ||
      !Array.isArray(requestBody.fileIds)
    ) {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "error",
          message: "fileIds array is required",
        }),
      );
    }

    const results = new Map<string, RefreshedSignedFileResponseEntry | null>();
    const now = Date.now();

    for (const fileId of requestBody.fileIds) {
      if (!fileId || typeof fileId !== "string") {
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
    if (
      !requestBody || !requestBody.files || !Array.isArray(requestBody.files)
    ) {
      logger.warn("makeSignedUrls missing or invalid parameters", {
        requestBody: JSON.stringify(requestBody),
      });
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({ status: "error", message: "files array is required" }),
      );
    }

    const results = new Map<string, BulkSignedFileResponseEntry | null>();

    for (const file of requestBody.files) {
      const { saveDirectory, fileName } = file;
      if (!fileName || typeof fileName !== "string") continue;

      const joined = join(
        config.saveLocation,
        saveDirectory || "",
        basename(fileName),
      );
      const resolvedPath = resolve(joined);
      const saveRoot = resolve(config.saveLocation);

      if (
        !isWithinPath(saveRoot, resolvedPath) || !(await exists(resolvedPath))
      ) {
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
