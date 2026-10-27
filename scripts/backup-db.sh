#!/usr/bin/env bash
# Plankton encrypted nightly database backup (v3.45.0).
#
# Pipeline: docker exec pg_dump → gzip → openssl AES-256-CBC (pbkdf2, salted).
# Retention: BACKUP_RETENTION_DAYS (default 14). Optional offsite copy via
# rclone when BACKUP_REMOTE is set (e.g. "b2:plankton-backups" or "s3:my-bucket/plankton").
#
# Config precedence: environment > /etc/plankton/backup.env (BACKUP_ENV_FILE).
# The passphrase file must exist (create with: openssl rand -base64 32 > file).
#
# Run manually:   scripts/backup-db.sh
# Verify latest:  scripts/restore-db.sh "$(ls -t /var/backups/plankton/*.enc | head -1)"
set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/etc/plankton/backup.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

CONTAINER="${BACKUP_CONTAINER:-plankton-postgres}"
DB_USER="${BACKUP_DB_USER:-plankton}"
DB_NAME="${BACKUP_DB_NAME:-plankton}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/plankton}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/plankton/backup.pass}"
REMOTE="${BACKUP_REMOTE:-}"

log() { echo "[backup] $*"; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
[ -f "$PASSPHRASE_FILE" ] || die "passphrase file $PASSPHRASE_FILE missing (openssl rand -base64 32 > $PASSPHRASE_FILE && chmod 600 $PASSPHRASE_FILE)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/plankton-$STAMP.sql.gz.enc"
TMP="$OUT.tmp"

log "dumping $DB_NAME from container $CONTAINER ..."
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASSPHRASE_FILE" \
  > "$TMP"

SIZE=$(stat -c%s "$TMP")
if [ "$SIZE" -lt 10240 ]; then
  rm -f "$TMP"
  die "dump suspiciously small ($SIZE bytes) — keeping previous backups, nothing replaced"
fi
mv "$TMP" "$OUT"
chmod 600 "$OUT"
log "wrote $OUT ($SIZE bytes)"

# Retention: prune encrypted dumps older than the window.
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'plankton-*.sql.gz.enc' -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
[ "$PRUNED" -gt 0 ] && log "pruned $PRUNED backup(s) older than ${RETENTION_DAYS}d"

# Offsite (optional): rclone remote copy when configured.
if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$OUT" "$REMOTE" && log "offsite copy → $REMOTE"
  else
    log "WARN: BACKUP_REMOTE is set but rclone is not installed — offsite skipped"
  fi
else
  log "offsite not configured (BACKUP_REMOTE empty) — local backup only"
fi

log "done"
