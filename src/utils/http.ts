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
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  // The rest of what yt-dlp actually writes. Without these an audio-only
  // download or a thumbnail is served as application/octet-stream, which the
  // player cannot use and which forces a download instead of inline playback.
  ".mov": "video/quicktime",
  ".flv": "video/x-flv",
  ".m4v": "video/x-m4v",
  ".3gp": "video/3gpp",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ass": "text/plain; charset=utf-8",
  ".lrc": "text/plain; charset=utf-8",
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
 * Headers every response carries, whatever the path that produced it.
 *
 * `nosniff` is the one that matters most here: the signed-file path serves a
 * Content-Type derived from the file extension, so without it a browser is
 * free to disagree with us about what a downloaded file is.
 *
 * `X-Frame-Options` duplicates `frame-ancestors` in the CSP below. Both are
 * kept because they fail in opposite directions — `frame-ancestors` is
 * ignored by browsers too old to know it, and `X-Frame-Options` is ignored by
 * some newer ones when a CSP is present.
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * The lockdown policy for anything served out of the download tree.
 *
 * `sandbox` is the operative directive. yt-dlp writes files whose names and
 * types come from a remote site, `MIME_TYPES` maps `.svg`, `.html` and `.xml`
 * to types a browser will execute, and `serveNativeFile` will serve any of
 * them with `Content-Disposition: inline` on request. `sandbox` drops the
 * response into an opaque origin, so even a planted document with script in it
 * cannot read this origin's `localStorage` or call the API as the user.
 *
 * CSP is only enforced on documents, so this does not affect a file loaded as
 * a subresource — `<video src>` and `<img src>` playback is untouched. It
 * applies exactly when the file is navigated to, which is the case the finding
 * is about.
 */
export const SIGNED_FILE_CSP = "default-src 'none'; sandbox";

/**
 * Content-Security-Policy for the app's own documents and API responses.
 *
 * Built once at module load from `config.publicOrigin`, which is the origin a
 * browser actually connects to (see the note above it in `config.ts` — it is
 * computed before `index.ts` rewrites `config.protocol` to match the listener,
 * so it stays correct behind a TLS-terminating proxy).
 *
 * Two directives are looser than the rest, both because the app genuinely
 * needs them:
 *
 * - `style-src` allows `'unsafe-inline'` because MUI's styling engine injects
 *   inline `<style>` blocks at runtime. There is no nonce path through emotion
 *   here, and inline *styles* are not the vector the token is exposed to.
 * - `img-src` allows `https:` because thumbnails come straight from whatever
 *   site the video came from (`meta.onlineThumbnail`), which is not an
 *   enumerable set of origins.
 *
 * Everything that could exfiltrate a bearer token out of `localStorage` —
 * `script-src`, `connect-src`, `form-action` — stays pinned to this origin.
 * The socket origins are spelled out rather than left to `'self'`, which older
 * browsers do not match against `ws:`/`wss:`.
 */
function buildAppCsp(): string {
  // A deployment with HOSTNAME unset or wrong produces an origin that does not
  // match what the browser sees. Rather than emit a malformed source and have
  // the browser drop the whole directive, drop just this entry — `'self'` still
  // covers same-origin sockets on every browser that matches it against ws:.
  const socketOrigins: string[] = [];
  try {
    const origin = new URL(config.publicOrigin);
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    socketOrigins.push(origin.origin);
  } catch {
    // Leave it out; nothing here can log, since logger imports config.
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...socketOrigins].join(" "),
    "worker-src 'self' blob:",
  ].join("; ");
}

export const APP_CSP = buildAppCsp();

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
/**
 * Builds the CORS + Content-Type headers for a response.
 *
 * `Access-Control-Allow-Origin` accepts **exactly one** origin or `*`; a
 * comma-joined list is rejected by every browser. This used to join the whole
 * allowlist, which happened to work only because `CORS_ALLOWED_ORIGINS` has a
 * single entry — adding a second would have silently broken CORS everywhere.
 *
 * Passing `requestOrigin` echoes it back when it is allowed, which is what makes
 * a multi-origin allowlist work. Call sites that omit it keep the previous
 * single-origin behaviour, so none of them had to change.
 *
 * `Vary: Origin` is always set: the response now depends on the request's
 * Origin header, and without it a shared cache could serve one origin's
 * response to another.
 *
 * Every response also carries `SECURITY_HEADERS` and a CSP. This function is
 * the single chokepoint for all three response paths — the JSON API, the
 * static-asset server and the native signed-file server all build their
 * headers here — which is why the headers are added at this level rather than
 * at each of the 71 `writeHead` call sites.
 *
 * @param contentType - Value for the Content-Type header
 * @param requestOrigin - The request's Origin header, when available
 * @param csp - Overrides the app policy; the signed-file path passes
 *   `SIGNED_FILE_CSP` because it serves content this app did not author.
 */
export function generateCorsHeaders(
  contentType: string,
  {
    allowedOrigins = CORS_ALLOWED_ORIGINS,
    allowedMethods = CORS_ALLOWED_HEADERS,
    maxAge = config.defaultCORSMaxAge,
    requestOrigin,
    csp = APP_CSP,
  }: {
    allowedOrigins?: string[];
    allowedMethods?: string[];
    maxAge?: number;
    requestOrigin?: string | null;
    csp?: string;
  } = {},
) {
  // A wildcard allowlist stays a wildcard; otherwise echo the caller's origin
  // when it is permitted, and fall back to the first configured origin so the
  // header is always a single valid value.
  const allowOrigin = allowedOrigins.includes("*")
    ? "*"
    : requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0] ?? "";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": maxAge,
    "Vary": "Origin",
    ...SECURITY_HEADERS,
    "Content-Security-Policy": csp,
    "Content-Type": contentType,
  };
}
