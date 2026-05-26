#!/usr/bin/env bash
# scripts/backup-fly-db.sh
#
# Pull a fresh copy of the production SQLite database off the Fly
# volume and drop it in a cloud-synced folder so it lives in at least
# two physical places.
#
# Why this exists:
#   Fly volumes live on a single host machine. They survive deploys
#   and restarts, but a corrupted block, an accidental
#   `fly volumes destroy`, or a region-wide outage can take the
#   only copy with them. Bitcoin custody software cannot live on a
#   single-copy database.
#
# Usage:
#   ./scripts/backup-fly-db.sh                 # uses default dest below
#   BACKUP_DIR=/path/to/dir ./scripts/backup-fly-db.sh
#
# Set BACKUP_DIR in your shell rc (e.g. ~/.bashrc) so you don't have
# to remember it every time:
#   export BACKUP_DIR="/mnt/c/Users/you/OneDrive/ghostkey-backups"
#
# Frequency:
#   Monthly is plenty while traffic is low. Bump to weekly once you
#   have real users. Set a recurring calendar reminder rather than
#   trusting your memory — that's the whole point of the script.

set -euo pipefail

APP="${GHOSTKEY_FLY_APP:-ghostkey}"
DEFAULT_DIR="${HOME}/ghostkey-backups"
BACKUP_DIR="${BACKUP_DIR:-$DEFAULT_DIR}"
DATE="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/ghostkey-${DATE}.sqlite"

if [ "$BACKUP_DIR" = "$DEFAULT_DIR" ]; then
  printf 'warning: BACKUP_DIR not set; defaulting to %s\n' "$DEFAULT_DIR" >&2
  printf '         set BACKUP_DIR in your shell rc to a cloud-synced folder\n' >&2
  printf '         (Google Drive, OneDrive, Dropbox, iCloud Drive)\n' >&2
fi

if ! command -v fly >/dev/null 2>&1; then
  printf 'error: flyctl is not installed or not on PATH\n' >&2
  printf '       install: https://fly.io/docs/flyctl/install/\n' >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

printf 'pulling /data/ghostkey.sqlite from app=%s -> %s\n' "$APP" "$OUT"
fly ssh sftp get /data/ghostkey.sqlite "$OUT" -a "$APP"

# Sanity: the file must actually be a SQLite database, not an HTML
# error page or an empty file. SQLite files always start with the
# magic string "SQLite format 3\0". We read the first 15 bytes
# (skipping the trailing NUL) so bash doesn't warn about a null
# byte inside a $(...) capture.
HEADER="$(head -c 15 "$OUT" 2>/dev/null || true)"
case "$HEADER" in
  "SQLite format 3")
    SIZE="$(wc -c < "$OUT")"
    printf 'ok: %s bytes saved to %s\n' "$SIZE" "$OUT"
    ;;
  *)
    printf 'error: downloaded file does not look like a SQLite database\n' >&2
    printf '       header was: %s\n' "$HEADER" >&2
    printf '       (file kept at %s for inspection)\n' "$OUT" >&2
    exit 2
    ;;
esac

# Housekeeping: keep the most recent 12 backups so the cloud folder
# doesn't grow without bound. Adjust the number if you want a longer
# retention window.
KEEP=12
DELETED="$(
  ls -1t "$BACKUP_DIR"/ghostkey-*.sqlite 2>/dev/null \
    | tail -n +"$((KEEP + 1))" \
    | tee >(xargs -r rm -f) \
    | wc -l
)"
if [ "$DELETED" -gt 0 ]; then
  printf 'pruned %s old backup(s); keeping the %s most recent\n' "$DELETED" "$KEEP"
fi
