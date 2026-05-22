-- Per-vault owner authentication tokens.
--
-- Until this migration, mutation endpoints on /vaults/:id were
-- protected only by the secrecy of the vault UUID. That's not
-- authentication; it's an obfuscation. This migration introduces a
-- proper bearer token issued at vault creation. The server stores
-- only the SHA-256 hash of the token; the raw value is returned to
-- the caller exactly once, in the create-vault response body.
--
-- Token semantics:
--   - 32 random bytes, base64-no-padding (44 chars).
--   - Stored as the hex SHA-256 hash (64 chars).
--   - Required on the Authorization header for:
--       POST   /vaults/:id/checkin
--       POST   /vaults/:id/issue-claim
--       GET    /vaults/:id
--       GET    /vaults/:id/events
--   - Constant-time comparison on lookup.
--
-- Existing rows (created before this column existed) have
-- owner_token_hash NULL. The server refuses mutations on those rows
-- until a token is issued for them, except when the deployment-wide
-- escape hatch GHOSTKEY_AUTH_DISABLED=1 is set (dev/test only).
--
-- The column is nullable for the same reason as claim_eligible_at:
-- SQLite cannot ALTER TABLE to add a NOT NULL column without a
-- default. New inserts always populate it.

ALTER TABLE vaults ADD COLUMN owner_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_owner_token
    ON vaults (owner_token_hash);
