# Repository Guidelines

## Project Structure & Module Organization
The backend entry point is [`index.ts`](index.ts). Docker and deployment files live at the repo root (`Dockerfile`, `docker-compose.yml`, `Makefile`). The React frontend is isolated under [`frontend/src/`](frontend/src/) with components in [`frontend/src/components/`](frontend/src/components/) and shared hooks in [`frontend/src/hooks/`](frontend/src/hooks/). Test assets and API checks live in [`tests/`](tests/), while design and operational notes are in [`docs/`](docs/).

## Build, Test, and Development Commands
Use the Makefile for container workflows:

```bash
make local     # Generate .env from base.env + local.env
make pi5       # Generate .env from base.env + pi5.env
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
Do not commit secrets or generated local overrides. This repository relies on `envs/base.env`, deployment env files such as `envs/local.env` and `envs/pi5.env`, the generated `.env`, and secret files under `secrets/` such as `secrets/secret_key.txt` and `secrets/db_password.txt`; keep secrets local and keep the generated `.env` out of version control. When changing Compose settings, verify the result with `make check` before merging.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **yt-diff** (2324 symbols, 3847 relationships, 107 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/yt-diff/context` | Codebase overview, check index freshness |
| `gitnexus://repo/yt-diff/clusters` | All functional areas |
| `gitnexus://repo/yt-diff/processes` | All execution flows |
| `gitnexus://repo/yt-diff/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
