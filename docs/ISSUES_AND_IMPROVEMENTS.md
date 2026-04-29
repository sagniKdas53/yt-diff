# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of the codebase.

*Note: Following recent extensive refactoring phases, major architecture, routing, rate-limiting, and input validation issues have been successfully addressed. The remaining items represent long-term goals.*

## Future Milestones

### 1. Hardcoded Process Operations

Raw array pushes like `downloadOptions.push('--trim-filenames')` are fine currently, but can become unruly over time if the scope of `yt-dlp` arguments grows dynamically per-video rather than globally. Consider abstracting `yt-dlp` argument generation into a more flexible builder pattern or isolated configuration mapper.

### 2. Active Monkey Patches

The codebase contains two active workarounds for upstream bugs. See [`MONKEY_PATCHES.md`](./MONKEY_PATCHES.md) for full details, implementation snippets, and removal conditions.

- **`curl_cffi` Segfault** (`index.ts`) — `curl_cffi.Curl.reset` is patched to a no-op at runtime via `python3 -c` to prevent `SIGABRT` crashes when `--impersonate` is used. Remove once `curl_cffi` fixes `Curl.reset` safety upstream.

- **`yt-dlp` Iwara Extractor** (`Dockerfile`) — A `sed` patch applied at image build time updates the API domain (`api.iwara.tv` → `apiq.iwara.tv`), files domain, and X-Version HMAC secret key following iwara.tv's site migration. Tracked upstream at [yt-dlp PR #16014](https://github.com/yt-dlp/yt-dlp/pull/16014). Remove once PR #16014 is merged and a new yt-dlp pip release is published.


### 3. Large JSONB Payload Storage

The `raw_metadata` column on `VideoMetadata` currently stores heavily nested JSONB structures. While bulky arrays (formats/thumbnails) are pruned, accumulating this across thousands of videos might bloat PostgreSQL storage unnecessarily if the fields are never queried.

- **Suggested Improvement**: Periodically review whether `raw_metadata` is actively utilized. If not, consider extracting only specific metadata keys explicitly rather than a catch-all JSON dump, or offload this archival data to file-based cache.
