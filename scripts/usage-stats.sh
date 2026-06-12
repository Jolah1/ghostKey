#!/usr/bin/env bash
# Print usage stats from the production database.
#
# Pulls a read-only copy of the SQLite file over fly ssh and runs the
# queries locally, so nothing is installed on (or written to) the prod
# machine. The copy can lag the live DB by a few seconds of WAL frames,
# which is fine for stats.
#
# Usage: scripts/usage-stats.sh [fly-app]   (default: ghostkey)
set -euo pipefail

APP="${1:-ghostkey}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching database copy from app '$APP'..." >&2
flyctl ssh sftp get /data/ghostkey.sqlite "$TMP/db.sqlite" -a "$APP" >/dev/null

python3 - "$TMP/db.sqlite" <<'EOF'
import sqlite3, sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
q = lambda sql: db.execute(sql).fetchall()

def section(title):
    print(f"\n=== {title} ===")

section("Vaults")
print("total:", q("SELECT COUNT(*) FROM vaults")[0][0])
for status, n in q("SELECT status, COUNT(*) FROM vaults GROUP BY status ORDER BY 2 DESC"):
    print(f"  {status}: {n}")
print("created last 7 days: ", q("SELECT COUNT(*) FROM vaults WHERE created_at > datetime('now','-7 days')")[0][0])
print("created last 30 days:", q("SELECT COUNT(*) FROM vaults WHERE created_at > datetime('now','-30 days')")[0][0])

section("Activity (events, last 14 days)")
for kind, n in q("SELECT kind, COUNT(*) FROM events WHERE created_at > datetime('now','-14 days') GROUP BY kind ORDER BY 2 DESC"):
    print(f"  {kind}: {n}")

section("Landing funnel (per day, last 14 days)")
rows = q("""
    SELECT day,
           SUM(CASE WHEN event_name='landing.section_viewed' AND label='hero' THEN count ELSE 0 END),
           SUM(CASE WHEN event_name='landing.cta_clicked' THEN count ELSE 0 END)
    FROM analytics_events
    WHERE day > date('now','-14 days')
    GROUP BY day ORDER BY day DESC
""")
print("  day          visits  cta-clicks")
for day, visits, clicks in rows:
    print(f"  {day}   {visits:>5}  {clicks:>9}")

section("Notifications (last 14 days)")
for kind, status, n in q("SELECT kind, status, COUNT(*) FROM notifications WHERE created_at > datetime('now','-14 days') GROUP BY kind, status ORDER BY 3 DESC"):
    print(f"  {kind} [{status}]: {n}")
not_sent = q("SELECT COUNT(*) FROM notifications WHERE status != 'sent' AND created_at > datetime('now','-14 days')")[0][0]
if not_sent:
    print(f"  WARNING: {not_sent} notification(s) not in 'sent' state — check SMTP")
EOF
