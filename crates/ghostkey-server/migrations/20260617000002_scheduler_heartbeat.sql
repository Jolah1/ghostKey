-- Scheduler liveness heartbeat (monitoring).
--
-- The scheduler upserts last_tick_at on every successful tick; GET
-- /health reports it. This lets an external uptime check catch a
-- STALLED scheduler (process up but not ticking), not just a dead
-- process. For an inheritance product a silently stalled scheduler
-- means alarms never fire and a claim is never triggered, so this is
-- the single failure we most need to surface.
--
-- Single row, pinned to id = 1.
CREATE TABLE IF NOT EXISTS scheduler_heartbeat (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_tick_at  TEXT NOT NULL
);
