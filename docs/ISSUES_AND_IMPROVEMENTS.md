# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of the codebase.

*Note: Following recent extensive refactoring phases, major architecture, routing, rate-limiting, and input validation issues have been successfully addressed. The remaining items represent long-term goals.*

## Future Milestones

### 1. Hardcoded Process Operations

Raw array pushes like `downloadOptions.push('--trim-filenames')` are fine currently, but can become unruly over time if the scope of `yt-dlp` arguments grows dynamically per-video rather than globally. Consider abstracting `yt-dlp` argument generation into a more flexible builder pattern or isolated configuration mapper.

### 2. Active Monkey Patches

The codebase contains one active workaround for an upstream bug. See [`MONKEY_PATCHES.md`](./MONKEY_PATCHES.md) for full details, implementation snippets, and removal conditions.

- **`curl_cffi` Segfault** (`index.ts`) — `curl_cffi.Curl.reset` is patched to a no-op at runtime via `python3 -c` to prevent `SIGABRT` crashes when `--impersonate` is used. Remove once `curl_cffi` fixes `Curl.reset` safety upstream.

### 3. Large JSONB Payload Storage

The `raw_metadata` column on `VideoMetadata` currently stores heavily nested JSONB structures. While bulky arrays (formats/thumbnails) are pruned, accumulating this across thousands of videos might bloat PostgreSQL storage unnecessarily if the fields are never queried.

- **Suggested Improvement**: Periodically review whether `raw_metadata` is actively utilized. If not, consider extracting only specific metadata keys explicitly rather than a catch-all JSON dump, or offload this archival data to file-based cache.

---

### 4. Rate Limiting Defaults to Off When Unset

`config.cache.reqPerIP` is built as:

```ts
reqPerIP: parseInt(Deno.env.get("RATE_LIMIT_GLOBAL_MAX_REQUESTS") ?? "0", 10)
```

and `rateLimit` treats `0` as "disabled" (`src/middleware/rateLimit.ts:57`):

```ts
if (maxRequestsPerWindow === 0) {
  logger.debug("Rate limiting disabled (maxRequestsPerWindow is 0)");
```

So **an instance that never sets `RATE_LIMIT_GLOBAL_MAX_REQUESTS` has no rate
limiting at all.** A security control that silently defaults to off when unset
is backwards: forgetting a variable should not quietly remove a protection.

`envs/base.env` does set it to `10`, so the shipped compose deployments are
fine. The exposure is a deployment that builds its own env file and omits the
row — nothing warns.

- **Suggested Improvement**: default to a sane non-zero value (say `100`) and
  keep an explicit `0` as the opt-out. The disable path stays available for
  anyone who genuinely wants it, but it has to be chosen rather than inherited
  from an omission. Logging once at startup when rate limiting is disabled would
  also make the state obvious.
- **Status**: documented only, no code change — altering the default changes
  behaviour for existing deployments and deserves its own commit.

---

### 5. Root `package.json` Removed (resolved)

The repository root used to carry a `package.json` containing literally `{}`
plus an empty `package-lock.json`, while `deno.json` held the real dependency
graph. `.github/dependabot.yml` pointed its `npm` ecosystem at that root, so
Dependabot mis-detected the project as npm-with-no-dependencies.

Both files were unused — nothing in `Dockerfile`, `Dockerfile.alpine` or CI
referenced them (the `npm install` in the Docker build runs inside
`frontend_src/`, against the frontend submodule's own real manifest), and Deno
does not recreate them. They have been deleted and the Dependabot `npm` block
replaced with `gitsubmodule`.

> [!NOTE]
> Deno dependencies in `deno.json` / `deno.lock` are **not** a Dependabot-
> supported ecosystem, so backend dependency bumps remain manual. Use
> `deno outdated` to review them.

---
*Last updated at: 2026-08-02*
