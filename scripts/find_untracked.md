# find_untracked.js — behavior and usage

Overview
---------

`find_untracked.js` scans your download/save directories and finds files on disk that are not tracked by the database (i.e. files that don't match any filename or metadata file referenced in the `video_metadata` DB rows).

Purpose
-------

- Help locate orphaned or leftover files produced by downloads.
- Provide a safe way to list them and optionally remove them (either by moving to trash or permanent deletion).
- Save a JSON report summarizing the run for auditing/recovery.

Where it lives
--------------

- Script path: `scripts/find_untracked.js`

High-level behavior
-------------------

1. Connects to the PostgreSQL DB using credentials from environment variables (same defaults as `index.js`).
2. Reads all video records and extracts fields that contain file names (`fileName`, `descriptionFile`, `commentsFile`, `subTitleFile`, `thumbNailFile`).
3. Builds a set of known filenames (plus a few common temporary/partial suffix variants like `.part`, `.ytdl`, `.temp.*`).
4. Queries `playlist_metadata` for configured `saveDirectory` values and constructs the set of directories to scan (always includes `SAVE_PATH`).
5. Recursively walks each directory, skipping obvious noise like `.git` and `node_modules`.
6. For every file discovered, if its basename is not in the known set it is considered "untracked".
7. Reports each untracked file and collects per-file details.
8. Optionally deletes or trashes untracked files, depending on the chosen flags.
9. Writes a JSON results file that contains timestamp, stats, and per-file outcomes.

Flags / options
----------------

- `--dry-run` (default behavior when no action flag given) — list files that would be acted on but do not change anything.
- `--trash` — move untracked files to the system trash using `trash-cli`.
- `--delete` — permanently delete untracked files using `fs.unlink`.
- `--results-file=<path>` — path to write the JSON results (defaults to a timestamped `untracked_YYYYMMDD_HHMMSS.json`).

Notes about flags
-----------------

- `--trash` and `--delete` are mutually exclusive; the script will refuse if both are provided.
- If neither `--trash` nor `--delete` is provided the script defaults to a safe `--dry-run` listing mode.
- When `--trash` is used (and not a dry-run), the script checks that `trash-cli` is available and exits with instructions if it is missing.

Environment variables and defaults
----------------------------------

- `DB_HOST` — default `localhost`.
- `DB_USERNAME` / `DB_USER` — default `ytdiff`.
- `DB_NAME` / `DB_DATABASE` — default `vidlist`.
- `DB_PASSWORD` — default `ytd1ff` (or read from `DB_PASSWORD_FILE` if provided).
- `SAVE_PATH` — default `/home/sagnik/Videos/yt-dlp/`.

Outputs and artifacts
---------------------

- Console logging listing found/untracked files, which files were moved to trash/deleted, and a summary with counts and sizes.
- JSON report saved to `--results-file` (or default timestamped file) with structure like:
  - `timestamp` — run time
  - `dryRun` — boolean
  - `knownFilesCount` — count of known DB filenames
  - `stats` — scanned, untracked, deleted, bytes, errors
  - `files` — array of objects: `{ path, relativePath, size, action, success, error? }`
  - `summary` — consolidated stats

Safety and recovery
-------------------

- Default is safe: listing only. The user must explicitly request `--trash` or `--delete`.
- `--trash` uses `trash-cli` so trashed files can (usually) be restored via the desktop environment's trash UI or `trash` CLI commands.
- The JSON report makes it straightforward to see what happened and to restore or re-run actions selectively if needed.

Edge cases and behavior notes
-----------------------------

- The filename comparison is based on basenames. Files in different subdirectories under the scanned root will be considered independently.
- The script adds common variant names for each DB file (e.g., `.part`, `.ytdl`, `.temp.*`) so in-progress or temporary files are treated as tracked when possible.
- Very large directories will be traversed recursively — expect scan time proportional to number of files. Consider narrowing `SAVE_PATH` or playlist save directories when necessary.
- Files with the same desired name but different case may be considered distinct on case-sensitive filesystems.

Examples
--------

- Dry run (list only):

```bash
node scripts/find_untracked.js
```

- Move untracked files to trash and save report:

```bash
node scripts/find_untracked.js --trash --results-file=trash-results.json
```

- Permanently delete untracked files (dangerous):

```bash
node scripts/find_untracked.js --delete
```

Installation note
-----------------

If planning to use `--trash`, install `trash-cli` first:

```bash
sudo apt-get install trash-cli   # Debian/Ubuntu
# OR
npm install -g trash-cli         # via npm
```

Contact / follow-ups
--------------------

If you want additional safety, we can add:

- An interactive confirmation prompt before performing deletion/trash operations.
- A size threshold or age threshold (e.g., only touch files > / < a certain age).
- A dry-run diff that shows which DB row references would change if files are renamed or removed.
