-- Claim-challenge window.
--
-- `claim_opened_at` is stamped the first time anyone resolves a valid,
-- unconsumed claim token. From that moment the key material and the
-- claim endpoints stay locked for a configurable window
-- (GHOSTKEY_CLAIM_CHALLENGE_SECS, default 48h) while the owner and the
-- trusted contact are alerted — a live owner cancels the claim with a
-- single check-in (which also clears these columns), a dead one merely
-- delays the heir by the window.
--
-- `claim_ready_notified_at` dedupes the "your waiting period is over"
-- email the scheduler sends the heir once the window has elapsed.
ALTER TABLE vaults ADD COLUMN claim_opened_at TEXT;
ALTER TABLE vaults ADD COLUMN claim_ready_notified_at TEXT;
