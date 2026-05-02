import { logger } from "../../logger.ts";
import { stat } from "../../utils/fs.ts";
import { basename } from "../../utils/path.ts";
import type { SignedFileMetadata } from "./getSignedFileMetadata.ts";

/**
 * Serves a file using Deno's native Response and ReadableStream.
 * Supports HTTP Range requests for efficient seeking and reduced memory usage.
 */
export async function tryServeNativeFile(
  request: Request,
  metadata: SignedFileMetadata,
  generateCorsHeaders: (contentType: string) => Record<string, string | number>,
): Promise<Response | null> {
  const { filePath, mimeType, inline } = metadata;

  try {
    const fileStats = await stat(filePath);
    const totalSize = fileStats.size;

    const originalName = basename(filePath);
    // Strip header-breaking characters from the attachment name first.
    const safeName = originalName.replace(/[\r\n"]/g, "");
    // Provide an ASCII fallback for older clients while keeping RFC 5987 UTF-8.
    const fallbackName = safeName.replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(safeName);

    const cors = generateCorsHeaders(mimeType);
    const headers = new Headers();
    Object.entries(cors).forEach(([k, v]) => headers.set(k, String(v)));

    const dispositionType = inline ? "inline" : "attachment";
    headers.set(
      "Content-Disposition",
      `${dispositionType}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    );
    headers.set("Accept-Ranges", "bytes");

    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

        if (
          Number.isNaN(start) || Number.isNaN(end) || start > end ||
          start < 0 || end >= totalSize
        ) {
          headers.set("Content-Range", `bytes */${totalSize}`);
          return new Response(null, {
            status: 416,
            headers,
          });
        }

        const chunkSize = end - start + 1;
        const file = await Deno.open(filePath, { read: true });

        if (start > 0) {
          await file.seek(start, Deno.SeekMode.Start);
        }

        headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        headers.set("Content-Length", String(chunkSize));

        // Limit the readable stream to the exact byte count requested. Some
        // clients stop reading early, but explicitly truncating the stream keeps
        // partial-content responses well-behaved across implementations.
        let bytesSent = 0;
        const limitedStream = file.readable.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (bytesSent >= chunkSize) {
                controller.terminate();
                return;
              }
              const remaining = chunkSize - bytesSent;
              if (chunk.length <= remaining) {
                controller.enqueue(chunk);
                bytesSent += chunk.length;
              } else {
                controller.enqueue(chunk.subarray(0, remaining));
                bytesSent += remaining;
                controller.terminate();
              }
            },
          }),
        );

        return new Response(limitedStream, {
          status: 206,
          headers,
        });
      }
    }

    // No range request
    const file = await Deno.open(filePath, { read: true });
    headers.set("Content-Length", String(totalSize));

    return new Response(file.readable, {
      status: 200,
      headers,
    });
  } catch (error) {
    logger.error("Error serving native file", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });

    const errorHeaders = new Headers();
    const errorCors = generateCorsHeaders("text/plain");
    Object.entries(errorCors).forEach(([k, v]) =>
      errorHeaders.set(k, String(v))
    );

    return new Response("Internal Server Error", {
      status: 500,
      headers: errorHeaders,
    });
  }
}
