-- Signing in is the check-in, and the time without one before the heir is
-- contacted is the vault's own waiting period (3, 6, 9 or 12 months),
-- not a fixed 30 days.

-- Reminders go 7, 3 and 1 day before the deadline. This counts how many
-- went out this cycle. It only counts while pre_deadline_reminder_sent_at
-- is set, so every path that resets that (each check-in) resets this too.
ALTER TABLE vaults ADD COLUMN pre_deadline_reminder_stage INTEGER NOT NULL DEFAULT 0;
-- The old single 24h reminder already sent this cycle: nothing more due.
UPDATE vaults SET pre_deadline_reminder_stage = 3
 WHERE pre_deadline_reminder_sent_at IS NOT NULL;

-- One explainer email per owner about the change, sent by the scheduler.
ALTER TABLE vaults ADD COLUMN rhythm_notice_pending INTEGER NOT NULL DEFAULT 0;

-- Existing vaults: the no-sign-in time becomes the waiting period
-- (blocks x 10 minutes). Vaults mid-claim or finished are left alone.
UPDATE vaults
   SET checkin_period_secs   = timelock_blocks * 600,
       rhythm_notice_pending = CASE WHEN status IN ('ok', 'alarmed', 'warning') THEN 1 ELSE 0 END
 WHERE checkin_period_secs < timelock_blocks * 600
   AND status IN ('unfunded', 'ok', 'alarmed', 'warning');

-- A running clock moves out to a full new period from the last sign of
-- life, exactly as a check-in would set it. Never earlier than today's
-- deadline. RFC 3339 so it compares with the rest of the column.
UPDATE vaults
   SET next_deadline_at = strftime('%Y-%m-%dT%H:%M:%S+00:00',
                                   COALESCE(last_checkin_at, created_at),
                                   '+' || (checkin_period_secs + grace_period_secs) || ' seconds'),
       claim_eligible_at = strftime('%Y-%m-%dT%H:%M:%S+00:00',
                                    COALESCE(last_checkin_at, created_at),
                                    '+' || (checkin_period_secs + 2 * grace_period_secs) || ' seconds')
 WHERE rhythm_notice_pending = 1
   AND status = 'ok'
   AND julianday(COALESCE(last_checkin_at, created_at), '+' || (checkin_period_secs + grace_period_secs) || ' seconds')
       > julianday(next_deadline_at);
