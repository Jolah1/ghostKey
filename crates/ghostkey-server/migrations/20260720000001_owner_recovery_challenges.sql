-- Email-verified cross-device owner recovery.
--
-- The previous flow exposed vault summaries by unsalted email hash and
-- exposed password-encrypted owner blobs by UUID. Recovery now sends a
-- short-lived one-time challenge to the encrypted owner email. Only
-- successful redemption returns summaries and sealed blobs.
CREATE TABLE owner_recovery_challenges (
    token_hash       TEXT PRIMARY KEY,
    owner_email_hash TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    used_at          TEXT
);

CREATE INDEX idx_owner_recovery_challenges_email
    ON owner_recovery_challenges (owner_email_hash, created_at);

CREATE INDEX idx_owner_recovery_challenges_expiry
    ON owner_recovery_challenges (expires_at);
