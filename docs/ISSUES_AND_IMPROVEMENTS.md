# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of `index.ts`.

## 1. Authentication & Security

- **Non-Standard Token Passing**: `authenticateRequest` expects the JWT token to
  be embedded directly inside the `POST` request JSON payload (e.g.,
  `data.token`). This deviates from industry-standard practices of using the
  `Authorization: Bearer <token>` HTTP header, introducing minor caching and
  structured logging difficulties.
- **Rate Limiting Gaps**: The custom `rateLimit` function is selectively applied
  only to `/login`, `/register`, and `/isregallowed`. Other resource-intensive
  endpoints (like `/download` or `/list`) lack strict rate limiting, potentially
  making the server vulnerable to resource exhaustion (e.g., maliciously
  triggering a massive `yt-dlp` download queue).
- **Socket Authority**: `authenticateSocket` validates tokens on initial
  connection but lacks scheduled verification to forcefully disconnect anomalous
  users or users whose tokens expire mid-session. Active socket streams assume
  the initial connection's validity perpetually.

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
