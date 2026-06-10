-- Owner email verification.
--
-- The owner's email is the rail every check-in reminder and missed-
-- deadline alarm rides on. A typo'd address fails silently: the owner
-- believes they'll be nudged, no nudge ever arrives, and the vault
-- drifts to alarmed → claimable without them noticing. For a product
-- whose promise is "we'll remind you", that's the worst quiet failure
-- we have.
--
-- On vault creation (and on owner-requested resend) we mint a random
-- token, store only its SHA-256 hex here, and email the raw value as
-- a confirmation link. Tapping the link proves the address receives
-- our mail and sets `owner_contact_verified_at`.
--
-- Verification is informational, not gating: the scheduler still
-- attempts delivery to unverified addresses (the address is probably
-- fine; refusing to remind would make the failure mode worse, not
-- better). The dashboard uses the flag to nag the owner until the
-- loop is closed.
ALTER TABLE vaults ADD COLUMN owner_contact_verified_at TEXT;
ALTER TABLE vaults ADD COLUMN owner_contact_verify_token_hash TEXT;
ALTER TABLE vaults ADD COLUMN owner_contact_verify_sent_at TEXT;
