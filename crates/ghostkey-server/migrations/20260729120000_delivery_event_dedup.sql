-- One row per delivery callback we have already acted on.
--
-- Delivery webhooks are at-least-once. Twilio retries a callback whose
-- response it didn't like (or didn't get), and Resend, whose events are
-- delivered through Svix, does the same. The recorder added in #311
-- acted on every callback unconditionally, so a single retried
-- `undelivered` wrote a second `notification_undelivered` event and the
-- owner's activity feed showed the same failure twice.
--
-- The primary key IS the deduplication. Insert first, and only touch
-- the notification when the insert is new.
--
-- `event_id` is whatever the provider gives us that is stable across
-- its own retries and distinct between real events:
--   twilio: no per-callback id exists, so `<MessageSid>:<MessageStatus>`
--           — Twilio sends one callback per status transition, and a
--           retry repeats both fields verbatim.
--   resend: the `svix-id` header, which is exactly this.
CREATE TABLE IF NOT EXISTS notification_delivery_events (
    provider        TEXT    NOT NULL,
    event_id        TEXT    NOT NULL,
    -- NULL when the callback named a message we never sent (a shared
    -- provider account, or a row deleted with its vault). Kept anyway
    -- so the replay guard still covers it.
    notification_id INTEGER,
    status          TEXT    NOT NULL,
    received_at     TEXT    NOT NULL,
    PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_events_notification
    ON notification_delivery_events (notification_id);
