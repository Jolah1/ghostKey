-- Pre-deadline reminder bookkeeping + one-tap check-in token.
--
-- Two related features land in this migration:
--
--   1. Pre-deadline reminder. The scheduler now fires a single
--      "your check-in is due in 24h" email per cycle, in addition
--      to the alarm-fired email that ships once the deadline has
--      passed. To avoid re-sending the reminder on every scheduler
--      tick we need a marker that says "I sent it for THIS cycle"
--      \u2014 that marker is `pre_deadline_reminder_sent_at`. It's
--      cleared on every successful check-in so the next cycle
--      starts fresh.
--
--   2. One-tap check-in link. The reminder email and the alarm
--      email now both carry a URL the owner can tap to check in
--      with no further authentication. The URL embeds a fresh
--      bearer token; the server stores only the SHA-256 hash so
--      a DB leak cannot impersonate the owner. The hash is keyed
--      on the vault so the same column also doubles as the
--      "is the link still valid" gate. The token is single-use
--      AND single-cycle: consumed on first POST, AND cleared on
--      every successful check-in.
--
-- All four columns are nullable. Existing rows simply have no
-- reminder bookkeeping yet; the scheduler treats NULL as "never
-- sent this cycle" which is exactly the behaviour we want.
--
-- Indexed lookups: `idx_vaults_checkin_link_token` lets the new
-- POST /vaults/:id/checkin-from-link/:token route find the row
-- by hash in O(log n). The other three columns are read-only via
-- the vault primary key so they don't need their own index.
ALTER TABLE vaults ADD COLUMN pre_deadline_reminder_sent_at TEXT;
ALTER TABLE vaults ADD COLUMN checkin_link_token_hash       TEXT;
ALTER TABLE vaults ADD COLUMN checkin_link_token_issued_at  TEXT;
ALTER TABLE vaults ADD COLUMN checkin_link_token_used_at    TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_checkin_link_token
    ON vaults (checkin_link_token_hash);
