-- Privacy-preserving landing-page analytics.
--
-- One row per (event_name, label, day-UTC) tuple, accumulating a
-- count. No IP, no fingerprint, no cookie — see DESIGN.md "What we
-- measure and why" for the reasoning.
--
-- The label column carries an optional discriminator within an
-- event (e.g. event="landing.cta_clicked" label="hero" vs
-- label="final"). We don't predefine the labels because the
-- landing-page section names will change as the page does; the
-- server validates the *shape* (regex) but not the value.
--
-- Day is stored as YYYY-MM-DD UTC because that's the granularity
-- the operator actually cares about ("how many people scrolled
-- past 'How it works' yesterday") and querying it as text avoids
-- the sqlx datetime parsing round-trip.

CREATE TABLE analytics_events (
    event_name TEXT    NOT NULL,
    label      TEXT    NOT NULL DEFAULT '',
    day        TEXT    NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_name, label, day)
) WITHOUT ROWID;

-- The dashboard query operators will run by hand for now is:
--   SELECT day, event_name, label, count
--   FROM analytics_events
--   WHERE day >= date('now', '-7 days')
--   ORDER BY day DESC, event_name, label;
-- A future admin-only HTTP endpoint can wrap that; see #24 follow-up.
CREATE INDEX analytics_events_day_idx ON analytics_events(day);
