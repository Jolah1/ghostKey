-- Web push subscriptions for check-in reminders.
--
-- One row per (vault, browser). A vault can have several rows — the
-- owner's phone and laptop each register their own subscription. The
-- endpoint URL is minted by the browser's push service (FCM, Mozilla
-- autopush, Apple) and is effectively a capability: treat it like a
-- bearer credential and never log it.
--
-- p256dh / auth are the browser-generated encryption parameters from
-- PushSubscription.toJSON().keys, stored base64url exactly as the
-- browser hands them over. Rows are deleted when the push service
-- reports the subscription gone (404/410) or the owner unsubscribes.
CREATE TABLE push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (vault_id, endpoint)
);

CREATE INDEX idx_push_subscriptions_vault ON push_subscriptions(vault_id);
