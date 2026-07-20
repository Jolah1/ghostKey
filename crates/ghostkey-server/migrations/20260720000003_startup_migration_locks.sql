CREATE TABLE startup_migration_locks (
    name TEXT PRIMARY KEY NOT NULL,
    touched_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO startup_migration_locks (name)
VALUES ('legacy-claim-token-sealing');
