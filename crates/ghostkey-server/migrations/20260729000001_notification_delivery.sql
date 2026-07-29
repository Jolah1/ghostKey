-- Delivery outcomes, as distinct from provider handoff.
--
-- `status = 'sent'` has only ever meant "the provider's API returned
-- 2xx". For every channel that is a handoff receipt, not a delivery
-- receipt. Twilio answers `201 queued` and then fails the message
-- asynchronously (63007 unknown sender, 63016 outside the WhatsApp
-- session window, 30034 unregistered 10DLC); SMTP relays accept and
-- then hard-bounce. Both were invisible: the row read `sent`,
-- `attempts=1`, `last_error` NULL, while nothing arrived.
--
-- That is how a heir's practice-drill invite sat "sent" for six days
-- having never existed (mainnet notification id 40).
--
-- These columns hold the provider's own later verdict, keyed by the id
-- it gave us at handoff.

-- Provider's id for the message: Twilio's Message SID (SMxxx / MMxxx),
-- or the SMTP server's queue reply for email. NULL until handoff.
ALTER TABLE notifications ADD COLUMN provider_message_id TEXT;

-- The provider's verdict. NULL means we have not heard back, which is
-- the normal state between handoff and callback, and the permanent
-- state for a channel with no callback wired up. Otherwise one of:
--   'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed'
--   | 'bounced' | 'complained'
-- Deliberately a TEXT column rather than a CHECK constraint: providers
-- add statuses, and a row we can't classify is worth keeping verbatim.
ALTER TABLE notifications ADD COLUMN delivery_status TEXT;

-- The provider's reason code / message for a negative verdict, e.g.
-- Twilio's ErrorCode 63007. Free text, for operators.
ALTER TABLE notifications ADD COLUMN delivery_detail TEXT;

-- When the verdict arrived.
ALTER TABLE notifications ADD COLUMN delivery_updated_at TEXT;

-- The operator query behind /health's undelivered counter, and the
-- lookup the status webhook does on every callback.
CREATE INDEX IF NOT EXISTS idx_notifications_delivery
    ON notifications (delivery_status);
CREATE INDEX IF NOT EXISTS idx_notifications_provider_id
    ON notifications (provider_message_id);
