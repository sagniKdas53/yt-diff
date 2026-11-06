#!/usr/bin/env bash
# Loads the test data into a throwaway Postgres on localhost:55432. Its data lives
# in memory, so `down` or a reboot removes it. It never connects to anything else.
#
#   load.sh             start the database if needed, then load the pack and edge cases
#   load.sh --pack-only load the pack without the edge cases, and run check.sql
#   load.sh down        stop and remove the database
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
NAME=yt-diff-seed-db
PORT=55432
PSQL=(docker exec -i "$NAME" psql -q -U ytdiff -d vidlist -X -v ON_ERROR_STOP=1)

if [[ "${1:-}" == "down" ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "Stopped $NAME"
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_USER=ytdiff -e POSTGRES_PASSWORD=testpassword -e POSTGRES_DB=vidlist \
    -p "127.0.0.1:$PORT:5432" postgres:16-alpine >/dev/null
fi

for _ in $(seq 1 60); do
  # The image restarts Postgres after first-run setup, so wait for a real query.
  docker exec "$NAME" psql -U ytdiff -d vidlist -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done

export DB_HOST=localhost DB_PORT=$PORT DB_USERNAME=ytdiff DB_PASSWORD=testpassword
export SECRET_KEY=seed-secret-key-not-used-anywhere-else
(cd "$ROOT" && deno run -A "$HERE/init_schema.ts" 2>&1 | grep -E "Unable|error|Error" || true)

gunzip -c "$HERE/seed.sql.gz" | "${PSQL[@]}"

if [[ "${1:-}" == "--pack-only" ]]; then
  "${PSQL[@]}" <"$HERE/check.sql" | grep -vE '^(SELECT|Pager|Output)'
  exit 0
fi

"${PSQL[@]}" <"$HERE/edge-cases.sql"
echo "Loaded. DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USERNAME=$DB_USERNAME DB_PASSWORD=$DB_PASSWORD"
echo "Log in as seed-admin / seed-password"
