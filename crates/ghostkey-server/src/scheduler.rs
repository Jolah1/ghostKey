//! Background scheduler. Periodically:
//!
//! 1. Finds vaults whose `next_deadline_at` is in the past and bumps them
//!    out of `ok` to `warning` / `alarmed`.
//! 2. Records events that callers (or external notifier integrations) can
//!    use to send emails, push notifications, etc.
//!
//! This v1 scheduler is intentionally simple: a single tick loop. It does
//! NOT yet watch the chain — that integration plugs in via the CLI's chain
//! sync today, and will live in this crate behind a `chain-sync` feature.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;

use crate::routes::record_event;
use crate::AppState;

pub async fn run(state: Arc<AppState>, tick: Duration) {
    loop {
        if let Err(e) = tick_once(&state).await {
            tracing::error!(error = ?e, "scheduler tick failed");
        }
        tokio::time::sleep(tick).await;
    }
}

async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();

    // Find vaults that are still in 'ok' but past deadline.
    let due = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM vaults WHERE status = 'ok' AND next_deadline_at <= ?",
    )
    .bind(&now)
    .fetch_all(&state.db)
    .await?;

    for (id,) in due {
        tracing::warn!(vault_id = %id, "deadline missed; transitioning to 'alarmed'");
        sqlx::query("UPDATE vaults SET status = 'alarmed' WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
        record_event(
            &state.db,
            &id,
            "alarm",
            Some(serde_json::json!({"reason": "checkin_missed"})),
        )
        .await?;
    }

    Ok(())
}
