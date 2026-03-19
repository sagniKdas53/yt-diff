#!/bin/bash

# Configuration
ENV_FILE=".env"
LOCAL_ENV_FILE=".localenv"
DB_PASS_FILE="db_password.txt"

# Check if a file argument was provided
if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file.sql.gz> [--drop]"
    exit 1
fi
# Optional flags
DROP_DB=false
if [[ "$2" == "--drop" ]]; then
    DROP_DB=true
fi

BACKUP_FILE=$1

# Check if file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: File '$BACKUP_FILE' not found."
    exit 1
fi

# Load basic environment variables for script logic
# We use grep to avoid comments and blank lines
if [ -f "$ENV_FILE" ]; then
    DB_USERNAME=$(grep "^DB_USERNAME=" "$ENV_FILE" | cut -d'=' -f2)
    DB_NAME=$(grep "^DB_NAME=" "$ENV_FILE" | cut -d'=' -f2)
fi

# Override with local env if present
if [ -f "$LOCAL_ENV_FILE" ]; then
    # Examples might override these
    LOCAL_DB_USERNAME=$(grep "^DB_USERNAME=" "$LOCAL_ENV_FILE" | cut -d'=' -f2)
    LOCAL_DB_NAME=$(grep "^DB_NAME=" "$LOCAL_ENV_FILE" | cut -d'=' -f2)
    [ -n "$LOCAL_DB_USERNAME" ] && DB_USERNAME=$LOCAL_DB_USERNAME
    [ -n "$LOCAL_DB_NAME" ] && DB_NAME=$LOCAL_DB_NAME
fi

# Defaults if not found
DB_USERNAME=${DB_USERNAME:-ytdiff}
DB_NAME=${DB_NAME:-vidlist}

# Get DB password
if [ -f "$DB_PASS_FILE" ]; then
    DB_PASSWORD=$(cat "$DB_PASS_FILE")
else
    echo "Error: Could not read $DB_PASS_FILE"
    exit 1
fi

if [ -z "$DB_PASSWORD" ]; then
    echo "Error: DB password is empty in $DB_PASS_FILE"
    exit 1
fi

# Run the restore
echo "Restoring $BACKUP_FILE to database '$DB_NAME' as user '$DB_USERNAME'..." | tee -a restore.log
if $DROP_DB; then
    echo "Dropping existing database $DB_NAME..." | tee -a restore.log
    PGPASSWORD="$DB_PASSWORD" docker compose --env-file "$ENV_FILE" --env-file "$LOCAL_ENV_FILE" exec -T yt-db dropdb -U "$DB_USERNAME" "$DB_NAME" || true
    echo "Creating database $DB_NAME..." | tee -a restore.log
    PGPASSWORD="$DB_PASSWORD" docker compose --env-file "$ENV_FILE" --env-file "$LOCAL_ENV_FILE" exec -T yt-db createdb -U "$DB_USERNAME" "$DB_NAME"
fi
zcat "$BACKUP_FILE" | PGPASSWORD="$DB_PASSWORD" docker compose --env-file "$ENV_FILE" --env-file "$LOCAL_ENV_FILE" exec -T yt-db psql -U "$DB_USERNAME" -d "$DB_NAME" | tee -a restore.log

if [ $? -eq 0 ]; then
    echo "----------------------------------------" | tee -a restore.log
    echo "Restore completed successfully." | tee -a restore.log
else
    echo "----------------------------------------" | tee -a restore.log
    echo "Restore failed." | tee -a restore.log
    exit 1
fi
