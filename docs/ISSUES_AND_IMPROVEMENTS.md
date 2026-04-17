# Technical Improvements and Edge Cases

This document highlights unchecked edge cases, security considerations, and code
improvements identified through an analysis of the codebase.

*Note: Following recent extensive refactoring phases, major architecture, routing, rate-limiting, and input validation issues have been successfully addressed. The remaining items represent long-term goals.*

## Future Milestones

### 1. Hardcoded Process Operations

Raw array pushes like `downloadOptions.push('--trim-filenames')` are fine currently, but can become unruly over time if the scope of `yt-dlp` arguments grows dynamically per-video rather than globally. Consider abstracting `yt-dlp` argument generation into a more flexible builder pattern or isolated configuration mapper.

### 2. Fragile `yt-dlp` Execution Workaround

The codebase currently uses a Python monkey patch (`YT_DLP_PATCHED_CMD`) injected directly via `python3 -c` to bypass a segmentation fault in `curl_cffi` during `yt-dlp` execution.

- **Suggested Improvement**: Track the upstream `curl_cffi` and `yt-dlp` repositories for a permanent fix. Once resolved, revert the extraction process to invoke the standard `yt-dlp` executable cleanly rather than patching Python's context at runtime.

### 3. Large JSONB Payload Storage

The `raw_metadata` column on `VideoMetadata` currently stores heavily nested JSONB structures. While bulky arrays (formats/thumbnails) are pruned, accumulating this across thousands of videos might bloat PostgreSQL storage unnecessarily if the fields are never queried.

- **Suggested Improvement**: Periodically review whether `raw_metadata` is actively utilized. If not, consider extracting only specific metadata keys explicitly rather than a catch-all JSON dump, or offload this archival data to file-based cache.
