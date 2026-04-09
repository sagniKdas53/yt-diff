import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type Redis from "ioredis";

import { logger } from "../../logger.ts";
import { stat } from "../../utils/fs.ts";
import { basename, extname } from "../../utils/path.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;

interface SignedFileDependencies {
  redis: Redis;
  cacheMaxAge: number;
  mimeTypes: Record<string, string>;
  generateCorsHeaders: GenerateCorsHeaders;
  pipelineAsync: (
    source: NodeJS.ReadableStream,
    destination: NodeJS.WritableStream,
  ) => Promise<void>;
  htmlMimeType: string;
}

export async function tryServeSignedFile(
  req: IncomingMessage,
  res: ServerResponse,
  {
    redis,
    cacheMaxAge,
    mimeTypes,
    generateCorsHeaders,
    pipelineAsync,
    htmlMimeType,
  }: SignedFileDependencies,
): Promise<boolean> {
  if (!req.url) {
    return false;
  }

  const urlParams = new URLSearchParams(req.url.split("?")[1]);
  if (!urlParams.has("fileId")) {
    return false;
  }

  const fileId = urlParams.get("fileId");
  const cachedEntry = await redis.get(`signed:${fileId}`);
  if (!cachedEntry) {
    return false;
  }

  await redis.expire(`signed:${fileId}`, cacheMaxAge);
  const signedEntry = JSON.parse(cachedEntry) as {
    filePath: string;
    mimeType?: string;
  };

  logger.trace("Serving file from signed URL cache", {
    url: req.url,
  });
  logger.trace("Serving signed file", {
    fileId,
    filePath: signedEntry.filePath,
  });

  try {
    const stats = await stat(signedEntry.filePath);
    const total = stats.size;

    const originalName = basename(signedEntry.filePath || "");
    const safeName = originalName.replace(/[\r\n"]/g, "");
    const fallbackName = safeName.replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(safeName);

    let contentType = signedEntry.mimeType;
    if (!contentType || contentType === "application/octet-stream") {
      contentType = mimeTypes[extname(safeName)] ||
        "application/octet-stream";
    }

    const cors = generateCorsHeaders(contentType);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader("Content-Type", contentType);

    const dispositionType = urlParams.get("inline") === "true"
      ? "inline"
      : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${dispositionType}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    );
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;
    let start = 0;
    let end = total - 1;
    let statusCode = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        if (match[1]) start = parseInt(match[1], 10);
        if (match[2]) end = parseInt(match[2], 10);
        if (
          Number.isNaN(start) || Number.isNaN(end) || start > end ||
          start < 0 || end > total - 1
        ) {
          res.writeHead(416, {
            "Content-Range": `bytes */${total}`,
          });
          res.end();
          return true;
        }
        statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      }
    }

    const chunkSize = end - start + 1;
    res.setHeader("Content-Length", String(chunkSize));
    res.writeHead(statusCode);

    const readStream = fs.createReadStream(signedEntry.filePath, {
      start,
      end,
      highWaterMark: 1024 * 1024,
    });

    const onClose = () => {
      try {
        readStream.destroy();
      } catch (err: unknown) {
        logger.error("Error destroying read stream on client disconnect", {
          error: (err as Error)?.message || String(err),
          fileId,
        });
      }
    };
    req.on("close", onClose);
    req.on("aborted", onClose);

    try {
      await pipelineAsync(readStream, res);
      logger.trace("Finished streaming signed file", { fileId });
    } catch (err) {
      logger.error("Error during streaming signed file", {
        error: (err as Error)?.message || String(err),
        fileId,
      });
      if (!res.headersSent) {
        res.writeHead(500, generateCorsHeaders(htmlMimeType));
      }
      try {
        res.end("Error reading file");
      } catch (error: unknown) {
        logger.error("Error ending response after streaming failure", {
          error: (error as Error)?.message || String(error),
          fileId,
        });
      }
    } finally {
      req.removeListener("close", onClose);
      req.removeListener("aborted", onClose);
    }
  } catch (err) {
    logger.error("Error getting file stats", {
      error: (err as Error).message,
      fileId,
    });
    if (!res.headersSent) {
      res.writeHead(500, generateCorsHeaders(htmlMimeType));
    }
    res.end("Error reading file");
  }

  return true;
}
