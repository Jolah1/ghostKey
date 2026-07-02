-- Claim fire drill (#223): let the heir rehearse the claim while the
-- owner is alive.
--
-- The drill token lives in its OWN column, never in claim_token_hash.
-- Every endpoint that can move money or reveal key material
-- (sealed-heir, heir-claim, build-psbt, broadcast, the claim video)
-- resolves the vault by claim_token_hash — so a drill token gets 404
-- from all of them by construction, not by a flag check someone could
-- forget in a future route.
--
--   drill_token_hash   : SHA-256 of the practice token (bearer value
--                        goes to the heir by email, and to the owner in
--                        the start-drill response).
--   drill_started_at   : when the owner last started a practice run.
--   drill_opened_at    : when the heir first opened the practice link
--                        (abandonment visibility: sent but never opened
--                        vs opened but never finished).
--   drill_completed_at : when the heir finished the practice claim —
--                        the permanent "watch it work" fact the owner
--                        dashboard shows.
ALTER TABLE vaults ADD COLUMN drill_token_hash TEXT;
ALTER TABLE vaults ADD COLUMN drill_started_at TEXT;
ALTER TABLE vaults ADD COLUMN drill_opened_at TEXT;
ALTER TABLE vaults ADD COLUMN drill_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_drill_token_hash
    ON vaults (drill_token_hash);
