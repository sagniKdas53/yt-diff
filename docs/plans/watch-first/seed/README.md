# Test data pack

About 144 KB of pseudonymized YouTube rows from the real archive, with synthetic
rows for everything YouTube can't show.

## Use it

```bash
docs/plans/watch-first/seed/load.sh             # the pack and the edge cases
docs/plans/watch-first/seed/load.sh --pack-only # the pack alone, with its check
docs/plans/watch-first/seed/load.sh down        # stop and remove the database
```

This starts a throwaway Postgres on `localhost:55432`, held in memory. It
creates the schema with the app's own `initializeDatabase`, so columns from
later plans just stay null. Loading again replaces the data.

Connect with
`DB_HOST=localhost DB_PORT=55432 DB_USERNAME=ytdiff
DB_PASSWORD=testpassword`,
and log in as `seed-admin` / `seed-password`. There are no media files.

## What's in it

| File             | Contents                                                           |
| :--------------- | :----------------------------------------------------------------- |
| `seed.sql.gz`    | 59 playlists, 876 videos, 941 mappings, 87 bot rows, one test user |
| `edge-cases.sql` | Synthetic rows on `.example` hosts                                 |
| `check.sql`      | Measures the pack's shape, using plan 05's rules                   |
| `audit.sql`      | Duplicate and pile queries, for production                         |
| `extract.sql`    | The read-only production query behind the pack                     |
| `build_seed.ts`  | Replaces everything identifying, and fails on any non-YouTube row  |

From the real archive, it includes every YouTube row in Unlisted and its other
playlist homes, the first and last three rows of each YouTube playlist, and
YouTube bot submissions.

## Expected numbers

`load.sh --pack-only` prints these, and production gave the same result for its
YouTube rows on 2026-11-06:

| Rows | Distinct positions | Ties | Inversions |
| :--- | :----------------- | :--- | :--------- |
| 559  | 559                | 0    | 0          |

| Unlisted | In a playlist | Clips | In auto-channels | Auto-channels | Saved | Links |
| :------- | :------------ | :---- | :--------------- | :------------ | :---- | :---- |
| 559      | 43            | 141   | 20               | 5             | 41    | 314   |

If they differ, either the pack or the rules have changed. Find out which.

## What the edge cases cover

A clip-heavy site, the 2-minute boundary, a bad duration, one channel across
`www.`, `m.` and bare hosts, a channel key that attacks SQL, the same id on two
sites, a handle matching a playlist in a different case, a handle that's a URL
word, null and `"NA"` metadata, non-ASCII titles, tied positions, a monitored
End playlist, a mixed playlist, and bot rows with running and expired clocks.

## How it stays safe to publish

This repository is public, so:

- **Scope:** only YouTube rows leave production. Other sites aren't in the
  extract, and the build fails if one appears.
- **Left out at the source:** `raw_metadata` is reduced to named keys in the
  query, so cookies, request headers, file paths and descriptions never leave
  the Pi. Password hashes and the heartbeat table aren't read at all.
- **Replaced:** titles, ids, names, folders, file names, URL paths, chat ids and
  error text. Pseudonyms use an HMAC under a random key that isn't kept, so a
  guess can't be confirmed by hashing it.
- **Timestamps:** each keeps its day and its order against the others, with a
  made-up time of day.
- **Kept:** upload dates, durations, sizes, codecs, download state and
  positions.

The 2026-11-06 build was scanned for all 5,334 real strings it was made from,
and none were found.

## Rebuilding

You need SSH to the Pi. Keep the raw extract out of the repository, delete it
afterwards, and repeat the scan before committing.

```bash
ssh pi5 'docker exec -i yt-db psql -U ytdiff -d vidlist -XAt -v ON_ERROR_STOP=1 -f -' \
  < extract.sql > /some/private/pull.jsonl
SEED_KEY=$(openssl rand -hex 32) deno run -A --no-config --node-modules-dir=none \
  build_seed.ts /some/private/pull.jsonl /some/private/seed.sql
gzip -9n -c /some/private/seed.sql > seed.sql.gz
```

Then run `check.sql` against production and against `load.sh --pack-only`, and
compare.
