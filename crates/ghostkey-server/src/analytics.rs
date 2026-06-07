//! Privacy-preserving landing-page analytics.
//!
//! POST /events  { event: "<name>", label?: "<discriminator>" }
//!
//! Increments a per-day counter keyed on (event_name, label,
//! day-UTC). No IP, no fingerprint, no cookie persisted. The
//! `rate_limit` layer in the router does key by IP for the
//! 429-on-flood guard, but those buckets are in-memory and never
//! cross-correlated with this table.
//!
//! See DESIGN.md "What we measure and why" for the privacy posture
//! and the rationale for what we deliberately do NOT collect.
//!
//! ## Validation
//!
//! - `event` is required and must match `^[a-z][a-z0-9_.]{0,63}$`.
//!   The leading lowercase letter + dot/underscore-only body keeps
//!   the table indexable as plain text and prevents log injection.
//! - `label` is optional, defaults to empty, max 64 chars, same
//!   character class as `event`.
//! - Both fields are rejected with 400 on shape violation. We do
//!   NOT enforce an allow-list of names: the landing page evolves
//!   too fast for that to be useful, and the worst-case abuse is
//!   "extra rows in analytics_events" — already capped by the
//!   per-IP rate limiter on /events.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct TrackRequest {
    pub event: String,
    #[serde(default)]
    pub label: Option<String>,
}

fn looks_like_event_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

fn looks_like_label(s: &str) -> bool {
    // Same rules as the event name, but empty is allowed (it's the
    // default when the client doesn't pass a label).
    if s.is_empty() {
        return true;
    }
    looks_like_event_name(s)
}

pub async fn track(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TrackRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !looks_like_event_name(&req.event) {
        return Err((
            StatusCode::BAD_REQUEST,
            "event must match ^[a-z][a-z0-9_.]{0,63}$".into(),
        ));
    }
    let label = req.label.unwrap_or_default();
    if !looks_like_label(&label) {
        return Err((
            StatusCode::BAD_REQUEST,
            "label, if present, must match ^[a-z][a-z0-9_.]{0,63}$".into(),
        ));
    }
    let day = Utc::now().format("%Y-%m-%d").to_string();

    if let Err(e) = bump(&state.db, &req.event, &label, &day).await {
        // The endpoint is best-effort — we deliberately do not 500
        // the visitor's browser if SQLite is briefly contended. Log
        // and respond 204 so the client's beacon doesn't retry.
        tracing::warn!(error = ?e, event = %req.event, "analytics bump failed");
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn bump(pool: &SqlitePool, event: &str, label: &str, day: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO analytics_events (event_name, label, day, count)
        VALUES (?1, ?2, ?3, 1)
        ON CONFLICT(event_name, label, day) DO UPDATE
          SET count = count + 1
        "#,
    )
    .bind(event)
    .bind(label)
    .bind(day)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_shape_rules() {
        assert!(looks_like_event_name("landing.hero_viewed"));
        assert!(looks_like_event_name("landing.cta_clicked"));
        assert!(looks_like_event_name("a"));

        // Empty.
        assert!(!looks_like_event_name(""));
        // Starts with digit / underscore / dot.
        assert!(!looks_like_event_name("1foo"));
        assert!(!looks_like_event_name("_foo"));
        assert!(!looks_like_event_name(".foo"));
        // Uppercase or whitespace.
        assert!(!looks_like_event_name("Landing.hero"));
        assert!(!looks_like_event_name("landing hero"));
        // Too long.
        assert!(!looks_like_event_name(&"a".repeat(65)));
    }

    #[test]
    fn label_allows_empty() {
        assert!(looks_like_label(""));
        assert!(looks_like_label("hero"));
        assert!(!looks_like_label("Hero"));
    }
}
