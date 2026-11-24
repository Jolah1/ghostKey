-- Several savings goals per vault (#367, step 2).
--
-- Goals are a view, not a place: one deposit address, one set of coins.
-- Each goal's "saved" figure is the sum of its ledger entries. A deposit
-- is sorted into a goal with one tap (a 'deposit' entry); money can be
-- moved between goals ('move' entries, one negative and one positive);
-- a send can say which goal it came from ('spend', negative). Nothing
-- here touches the chain or the heir's claim.

CREATE TABLE IF NOT EXISTS savings_goals (
    id          TEXT PRIMARY KEY,
    vault_id    TEXT NOT NULL,
    -- Personal ("School fees for Ada"), so sealed with the vault key like
    -- the single goal before it.
    title_ct    TEXT NOT NULL,
    title_nonce TEXT NOT NULL,
    amount_sat  INTEGER,
    target_date TEXT,     -- YYYY-MM-DD
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS savings_goals_vault ON savings_goals (vault_id);

CREATE TABLE IF NOT EXISTS savings_goal_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id   TEXT NOT NULL,
    goal_id    TEXT NOT NULL,
    amount_sat INTEGER NOT NULL,   -- positive in, negative out
    kind       TEXT NOT NULL,      -- 'deposit' | 'move' | 'spend'
    outpoint   TEXT,               -- set for 'deposit'
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS savings_goal_entries_goal ON savings_goal_entries (goal_id);

-- When the owner answered "which goal is this for?" (or said "none").
-- NULL means not asked yet.
ALTER TABLE vault_deposits ADD COLUMN sorted_at TEXT;

-- The single goal becomes the first of many. The sealed title is copied
-- as is: the key is per vault, so it opens the same in its new home.
INSERT INTO savings_goals (id, vault_id, title_ct, title_nonce, amount_sat, target_date, created_at)
SELECT 'g-' || id, id, savings_goal_title_ct, savings_goal_title_nonce,
       savings_goal_sat, savings_goal_date, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM vaults
 WHERE savings_goal_title_ct IS NOT NULL AND savings_goal_title_nonce IS NOT NULL;

-- That goal tracked the whole vault, so its deposits so far are its money.
INSERT INTO savings_goal_entries (vault_id, goal_id, amount_sat, kind, outpoint, created_at)
SELECT d.vault_id, g.id, d.amount_sat, 'deposit', d.outpoint, d.seen_at
  FROM vault_deposits d
  JOIN savings_goals g ON g.id = 'g-' || d.vault_id;

-- Nobody is asked about money from before goals could be sorted.
UPDATE vault_deposits SET sorted_at = seen_at WHERE sorted_at IS NULL;
