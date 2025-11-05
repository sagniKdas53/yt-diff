# rename_files.js — behavior and usage

Overview
---------

`rename_files.js` scans videos belonging to a playlist and renames downloaded files and associated metadata so they follow the pattern:

`<sanitized title> [<videoId>].<ext>`

It also updates the corresponding `video_metadata` DB rows to point at the new file names.

Where it lives
--------------

- Script path: `scripts/rename_files.js`

Purpose
-------

- Fix filenames saved when `config.restrictFilenames` produced short or id-only names.
- Normalize file names to a human-friendly form that includes the video title and id.
- Rename both the main video file and related metadata files (description, comments, subtitle files, thumbnails) that share the same base name.
- Update DB rows to keep metadata fields in sync with on-disk names.

High-level behavior
-------------------

1. Connects to PostgreSQL with the same environment-variable defaults used by the backend.
2. Accepts a `--playlist=` argument — this may be a single playlist URL or `*` to process all playlists.
3. For each playlist to process, determines the save directory using `playlist.saveDirectory` (joined to `SAVE_PATH`) or the default `SAVE_PATH`.
4. Loads playlist/video mappings (`playlist_video_mapping`) and includes `video_metadata` rows.
5. For each mapping/video with `downloadStatus` truthy, attempts to find the main downloaded file on disk. The script searches for:
   - the filename in `video_metadata.fileName`, if present and exists on disk, or
   - files whose basename equals the `videoId`, or begins with `videoId` or `videoId.`
6. If files for that video are absent, the script will mark the DB row as not downloaded (clearing `downloadStatus` and file fields).
7. If files are present, build a sanitized new base name from `<title> [<id>]` and plan renames for main file and metadata files.
8. Execute renames (metadata files first, then main file), resolving collisions by adding `(1)`, `(2)`, etc. to the destination name.
9. Update DB fields (`fileName`, `descriptionFile`, `commentsFile`, `subTitleFile`, `thumbNailFile`) using heuristics based on file extensions and actual renamed results.

Flags / options
----------------

- `--playlist="<playlistUrl>"` — required. Use `--playlist="*"` to process all playlists.
- `--dry-run` — print planned actions and do not perform any filesystem changes or DB updates.

Environment variables and defaults
----------------------------------

Same as the backend defaults: `DB_HOST`, `DB_USERNAME`/`DB_USER`, `DB_NAME`, `DB_PASSWORD` (or `DB_PASSWORD_FILE`), and `SAVE_PATH` (default `/home/sagnik/Videos/yt-dlp/`).

Sanitization and filename rules
-------------------------------

- Titles are sanitized by removing control characters and filesystem-reserved characters and collapsing whitespace.
- Resulting filenames are truncated to a safe length (default 240 characters for the base name).
- If the video id is `NA` the script omits the `[id]` suffix.

Collision handling
------------------

- If a destination filename already exists, the script appends `(1)`, `(2)`, etc. until an unused name is found. The script warns when this happens. This applies to both metadata and main file renames.

DB updates
----------

- After successful renames, the script updates `video_metadata` rows with new `fileName` and metadata filenames.
- If no files are found for a video the script clears `downloadStatus` and related file fields to mark it as not downloaded.

Edge cases and behavior notes
-----------------------------

- The script only processes videos that are marked as downloaded (`downloadStatus` truthy). Videos with `downloadStatus` falsy are skipped.
- Metadata file detection uses patterns matching the original basename (likely the `videoId`) and common metadata extensions; mapping to DB fields uses extension heuristics (`.vtt`/`.srt` => subtitles, `.description`/`.txt` => description, `.comments` => comments, image extensions => thumbnail).
- If `video_metadata.fileName` contains an absolute or previously renamed filename, that is used as the primary lookup if it exists on disk.
- The script updates the DB only after successful renames, and wraps each video’s set of changes in a try/catch so a failure for one video doesn't abort the entire run.

Usage examples
--------------

- Dry-run a single playlist (no changes):

```bash
node scripts/rename_files.js --playlist="https://example.com/my-playlist" --dry-run
```

- Actually rename files for a single playlist:

```bash
node scripts/rename_files.js --playlist="https://example.com/my-playlist"
```

- Process all playlists (dry-run):

```bash
node scripts/rename_files.js --playlist="*" --dry-run
```

- Process all playlists (actual renames):

```bash
node scripts/rename_files.js --playlist="*"
```

Safety notes
------------

- The `--dry-run` option is handy for previewing changes.
- The script handles filename collisions safely by using incremented suffixes.
- The script may change many file names and DB entries when run with `*`; consider running in dry-run mode first and backing up the DB or the save directory before bulk changes.

Follow-ups / Improvements
-------------------------

Possible small improvements you may want:

- Add an `--interactive` mode to confirm each rename.
- Add a `--backup` option to save a JSON map of old -> new filenames before renaming (useful for rollback).
- Add tests that simulate filesystem and DB state (unit tests using temp directories and a test DB).
