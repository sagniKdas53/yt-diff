# `index.ts` Section 3 Refactor Checklist

Source: [docs/ISSUES_AND_IMPROVEMENTS.md](../ISSUES_AND_IMPROVEMENTS.md)

## Phase 1: Low-risk extraction

- [x] Capture the refactor plan in-repo as a checklist.
- [x] Extract config loading from `index.ts` into `src/config.ts`.
- [x] Extract logging setup from `index.ts` into `src/logger.ts`.
- [x] Extract Sequelize setup and model definitions into `src/db/` modules.
- [x] Keep `index.ts` as the entrypoint while reducing bootstrap noise.

## Phase 2: Runtime module boundaries

- [x] Extract auth and rate-limiting helpers into `src/middleware/`.
- [x] Extract cron job construction into `src/jobs/`.
- [x] Extract socket authentication and connection lifecycle into `src/socket/`.
- [x] Extract signed file streaming and static asset serving into dedicated route helpers.

## Phase 3: Route structure

- [x] Replace the `if/else if` POST router with a route registry.
- [x] Move each endpoint handler into a dedicated backend module.
- [x] Preserve current request/response behavior while shrinking `index.ts`.
- [ ] Reassess whether adopting Express/Fastify still provides enough value after route extraction.
- [x] Extract playlist/query/delete route handlers into `src/handlers/playlists.ts`.
- [x] Extract remaining listing/download pipeline handlers out of `index.ts` (~900 LOC in processListingRequest and processDownloadRequest).
- [x] Extract shared request/response helpers still owned by `index.ts` when handler moves make that practical.

## Phase 3b: Handler subdivision

- [x] Extract shared types and constants from `pipeline.ts` into `src/handlers/pipeline/types.ts`.
- [x] Extract generic `Semaphore` class from inline download/listing semaphores into `src/handlers/pipeline/semaphore.ts`.
- [x] Extract process lifecycle helpers (`cleanupStaleProcesses`, `updateProcessActivity`, URL utils) into `src/handlers/pipeline/process-manager.ts`.
- [x] Extract download flow (`processDownloadRequest`, `executeDownload`, `discoverFiles`, `computeSaveDirectory`) into `src/handlers/pipeline/download.ts`.
- [x] Extract listing flow (`processListingRequest`, `executeListing`, streaming, DB upsert) into `src/handlers/pipeline/listing.ts`.
- [x] Convert `pipeline.ts` into `pipeline/index.ts` barrel re-export.
- [x] Extract shared types from `playlists.ts` into `src/handlers/playlists/types.ts`.
- [x] Extract mutation handlers (`deletePlaylist`, `deleteVideos`, `reindexAll`, `updateMonitoring`) into `src/handlers/playlists/mutations.ts`.
- [x] Extract query handlers (`getPlaylistsForDisplay`, `getSubListVideos`) into `src/handlers/playlists/queries.ts`.
- [x] Convert `playlists.ts` into `playlists/index.ts` barrel re-export.
- [x] Update all imports in `src/routes/` and `index.ts` to point at new module paths.
- [x] Verify: `deno check index.ts` passes.
- [x] Verify: `deno task dev` starts and serves on :8888.

## Phase 4: Typing cleanup

- [x] Add typed request DTOs for each API boundary.
- [x] Replace high-value `any` usages in auth, routing, signed URL, listing, and download flows.
- [ ] Type Redis cache payloads and socket auth payloads.
- [ ] Leave deep yt-dlp/raw metadata typing for a later targeted pass.

## Phase 5: Deno-native runtime cleanup

- [x] Replace remaining `node:` imports with Deno-native APIs or vendored Deno std modules where practical.
- [x] Replace low-risk `Buffer`-only usages with `Uint8Array`/`TextEncoder`.
- [x] Replace config file reads from `node:fs` with Deno file APIs.
- [x] Replace `node:fs`/`node:path` usage with local Deno-friendly helper modules.
- [x] Reduce or eliminate `node:http`-specific request/response types behind local transport interfaces.
- [x] Replace `node:child_process`/`node:readline` process handling with `Deno.Command` and stream readers.
- [x] Replace signed-file Node stream piping with Deno file streaming.
- [x] Replace the remaining Node-based HTTP/HTTPS server bootstrap and stream/process runtime integrations where still justified.

## Acceptance checks

- [x] `index.ts` is reduced to thin bootstrap/orchestration responsibilities.
- [x] Existing HTTP and socket behavior is preserved.
- [x] Cron jobs still start normally (cleanup, update, prune all running).
- [x] `deno check index.ts` passes.
- [x] `deno task dev` still starts (active and listening on :8888).
- [ ] Existing test flows still pass (not verified - requires test stack).
