import type Redis from "ioredis";

import { config } from "../config.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { existsSync } from "../utils/fs.ts";
import {
  extname,
  isWithinPath,
  join,
  resolve,
} from "../utils/path.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;

interface FileHandlerDependencies {
  redis: Redis;
  generateCorsHeaders: GenerateCorsHeaders;
  jsonMimeType: string;
  mimeTypes: Record<string, string>;
}

export interface SignedFileRequestBody {
  saveDirectory?: string;
  fileName?: string;
}

export interface RefreshSignedUrlRequestBody {
  fileId?: string;
}

export interface BulkSignedFilesRequestBody {
  files?: SignedFileRequestBody[];
}

export function createFileHandlers({
  redis,
  generateCorsHeaders,
  jsonMimeType,
  mimeTypes,
}: FileHandlerDependencies) {
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
        fileName,
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
      if (existsSync(resolvedPath)) {
        absolutePath = resolvedPath;
      } else {
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ status: "error", message: "File could not be found" }),
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

    const now = Date.now();
    const signedUrlId = crypto.randomUUID();
    const expiry = now + config.cache.maxAge * 1000;

    await redis.set(
      `signed:${signedUrlId}`,
      JSON.stringify({
        filePath: absolutePath,
        mimeType: mimeTypes[extname(absolutePath)] ||
          "application/octet-stream",
        expiry,
      }),
      "EX",
      config.cache.maxAge,
    );

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

    const results: Record<string, string | null> = {};
    const now = Date.now();

    for (const file of requestBody.files) {
      const { saveDirectory, fileName } = file;
      if (!fileName || typeof fileName !== "string") continue;

      const joined = join(
        config.saveLocation,
        saveDirectory || "",
        fileName,
      );
      const resolvedPath = resolve(joined);
      const saveRoot = resolve(config.saveLocation);

      if (!isWithinPath(saveRoot, resolvedPath) || !existsSync(resolvedPath)) {
        results[fileName] = null;
        continue;
      }

      const signedUrlId = crypto.randomUUID();
      const expiry = now + config.cache.maxAge * 1000;

      await redis.set(
        `signed:${signedUrlId}`,
        JSON.stringify({
          filePath: resolvedPath,
          mimeType: "application/octet-stream",
          expiry,
        }),
        "EX",
        config.cache.maxAge,
      );

      results[fileName] = signedUrlId;
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", files: results }));
  }

  return {
    makeSignedUrl,
    makeSignedUrls,
    refreshSignedUrl,
  };
}
