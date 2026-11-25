-- Savings challenges the owner opted into. Opt-in, no penalty, nobody
-- told: stopping one or missing it just ends it.
--
-- Only what was joined and when is stored. Progress is worked out on
-- every read from the deposits, spends and goals already on file
-- (see challenges.rs), so it can't disagree with them.
--
--   hold          "Don't touch it": no coins leave for hold_months.
--   goal_by_date  reach goal_id's amount by its date.
--   every_month   a deposit in every month from the join month to
--                 December of `year`.
--   week52        week k saves k x week1_sat, with catch-up.
CREATE TABLE IF NOT EXISTS savings_challenges (
    id                   TEXT PRIMARY KEY,
    vault_id             TEXT NOT NULL,
    kind                 TEXT NOT NULL,
    started_at           TEXT NOT NULL,
    hold_months          INTEGER,
    goal_id              TEXT,
    year                 INTEGER,
    week1_sat            INTEGER,
    -- Ended without finishing: 'stopped' by the owner, or 'over' (a coin
    -- left, the date passed, a month was missed, the goal was removed).
    ended_at             TEXT,
    end_reason           TEXT,
    completed_at         TEXT,
    -- The congratulations email, claimed before it is queued so it can
    -- only ever go once.
    completion_emailed_at TEXT
);
CREATE INDEX IF NOT EXISTS savings_challenges_vault ON savings_challenges (vault_id);
-- At most one of each kind running per vault.
CREATE UNIQUE INDEX IF NOT EXISTS savings_challenges_one_running
    ON savings_challenges (vault_id, kind)
    WHERE ended_at IS NULL AND completed_at IS NULL;
