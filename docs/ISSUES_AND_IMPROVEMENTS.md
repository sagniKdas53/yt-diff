# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of `index.ts`.

## 1. Authentication & Security

- ~~**Rate Limiting Gaps**: The custom `rateLimit` function is selectively applied
  only to `/login`, `/register`, and `/isregallowed`. Other resource-intensive
  endpoints (like `/download` or `/list`) lack strict rate limiting, potentially
  making the server vulnerable to resource exhaustion (e.g., maliciously
  triggering a massive `yt-dlp` download queue).~~
- ~~**Socket Authority**: `authenticateSocket` validates tokens on initial
  connection but lacks scheduled verification to forcefully disconnect anomalous
  users or users whose tokens expire mid-session. Active socket streams assume
  the initial connection's validity perpetually.~~

## 2. Input Validation (Edge Cases)

- **Lack of Schema Validation**: The payload `data` passed from frontend to
  backend is handled using completely generic or unvalidated definitions
  (`data: any`) in many API endpoint handlers (e.g.,
  `processListingRequest(data as any, res)`). There is no runtime validation
  library (such as `Zod` or `Joi`) ensuring fields exist, are the correct type,
  or are correctly sanitized before database insertion.
- **Path Verification**: In endpoints related to physical file retrieval logic
  and static file serving, manually constructing file path structures from
  parsed database values or partial request structures can be precarious without
  native robust path resolution boundaries. Fortunately, there is some
  implementation of `path.basename()` usage in the current stream handler which
  is a good defensive measure.

## 3. Architecture & Code Structure

- **Monolithic Configuration**: `index.ts` spans thousands of lines,
  simultaneously handling ORM database definitions, raw HTTP routing, WebSocket
  events, scheduled Cron jobs, and complex wrapper interactions for `yt-dlp`.
  - **Suggested Improvement**: Extract the architecture into modular
    directories: `src/routes/`, `src/models/`, `src/services/`, `src/jobs/`, and
    `src/utils/`.
- **Custom HTTP Server Router**: The routing logic relies on a massive sequence
  of `if-else if` blocks querying `req.url` against hardcoded string
  concatenated routes.
  - **Suggested Improvement**: Adopting a lightweight routing framework (like
    `Express`, `Fastify`, or `Koa`) would significantly simplify HTTP method
    parsing, middleware injection (like auth/logging layers), and dynamic stream
    handling.
- **`any` Typing**: Scattered usage of `any` types in highly dynamic areas of
  the codebase bypasses TypeScript's native compiler safety, increasing bug risk
  during refactoring or schema adjustments.

## 4. Unused or Legacy Components

- **Manual Backpressure and Range Requests**: `index.ts` manually implements
  streaming backpressure controls and HTTP `206 Partial Content` (Range Header)
  capabilities for video streaming. Utilizing a stable framework or standard
  static-serve middleware would reduce potential edge cases (e.g., handling
  aborted connections during massive file streaming gracefully).
- **Hardcoded Process Operations**: Raw array pushes like
  `downloadOptions.push('--trim-filenames')` are fine, but can become unruly
  over time if the scope of `yt-dlp` arguments grows dynamically per-video
  rather than globally.
- **Fragile `yt-dlp` Execution Workaround**: The codebase currently uses a Python monkey patch (`YT_DLP_PATCHED_CMD`) injected directly via `python3 -c` to bypass a segmentation fault in `curl_cffi` during `yt-dlp` execution.
  - **Suggested Improvement**: Track the upstream `curl_cffi` and `yt-dlp` repositories for a permanent fix. Once resolved, revert the extraction process to invoke the standard `yt-dlp` executable cleanly rather than patching Python's context at runtime.
- **Large JSONB Payload Storage**: The `raw_metadata` column on `VideoMetadata` currently stores heavily nested JSONB structures. While bulky arrays (formats/thumbnails) are pruned, accumulating this across thousands of videos might bloat PostgreSQL storage unnecessarily if the fields are never queried.
  - **Suggested Improvement**: Periodically review whether `raw_metadata` is actively utilized. If not, consider extracting only specific metadata keys explicitly rather than a catch-all JSON dump, or offload this archival data to file-based cache.
- **Process Exit Handling**: Parsing of process exits checks numeric codes (`0`, `1`) and explicit strings (e.g., `Segmentation fault`) directly from the spawned streams.
  - **Suggested Improvement**: Standardize an error-code mapping constant or object, which simplifies the monolithic process error parsing logic across different download/metadata tasks.
