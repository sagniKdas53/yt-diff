import { config } from "../config.ts";
import { logger } from "../logger.ts";
import type { HttpRequestLike } from "../transport/http.ts";

export const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".gz": "application/gzip",
  ".br": "application/brotli",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

export const CORS_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  // \`http://localhost:\${config.port}\`,
  // \`\${config.protocol}://\${config.host}:\${config.port}\`,
  // "*"
];

export const CORS_ALLOWED_HEADERS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "OPTIONS",
];

/**
 * Extracts and parses JSON data from a request stream
 *
 * @param {HttpRequestLike} request - The HTTP request object
 * @returns {Promise<Object>} Parsed JSON data from request body
 * @throws {Object} Error with status code and message if request is too large or JSON is invalid
 */
export function parseRequestJson(request: HttpRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let requestBody = "";
    const maxRequestSize = 1e6; // 1MB limit
    const textDecoder = new TextDecoder();

    request.on("data", (chunk: Uint8Array) => {
      requestBody += textDecoder.decode(chunk, { stream: true });

      // Check request size
      if (requestBody.length > maxRequestSize) {
        logger.warn("Request exceeded size limit", {
          ip: request.socket.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method,
        });

        request.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });

    request.on("end", () => {
      requestBody += textDecoder.decode();

      if (requestBody.length === 0) {
        logger.warn("Empty request body", {
          ip: request.socket.remoteAddress,
          url: request.url,
          method: request.method,
        });

        reject({ status: 400, message: "Empty Request Body" });
        return;
      }

      try {
        const parsedData = JSON.parse(requestBody);
        resolve(parsedData);
      } catch (error) {
        logger.error("Failed to parse JSON", {
          ip: request.socket.remoteAddress,
          url: request.url,
          size: requestBody.length,
          method: request.method,
          error: (error as Error).message,
        });

        reject({ status: 400, message: "Invalid JSON" });
      }
    });
    request.on("error", (err: Error) => {
      reject({
        status: 500,
        message: "Request stream error",
        error: err.message,
      });
    });
  });
}

/**
 * Generates CORS headers with content type
 *
 * @param {string} contentType - MIME type for Content-Type header
 * @param {Object} [options] - Additional options
 * @param {string[]} [options.allowedOrigins] - Allowed origins, defaults to CORS_ALLOWED_ORIGINS
 * @param {string[]} [options.allowedMethods] - Allowed HTTP methods
 * @param {number} [options.maxAge] - Cache max age in seconds
 * @returns {Object} Object containing CORS headers
 */
export function generateCorsHeaders(
  contentType: string,
  {
    allowedOrigins = CORS_ALLOWED_ORIGINS,
    allowedMethods = CORS_ALLOWED_HEADERS,
    maxAge = config.defaultCORSMaxAge,
  } = {},
) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.join(", "),
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": maxAge,
    "Content-Type": contentType,
  };
}
