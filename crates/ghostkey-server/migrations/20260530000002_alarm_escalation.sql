-- Alarm escalation: daily urgent reminders during the 14-day alarmed window.
-- last_alarm_reminder_sent_at: cleared on every successful check-in.
-- alarm_reminder_count: incremented each send; tells emails how many reminders
--   have already gone out (0 = first, 1 = second, …) so copy can escalate.
ALTER TABLE vaults ADD COLUMN last_alarm_reminder_sent_at TEXT;
ALTER TABLE vaults ADD COLUMN alarm_reminder_count INTEGER NOT NULL DEFAULT 0;
