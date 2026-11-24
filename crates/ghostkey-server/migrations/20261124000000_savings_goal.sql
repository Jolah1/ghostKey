-- Savings goal per vault (#367): what the owner is saving for, and
-- optionally how much and by when. The title is personal ("School fees
-- for Ada"), so it is sealed with the vault key like the contacts; the
-- amount and date are plain because the server already knows the balance.
ALTER TABLE vaults ADD COLUMN savings_goal_title_ct    TEXT;
ALTER TABLE vaults ADD COLUMN savings_goal_title_nonce TEXT;
ALTER TABLE vaults ADD COLUMN savings_goal_sat         INTEGER;
ALTER TABLE vaults ADD COLUMN savings_goal_date        TEXT;
