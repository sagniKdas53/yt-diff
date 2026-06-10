# Monkey Patches

This document tracks all active workarounds where upstream code is patched at
build-time or runtime to fix bugs that have not yet been resolved in the
upstream project.

Each entry documents: what is broken, how it is patched, where the patch lives
in this codebase, and what condition allows the patch to be safely removed.

---

## Patch 1 — `curl_cffi` Segfault on `Curl.reset`

| Field                 | Detail                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream project**  | [curl_cffi](https://github.com/yifeikong/curl_cffi)                                                                                                           |
| **Symptom**           | `yt-dlp` process crashes with `SIGABRT` / `double free or corruption` when `--impersonate` is used on sites with frequent connection resets (e.g. `iwara.tv`) |
| **Root cause**        | `Curl.reset` invokes a C-level method on a Curl object that may have already been freed during rapid re-initialization cycles                                 |
| **Patch type**        | Runtime — injected Python one-liner via `python3 -c`                                                                                                          |
| **Patch location**    | `index.ts` — `YT_DLP_PATCHED_CMD` constant, used on every `spawn` call                                                                                        |
| **Upstream tracking** | No open issue or PR as of the time of writing; monitor `curl_cffi` releases                                                                                   |
| **Removal condition** | `curl_cffi` fixes the `Curl.reset` safety; revert all `spawn("python3", ["-c", YT_DLP_PATCHED_CMD, ...])` calls back to `spawn("yt-dlp", [...])`              |

### What the patch does

```python
import curl_cffi.curl
curl_cffi.curl.Curl.reset = lambda self: None
import sys, yt_dlp
sys.exit(yt_dlp.main())
```

### Implementation

In `index.ts`, instead of spawning `yt-dlp` directly:

```typescript
const YT_DLP_PATCHED_CMD =
  "import curl_cffi.curl; curl_cffi.curl.Curl.reset = lambda self: None; " +
  "import sys, yt_dlp; sys.exit(yt_dlp.main())";

const proc = spawn("python3", ["-c", YT_DLP_PATCHED_CMD, ...args]);
```

Full analysis: [`curl_cffi_segfault_analysis.md`](./curl_cffi_segfault_analysis.md)


---
*Last updated at: 2026-06-10T14:01:59+05:30*
