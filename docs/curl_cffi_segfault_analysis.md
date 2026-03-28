# Analysis: `curl_cffi` Memory Corruption & Segfault during `yt-dlp` Execution

## Overview
This document details a critical memory corruption issue (specifically `double free or corruption`) occurring in the `curl_cffi` Python library when used as a backend for `yt-dlp`. This issue was identified while fetching content from `iwara.tv` using the `--impersonate Chrome-133` flag (which triggers the use of `curl_cffi`).

## Issue Description
When `yt-dlp` uses `curl_cffi` to impersonate modern browsers, the underlying C-library (`curl_cffi`'s C-level Curl object) can fail to handle rapid connection resets or chunked stream interruptions.

### Symptom
The process crashes with:
```
double free or corruption (out)
Aborted (core dumped)
```
In a Node.js environment, this results in the `ChildProcess` exiting with `code = null` and a `signal = SIGABRT`.

### Root Cause
The crash occurs when the Python library attempts to invoke the `reset` method on a C-level Curl object that has already been partially or fully freed, or when the state management of the Curl object becomes inconsistent due to network resets.

## Identification
The issue was localized to the `Curl.reset` method in `curl_cffi.curl`. By forcing this method to do nothing, the stability of the long-running `yt-dlp` process was restored without observable side effects on the download or listing tasks.

## The Monkey Patch Fix
To mitigate this without modifying the system-wide Python environment or waiting for an upstream fix, we intercept the `yt-dlp` execution by wrapping it in a Python one-liner that patches the library in memory before execution.

### Patch Command
```python
import curl_cffi.curl; 
curl_cffi.curl.Curl.reset = lambda self: None; 
import sys, yt_dlp; 
sys.exit(yt_dlp.main())
```

### Implementation in `yt-diff`
In `index.ts`, we changed all `spawn` calls from direct `yt-dlp` execution to:
```typescript
const YT_DLP_PATCHED_CMD = "import curl_cffi.curl; curl_cffi.curl.Curl.reset = lambda self: None; import sys, yt_dlp; sys.exit(yt_dlp.main())";

const process = spawn("python3", ["-c", YT_DLP_PATCHED_CMD, ...args]);
```

## Bug Reporting Metadata
- **Library**: `curl_cffi` (observed on version `0.12.0` and later)
- **Environment**: Docker (Debian/Ubuntu based), Python 3.x
- **Trigger**: `yt-dlp` with `--impersonate` flag on sites with frequent connection resets (e.g., `iwara.tv`).
- **Error Type**: `SIGABRT`, `double free or corruption`.

## Suggested Upstream Action
The `curl_cffi` maintainers should investigate the safety of the `Curl.reset` method, specifically ensuring that any underlying C-objects are not accessed after being freed during rapid re-initialization cycles.
