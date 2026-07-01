//! Operator-only read endpoints, gated by `AdminAuth`.
//!
//!   GET /admin/newsletter  -> the decrypted subscriber list
//!   GET /admin/analytics   -> last-30-day aggregate event counts
//!
//! Both require the admin bearer token (its SHA-256 must match
//! `GHOSTKEY_ADMIN_TOKEN_HASH`). With no admin token configured,
//! `AdminAuth` rejects every request, so these endpoints are closed by
//! default — see `auth.rs`.
//!
//! These are deliberately read-only. The newsletter addresses are
//! sealed at rest, so this handler is the one place they're decrypted;
//! keep it behind the admin token and off any public surface.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::auth::AdminAuth;
use crate::routes::ApiError;
use crate::AppState;

/// One newsletter subscriber, decrypted for the operator.
#[derive(Debug, Serialize)]
pub struct SubscriberView {
    pub email: String,
    /// Which CTA/page the signup came from, if recorded.
    pub source: Option<String>,
    pub created_at: String,
}

/// GET /admin/newsletter — every subscriber, newest first, decrypted.
pub async fn list_newsletter(
    _admin: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SubscriberView>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT email_ciphertext, email_nonce, source, created_at \
           FROM newsletter_subscribers ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|(ciphertext_b64, nonce_b64, source, created_at)| {
            // Context stays "waitlist" (see newsletter.rs): it's the
            // fixed key-derivation label every row was sealed under. A
            // row we can't open is surfaced, not silently dropped, so
            // the operator notices a key/data mismatch.
            let email = crate::crypto::open_for_vault(
                "waitlist",
                &crate::crypto::SealedContact {
                    ciphertext_b64,
                    nonce_b64,
                },
            )
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| "<undecryptable>".to_string());
            SubscriberView {
                email,
                source,
                created_at,
            }
        })
        .collect();

    Ok(Json(out))
}

/// One aggregate analytics bucket: a per-day count for an event/label.
#[derive(Debug, Serialize)]
pub struct AnalyticsRow {
    pub day: String,
    pub event_name: String,
    pub label: String,
    pub count: i64,
}

/// GET /admin/analytics — aggregate counts for the last 30 days.
///
/// This is the by-hand query the analytics migration documents, wrapped
/// behind the admin token. Still aggregate-only: no per-visitor rows
/// exist to return.
pub async fn analytics_summary(
    _admin: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AnalyticsRow>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, String, i64)>(
        "SELECT day, event_name, label, count \
           FROM analytics_events \
          WHERE day >= date('now', '-30 days') \
          ORDER BY day DESC, event_name, label",
    )
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|(day, event_name, label, count)| AnalyticsRow {
            day,
            event_name,
            label,
            count,
        })
        .collect();

    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;

    fn ensure_test_master_key() {
        use base64::Engine;
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0u8; 32]);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", b64);
            }
        }
    }

    async fn fresh_state() -> Arc<AppState> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        Arc::new(AppState {
            db: pool,
            lightning: Arc::new(crate::lightning::NoopProvider),
        })
    }

    #[tokio::test]
    async fn newsletter_export_round_trips_the_sealed_email() {
        ensure_test_master_key();
        let state = fresh_state().await;

        // Seed a subscriber through the real subscribe handler so the
        // seal context matches production exactly.
        crate::newsletter::subscribe(
            State(state.clone()),
            Json(crate::newsletter::SubscribeRequest {
                email: "sarah@example.com".into(),
                source: Some("footer".into()),
            }),
        )
        .await
        .expect("subscribe");

        // The admin export decrypts it back to plaintext.
        let Json(list) = list_newsletter(AdminAuth, State(state.clone()))
            .await
            .expect("export");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].email, "sarah@example.com");
        assert_eq!(list[0].source.as_deref(), Some("footer"));
    }
}
