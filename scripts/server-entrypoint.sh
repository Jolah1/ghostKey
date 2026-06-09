#!/usr/bin/env bash
# Entrypoint for the ghostkey-server container.
#
# When the four LITESTREAM_* env vars are present, the SQLite database
# is continuously replicated to S3-compatible object storage:
#
#   1. On boot, restore the DB from the replica if the local file is
#      missing (fresh volume after a disaster — this is the recovery
#      path working automatically).
#   2. Run the server under `litestream replicate -exec`, which
#      streams every WAL segment to the bucket within ~1s of commit
#      and forwards signals / exit codes like a proper supervisor.
#
# Without credentials we run the bare server and log a loud warning —
# fine for local docker and CI, unacceptable for production with real
# vaults. See DEPLOY.md § "Backups & disaster recovery".
set -euo pipefail

DB_PATH="/data/ghostkey.sqlite"

required=(
  LITESTREAM_ENDPOINT
  LITESTREAM_BUCKET
  LITESTREAM_ACCESS_KEY_ID
  LITESTREAM_SECRET_ACCESS_KEY
)
missing=()
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[entrypoint] WARNING: litestream disabled — missing: ${missing[*]}" >&2
  echo "[entrypoint] WARNING: the SQLite database is NOT being replicated." >&2
  echo "[entrypoint]          Production deployments must set all four LITESTREAM_* secrets." >&2
  exec /usr/local/bin/ghostkey-server
fi

echo "[entrypoint] litestream replication enabled (bucket: ${LITESTREAM_BUCKET})"

# Disaster recovery: a brand-new volume boots with no DB file. Pull
# the newest replica before the server can create an empty one.
# No-op when the local file already exists or the bucket is empty
# (first-ever boot).
litestream restore -if-db-not-exists -if-replica-exists "$DB_PATH"

# Hand PID 1 to litestream; it execs the server, forwards signals,
# and exits with the server's exit code.
exec litestream replicate -exec /usr/local/bin/ghostkey-server
