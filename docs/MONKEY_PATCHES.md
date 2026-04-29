# Monkey Patches

This document tracks all active workarounds where upstream code is patched at
build-time or runtime to fix bugs that have not yet been resolved in the
upstream project.

Each entry documents: what is broken, how it is patched, where the patch lives
in this codebase, and what condition allows the patch to be safely removed.

---

## Patch 1 — `curl_cffi` Segfault on `Curl.reset`

| Field | Detail |
|---|---|
| **Upstream project** | [curl_cffi](https://github.com/yifeikong/curl_cffi) |
| **Symptom** | `yt-dlp` process crashes with `SIGABRT` / `double free or corruption` when `--impersonate` is used on sites with frequent connection resets (e.g. `iwara.tv`) |
| **Root cause** | `Curl.reset` invokes a C-level method on a Curl object that may have already been freed during rapid re-initialization cycles |
| **Patch type** | Runtime — injected Python one-liner via `python3 -c` |
| **Patch location** | `index.ts` — `YT_DLP_PATCHED_CMD` constant, used on every `spawn` call |
| **Upstream tracking** | No open issue or PR as of the time of writing; monitor `curl_cffi` releases |
| **Removal condition** | `curl_cffi` fixes the `Curl.reset` safety; revert all `spawn("python3", ["-c", YT_DLP_PATCHED_CMD, ...])` calls back to `spawn("yt-dlp", [...])` |

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

## Patch 2 — `yt-dlp` Iwara Extractor Post-Migration Fix

| Field | Detail |
|---|---|
| **Upstream project** | [yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **Upstream PR** | [#16014](https://github.com/yt-dlp/yt-dlp/pull/16014) — _not yet merged_ |
| **Fixes issues** | [#16009](https://github.com/yt-dlp/yt-dlp/issues/16009), [#16146](https://github.com/yt-dlp/yt-dlp/issues/16146) |
| **Symptom** | After iwara.tv migrated its infrastructure, only 360p/preview formats could be fetched; higher quality formats and login all broke |
| **Root cause** | Three hardcoded values became stale after site migration: API domain (`api.iwara.tv`), files domain (`files.iwara.tv`), and the X-Version HMAC secret key used to sign file-listing requests |
| **Patch type** | Build-time — `sed -i` applied to the installed `iwara.py` extractor inside the Docker image |
| **Patch location** | `Dockerfile`, within the final stage `RUN` block, immediately after `pip install yt-dlp` |
| **Removal condition** | PR #16014 is merged into yt-dlp master **and** a new pip release is published; bump the pip install and delete the patch block |

### What the patch changes

| Old value | New value | Affects |
|---|---|---|
| `api.iwara.tv` | `apiq.iwara.tv` | Login, media token, video/user/playlist API calls |
| `files.iwara.tv` | `filesq.iwara.tv` | Thumbnail URLs |
| `5nFp9kmbNnHdAFhaqMvt` | `mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN` | X-Version SHA1 HMAC secret for file-listing endpoint |

### Implementation

In `Dockerfile` (final stage `RUN` block):

```dockerfile
# Patch iwara extractor: update API domain, files domain, and X-Version secret key
# Fixes formats beyond 360p/preview (yt-dlp PR #16014, not yet merged upstream)
echo "DEBUG: Applying iwara extractor patch (PR #16014)" && \
IWARA_PY=$(find /opt/venv/lib -name 'iwara.py' -path '*/yt_dlp/extractor/*') && \
sed -i \
    -e "s|'https://api\.iwara\.tv/|'https://apiq.iwara.tv/|g" \
    -e 's|"https://api\.iwara\.tv/|"https://apiq.iwara.tv/|g' \
    -e "s|https://files\.iwara\.tv/|https://filesq.iwara.tv/|g" \
    -e "s|5nFp9kmbNnHdAFhaqMvt|mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN|g" \
    "$IWARA_PY" && \
echo "DEBUG: Iwara patch applied to $IWARA_PY" && \
```
