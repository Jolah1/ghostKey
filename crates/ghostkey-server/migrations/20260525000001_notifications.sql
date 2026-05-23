-- Notification queue.
--
-- The scheduler used to write a raw claim token into events.detail
-- and rely on an operator to forward it to the heir by hand. That's
-- workable for one or two vaults; it doesn't scale and it leaves a
-- secret in a JSON column that's easy to grep.
--
-- This table makes outbound notifications first-class:
--
--   - kind            'claim_link', 'alarm_owner', etc. The handler
--                     picks a template per kind.
--   - channel         'email' today; 'sms' and 'whatsapp' planned.
--   - recipient       Where to send (e.g. an email address). Stored
--                     encrypted (XChaCha20-Poly1305, per-vault key,
--                     same primitive used for heir contacts).
--   - subject         Encrypted at rest. Plaintext is sender-visible
--                     metadata once the message goes out, but at-rest
--                     we don't want operator-visible PII via a SQL
--                     dump.
--   - body            Encrypted at rest. Same reasoning. Includes
--                     the claim token in plaintext post-decrypt -- a
--                     row leak is therefore as sensitive as leaking
--                     the token itself, which is why we encrypt.
--   - status          pending -> sending -> sent OR failed_retrying
--                     -> failed_permanent. The worker uses CAS-style
--                     UPDATE ... WHERE status='pending' to claim a
--                     row (single-worker today; if we ever run more
--                     than one we'll move to a proper lease pattern).
--   - attempts        For retry budgeting.
--   - last_error      Short string for debugging.
--   - scheduled_at    Earliest time the worker should attempt this.
--                     Defaults to created_at; retries push it out.
--   - sent_at         When the SMTP/HTTP send returned success.
--
-- The encrypted columns share their key derivation with the heir
-- contact columns on `vaults`: HKDF-SHA256(master_key, vault_id,
-- "ghostkey:contact:v1"). That deliberately means anyone who can
-- decrypt heir contacts can also decrypt notifications -- they hold
-- the same "I have read access to this vault's PII" capability.

CREATE TABLE IF NOT EXISTS notifications (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id            TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    kind                TEXT    NOT NULL,
    channel             TEXT    NOT NULL,
    recipient_ciphertext TEXT   NOT NULL,
    recipient_nonce     TEXT    NOT NULL,
    subject_ciphertext  TEXT,
    subject_nonce       TEXT,
    body_ciphertext     TEXT    NOT NULL,
    body_nonce          TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'pending',
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TEXT    NOT NULL,
    scheduled_at        TEXT    NOT NULL,
    sent_at             TEXT
);

-- The worker's hot query: find the next due pending row. Composite
-- index so we don't full-scan even at high notification volumes.
CREATE INDEX IF NOT EXISTS idx_notifications_due
    ON notifications (status, scheduled_at);

-- Useful for the dashboard's per-vault audit ("show me what we
-- tried to send").
CREATE INDEX IF NOT EXISTS idx_notifications_vault
    ON notifications (vault_id, created_at);
