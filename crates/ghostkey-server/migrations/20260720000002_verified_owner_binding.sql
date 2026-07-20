-- An owner email hash is not authoritative until the inbox holder taps
-- its verification link. Once verified, the address may be shared by
-- several vaults only when they carry the same owner account key.
--
-- Keep this invariant in SQLite, not only in route code: two server
-- replicas can verify competing pending rows concurrently.
CREATE TRIGGER IF NOT EXISTS prevent_conflicting_verified_owner_email
BEFORE UPDATE OF owner_contact_verified_at ON vaults
WHEN NEW.owner_contact_verified_at IS NOT NULL
 AND OLD.owner_contact_verified_at IS NULL
 AND NEW.owner_email_hash IS NOT NULL
 AND EXISTS (
     SELECT 1
       FROM vaults AS existing
      WHERE existing.id != NEW.id
        AND existing.owner_email_hash = NEW.owner_email_hash
        AND existing.owner_contact_verified_at IS NOT NULL
        AND existing.status != 'claimed'
        AND (
            existing.owner_xpub_fragment_external IS NULL
            OR NEW.owner_xpub_fragment_external IS NULL
            OR existing.owner_xpub_fragment_external != NEW.owner_xpub_fragment_external
        )
 )
BEGIN
    SELECT RAISE(ABORT, 'verified owner email belongs to a different owner key');
END;

CREATE TRIGGER IF NOT EXISTS prevent_conflicting_verified_owner_email_insert
BEFORE INSERT ON vaults
WHEN NEW.owner_contact_verified_at IS NOT NULL
 AND NEW.owner_email_hash IS NOT NULL
 AND EXISTS (
     SELECT 1
       FROM vaults AS existing
      WHERE existing.owner_email_hash = NEW.owner_email_hash
        AND existing.owner_contact_verified_at IS NOT NULL
        AND existing.status != 'claimed'
        AND (
            existing.owner_xpub_fragment_external IS NULL
            OR NEW.owner_xpub_fragment_external IS NULL
            OR existing.owner_xpub_fragment_external != NEW.owner_xpub_fragment_external
        )
 )
BEGIN
    SELECT RAISE(ABORT, 'verified owner email belongs to a different owner key');
END;

-- A per-vault resend timer can be bypassed by creating many pending
-- vaults for the same address. Reserve sends by email hash instead.
CREATE TABLE IF NOT EXISTS email_send_cooldowns (
    purpose      TEXT NOT NULL,
    email_hash   TEXT NOT NULL,
    last_sent_at INTEGER NOT NULL,
    PRIMARY KEY (purpose, email_hash)
);
