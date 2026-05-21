-- Initial schema for ghostkey-server.

CREATE TABLE IF NOT EXISTS vaults (
    id                  TEXT PRIMARY KEY,            -- uuid v4
    label               TEXT,
    network             TEXT NOT NULL,               -- "bitcoin"|"testnet"|"signet"|"regtest"
    descriptor_external TEXT NOT NULL UNIQUE,
    descriptor_internal TEXT NOT NULL,
    timelock_blocks     INTEGER NOT NULL,            -- 1..=65535
    -- proof-of-life parameters
    checkin_period_secs INTEGER NOT NULL,            -- desired cadence between check-ins
    grace_period_secs   INTEGER NOT NULL,            -- before notifications fire
    -- contact for the owner (optional; for notifier hooks)
    owner_contact       TEXT,
    -- contact for the heir (optional)
    heir_contact        TEXT,
    created_at          TEXT NOT NULL,
    -- last successful check-in observed by the server (heartbeat or
    -- on-chain detection). NULL until the first one.
    last_checkin_at     TEXT,
    -- next deadline; the scheduler raises an alarm once we pass this.
    next_deadline_at    TEXT NOT NULL,
    -- current alert phase: "ok" | "warning" | "alarmed" | "timelock_started" | "claimed"
    status              TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS idx_vaults_next_deadline ON vaults (next_deadline_at);
CREATE INDEX IF NOT EXISTS idx_vaults_status        ON vaults (status);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,           -- "registered"|"checkin"|"warning"|"alarm"|"resolved"
    detail      TEXT,                    -- free-form JSON
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_vault ON events (vault_id, id);
