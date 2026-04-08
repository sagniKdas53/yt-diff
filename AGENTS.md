# Repository Guidelines

## Project Structure & Module Organization
The backend entry point is [`index.ts`](index.ts). Docker and deployment files live at the repo root (`Dockerfile`, `docker-compose.yml`, `Makefile`). The React frontend is isolated under [`frontend/src/`](frontend/src/) with components in [`frontend/src/components/`](frontend/src/components/) and shared hooks in [`frontend/src/hooks/`](frontend/src/hooks/). Test assets and API checks live in [`tests/`](tests/), while design and operational notes are in [`docs/`](docs/).

## Build, Test, and Development Commands
Use the Makefile for container workflows:

```bash
make up        # Start the stack with local env files
make build     # Rebuild images without cache
make check     # Validate the Compose configuration
make logs      # Follow service logs
make down      # Stop the stack
```

For backend development, run `deno task dev` from the repo root. For the frontend, use `cd frontend && npm run dev`, `npm run lint`, or `npm run build`. The API tests are Deno-based: `cd tests && deno task test`.

## Coding Style & Naming Conventions
Follow the existing style in each area rather than introducing new patterns. Frontend linting is enforced through [`frontend/eslint.config.js`](frontend/eslint.config.js), which expects modern ES modules, React hooks rules, and no unused variables. Use descriptive file names that match their role, such as `VideoPlayer.jsx`, `useDependencyLogger.js`, and `api_test.ts`.

## Testing Guidelines
Tests are integration-heavy and run against a containerized stack. Keep test cases in `tests/` and name them by behavior, not implementation. Prefer one focused assertion path per test case, and use the existing `Deno.test(...)` style for new API coverage. When changing auth, playlist, or download flows, run the isolated test stack before opening a PR.

## Commit & Pull Request Guidelines
Recent commits use short, imperative messages with optional prefixes like `feat:`, `fix:`, `refactor:`, and `chore:`. Keep commits scoped to one concern and describe the user-visible effect. PRs should explain what changed, why it changed, and how it was verified. Include screenshots for frontend work and note any new environment variables, secrets, or Docker changes.

## Security & Configuration Tips
Do not commit secrets or local overrides. This repository relies on files such as `.env`, `.localenv`, and secret files like `secret_key.txt` and `db_password.txt`; keep them local and out of version control. When changing Compose settings, verify the result with `make check` before merging.
