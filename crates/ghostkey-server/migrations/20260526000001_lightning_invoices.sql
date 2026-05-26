-- Lightning check-in invoices.
--
-- When an owner taps "check in with Lightning" on the dashboard, the
-- server asks its configured LightningProvider (today: Breez SDK -
-- Liquid) to mint a 1-sat BOLT11 invoice with the vault id in the
-- description. The invoice is written here in `pending` state and
-- returned to the browser as a QR + copyable string.
--
-- A background poller picks `pending` rows up, polls the provider for
-- payment status, and on success:
--   1. Marks the row `paid` with a `paid_at` timestamp.
--   2. Calls the same internal `mark_checkin` path the HTTP /checkin
--      route uses, so the vault's next_deadline_at and
--      claim_eligible_at are reset in exactly the same way.
--
-- An `expired` state catches invoices the payer never paid; we keep
-- the row for audit purposes but it cannot be reused.
--
-- Why store the BOLT11 string?
--   - The browser may close before the user pays; on reopen we can
--     show them the same invoice (BOLT11 invoices include their own
--     expiry, so we honour that and re-mint after it lapses).
--   - It gives operators a way to manually confirm a payment status
--     against a Lightning explorer if the poller misbehaves.
--
-- We deliberately do NOT store anything that identifies the *payer*.
-- Lightning payments are pseudonymous; the only information we have
-- is "someone with knowledge of the invoice paid it." That suffices
-- for the "I'm alive" semantics.

CREATE TABLE IF NOT EXISTS lightning_invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id        TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    -- BOLT11 string. Indexed for the poller's lookup-by-bolt11 path.
    bolt11          TEXT    NOT NULL UNIQUE,
    -- 32-byte SHA-256 hash of the preimage, hex-encoded. The provider
    -- uses this as the primary key for payment status queries.
    payment_hash    TEXT    NOT NULL UNIQUE,
    amount_sat      INTEGER NOT NULL,
    -- pending | paid | expired | failed
    status          TEXT    NOT NULL DEFAULT 'pending',
    created_at      TEXT    NOT NULL,
    -- Provider-side invoice expiry (RFC3339). After this we mark the
    -- row `expired` regardless of poll outcome.
    expires_at      TEXT    NOT NULL,
    paid_at         TEXT,
    last_polled_at  TEXT,
    last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_lightning_invoices_pending
    ON lightning_invoices (status, last_polled_at);

CREATE INDEX IF NOT EXISTS idx_lightning_invoices_vault
    ON lightning_invoices (vault_id, created_at);
