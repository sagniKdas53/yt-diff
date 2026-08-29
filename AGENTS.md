# Repository Guidelines

## Project Structure & Module Organization
The backend entry point is [`index.ts`](index.ts). Docker and deployment files live at the repo root (`Dockerfile`, `docker-compose.yml`, `Makefile`). The React frontend is isolated under [`frontend/src/`](frontend/src/) with components in [`frontend/src/components/`](frontend/src/components/) and shared hooks in [`frontend/src/hooks/`](frontend/src/hooks/). Integration tests live in [`validation/`](validation/) and unit tests live in [`tests/`](tests/), while design and operational notes are in [`docs/`](docs/).

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

For backend development, run `deno task dev` from the repo root. For the frontend, use `cd frontend && npm run dev`, `npm run lint`, or `npm run build`. The API integration tests are Deno-based: `cd validation && deno task test`. Unit tests are run from the root: `deno task test:unit`.

## Coding Style & Naming Conventions
Follow the existing style in each area rather than introducing new patterns. Frontend linting is enforced through [`frontend/eslint.config.js`](frontend/eslint.config.js), which expects modern ES modules, React hooks rules, and no unused variables. Use descriptive file names that match their role, such as `VideoPlayer.jsx`, `useDependencyLogger.js`, and `api_test.ts`.

## Testing Guidelines
Integration tests are run against a containerized stack. Keep integration test cases in `validation/` and unit tests in `tests/` named by behavior, not implementation. Prefer one focused assertion path per test case, and use the existing `Deno.test(...)` style for new API coverage. When changing auth, playlist, or download flows, run the isolated test stack before opening a PR.

## Commit & Pull Request Guidelines
Recent commits use short, imperative messages with optional prefixes like `feat:`, `fix:`, `refactor:`, and `chore:`. Keep commits scoped to one concern and describe the user-visible effect. PRs should explain what changed, why it changed, and how it was verified. Include screenshots for frontend work and note any new environment variables, secrets, or Docker changes.

## Security & Configuration Tips
Do not commit secrets or generated local overrides. This repository relies on `envs/base.env`, deployment env files such as `envs/local.env` and `envs/pi5.env`, the generated `.env`, and secret files under `secrets/` such as `secrets/secret_key.txt` and `secrets/db_password.txt`; keep secrets local and keep the generated `.env` out of version control. When changing Compose settings, verify the result with `make check` before merging.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **yt-diff** (4118 symbols, 10412 relationships, 352 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/yt-diff/context` | Codebase overview, check index freshness |
| `gitnexus://repo/yt-diff/clusters` | All functional areas |
| `gitnexus://repo/yt-diff/processes` | All execution flows |
| `gitnexus://repo/yt-diff/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
