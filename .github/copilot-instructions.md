This repository (yt-diff) bundles a Deno backend, a React + Vite frontend and Docker build targets that produce a self-contained image with yt-dlp, ffmpeg and optional phantomjs.

Quick orientation
- Backend: `index.ts` plus `src/` — Deno HTTP server + Socket.IO instance using Sequelize (Postgres). Key files: `index.ts`, `src/**/*`.
- Frontend: `frontend/` — Vite + React app. Built during Docker image build; built assets are placed in `dist/` and served by the Deno server. Key files: `frontend/src/components/*`, `frontend/package.json`, `frontend/readme.md`.
- Docker: `Dockerfile`, `Dockerfile.alpine`, `docker-compose.yml` — multi-stage images that download yt-dlp/ffmpeg and build the frontend. The compose file wires a `postgres` service and expects secrets in `secrets/db_password.txt` and `secrets/secret_key.txt`.

What matters to an AI coding agent
- Global config and envs live in `src/config.ts`. Use env names from `docker-compose.yml` (.env/.env.local expected). Important env keys: `SECRET_KEY[_FILE]`, `DB_PASSWORD[_FILE]`, `BASE_URL`/`VITE_BASE_PATH`, `SAVE_PATH`, `PORT`.
- API surface (HTTP): All endpoints are mounted under the base path `config.urlBase` (default `/ytdiff`). Important routes (all expect a JSON body containing a `token` for auth unless noted):
  - POST `.../list` — add/refresh playlist(s)
  - POST `.../download` — enqueue downloads
  - POST `.../watch` — monitor playlist
  - POST `.../getplay` — list playlists for UI
  - POST `.../getsub` — list videos for a playlist
  - POST `.../register`, `.../login` — authentication endpoints (rate-limited)
- Socket.IO:
  - path: `config.urlBase + '/socket.io/'` (example: `/ytdiff/socket.io/`)
  - clients authenticate by sending `handshake.auth.token` (JWT issued by `login`). See `src/middleware/auth.ts` and `src/socket/index.ts` for validation rules — tokens embed `id` and `lastPasswordChangeTime` and are validated against `UserAccount.updatedAt`.
- Static assets: `dist/` files mapped into `staticAssets` by `makeAssets()` and served at `config.urlBase`. Health check available at `.../ping` (returns `pong`).

Project conventions and notable patterns
- Modular backend: server setup starts in `index.ts` and delegates to `src/` for routes, DB models, jobs, middleware, and yt-dlp pipeline logic.
- DB: Sequelize models are defined in `src/db/models.ts`. Use the existing model names (`video_metadata`, `playlist_metadata`, `playlist_video_mapping`, `user_account`) when writing queries.
- Auth: HTTP endpoints expect a JSON body that contains `{ token }`. Socket clients must use `handshake.auth.token`. Tokens expire when `UserAccount.updatedAt` changes — tests or mocks should simulate this by setting `updatedAt` appropriately.
- Frontend build: Run `npm --prefix frontend run build` to produce `dist/` artifacts that the Deno server expects under `dist/`. `frontend/package.json` build script uses `--base=/ytdiff/`.
- Docker build: Docker image build downloads platform-specific binaries for `yt-dlp` and `ffmpeg`. For local dev prefer running backend with `deno task dev` and frontend with `npm --prefix frontend run dev` to avoid the multi-stage Docker build.

Examples (use these to reproduce behavior locally)
- Start backend (dev): SECRET_KEY and DB_PASSWORD can be provided as envs or files. Minimal dev command (example):
  - SECRET_KEY=ytd1ff DB_PASSWORD=ytd1ff deno run --allow-all --watch index.ts
- Start frontend (dev): from repo root: `npm --prefix frontend run dev` (serves Vite on port 5173). The frontend expects backend at `http://localhost:8888/ytdiff` by default when `import.meta.env.PROD` is false.

When editing code
- Keep changes minimal and follow the existing structure in `src/`. If you add new backend modules, make sure the Dockerfiles still copy them into the final image.
- If adding endpoints, follow the existing pattern: parse JSON via `parseRequestJson`, call `authenticateRequest` where required, then call the internal handler that writes JSON responses.

Files to reference when coding
- `index.ts`, `src/**/*` (server, DB, sockets, static assets)
- `deno.json` (backend tasks and imports)
- `frontend/package.json`, `frontend/src/components/*` (UI behavior and socket usage)
- `Dockerfile`, `Dockerfile.alpine`, `docker-compose.yml` (build/run in containers)

If anything here is unclear or you need more examples (e.g., model fields, socket event names), tell me which area to expand and I will iterate.
