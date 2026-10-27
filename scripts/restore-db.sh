#!/usr/bin/env bash
# Restore a Plankton backup into a target database (v3.45.0).
#
# Usage:
#   scripts/restore-db.sh <backup-file.sql.gz.enc> [target_db] [--force]
#
# Default target: plankton_restore_test — safe throwaway DB for drills.
# Restoring over the LIVE database (target "plankton") requires --force and
# drops the current data first; take a fresh backup before you do that.
set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/etc/plankton/backup.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

CONTAINER="${BACKUP_CONTAINER:-plankton-postgres}"
DB_USER="${BACKUP_DB_USER:-plankton}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/plankton/backup.pass}"

FILE="${1:?usage: restore-db.sh <backup-file> [target_db] [--force]}"
TARGET="${2:-plankton_restore_test}"
FORCE="${3:-}"

[ -f "$FILE" ] || { echo "[restore] no such file: $FILE" >&2; exit 1; }
[ -f "$PASSPHRASE_FILE" ] || { echo "[restore] passphrase file $PASSPHRASE_FILE missing" >&2; exit 1; }
case "$TARGET" in
  *[!a-zA-Z0-9_]*) echo "[restore] invalid target db name: $TARGET" >&2; exit 1 ;;
esac
if [ "$TARGET" = "plankton" ] && [ "$FORCE" != "--force" ]; then
  echo "[restore] refusing to overwrite the live database without --force" >&2
  exit 1
fi

echo "[restore] $FILE -> $TARGET"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $TARGET"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $TARGET"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$PASSPHRASE_FILE" -in "$FILE" \
  | gunzip \
  | docker exec -i "$CONTAINER" psql -q -U "$DB_USER" -d "$TARGET"

echo "[restore] verifying ..."
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET" -tAc \
  "SELECT 'users=' || (SELECT COUNT(*) FROM users) || ' tasks=' || (SELECT COUNT(*) FROM tasks)"
echo "[restore] done"
