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
- [x] Reassess whether adopting Express/Fastify still provides enough value after route extraction.

## Phase 4: Typing cleanup

- [ ] Add typed request DTOs for each API boundary.
- [ ] Replace high-value `any` usages in auth, routing, signed URL, listing, and download flows.
- [ ] Type Redis cache payloads and socket auth payloads.
- [ ] Leave deep yt-dlp/raw metadata typing for a later targeted pass.

## Acceptance checks

- [ ] `index.ts` is reduced to thin bootstrap/orchestration responsibilities.
- [ ] Existing HTTP and socket behavior is preserved.
- [ ] Cron jobs still start normally.
- [x] `deno check index.ts` passes.
- [ ] `deno task dev` still starts.
- [ ] Existing test flows still pass.
