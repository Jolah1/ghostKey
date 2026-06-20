//! Early-access waitlist signups from the landing page.
//!
//! POST /waitlist  { email: "<addr>", source?: "<label>" }
//!
//! Stores the address sealed at rest (master-key XChaCha20-Poly1305,
//! context "waitlist") plus a SHA-256 hash for dedupe. See the
//! `20260620000002_waitlist.sql` migration for the privacy rationale.
//!
//! Always answers 200 on a well-formed request, whether or not the
//! address was already on the list: the page should say "you're on the
//! list" either way, and we don't leak membership.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::routes::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
    pub email: String,
    /// Optional: which CTA/page the signup came from (e.g. "hero",
    /// "final_cta"). Same character class as analytics labels.
    #[serde(default)]
    pub source: Option<String>,
}

/// Minimal email shape check: one `@`, a dot in the domain, no spaces,
/// sane length. We deliberately don't over-validate — RFC-5322 perfect
/// validation rejects valid addresses and the real test is whether the
/// confirmation email lands.
fn looks_like_email(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 3 || s.len() > 254 || s.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

/// Same character class as analytics labels: optional, <=64 chars,
/// lowercase/digit/underscore/dot. Anything else is dropped to empty
/// rather than rejected, so a stray source can't fail an otherwise-good
/// signup.
fn clean_source(s: Option<String>) -> Option<String> {
    let s = s?;
    let s = s.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    if s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
    {
        Some(s.to_string())
    } else {
        None
    }
}

fn email_hash(normalized: &str) -> String {
    let digest = Sha256::digest(normalized.as_bytes());
    hex::encode(digest)
}

pub async fn join(
    State(state): State<Arc<AppState>>,
    Json(req): Json<JoinRequest>,
) -> Result<StatusCode, ApiError> {
    if !looks_like_email(&req.email) {
        return Err(ApiError::Validation(
            "that doesn't look like an email".into(),
        ));
    }
    let normalized = req.email.trim().to_lowercase();
    let hash = email_hash(&normalized);
    let source = clean_source(req.source);

    // Seal the address at rest so the row alone never reveals it. A
    // CryptoError (e.g. missing master key) maps to a 500 without
    // leaking the reason.
    let sealed = crate::crypto::seal_for_vault("waitlist", normalized.as_bytes())?;

    // INSERT OR IGNORE on the unique hash: a repeat signup is a no-op,
    // so we never leak "already joined" and never duplicate a person.
    sqlx::query(
        r#"INSERT OR IGNORE INTO waitlist
               (email_hash, email_ciphertext, email_nonce, source, created_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(&hash)
    .bind(&sealed.ciphertext_b64)
    .bind(&sealed.nonce_b64)
    .bind(source.as_deref())
    .bind(Utc::now().to_rfc3339())
    .execute(&state.db)
    .await?;

    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_shape() {
        assert!(looks_like_email("a@b.co"));
        assert!(looks_like_email("  Sarah.Smith@example.com "));
        assert!(!looks_like_email("nope"));
        assert!(!looks_like_email("no@domain"));
        assert!(!looks_like_email("@example.com"));
        assert!(!looks_like_email("a b@example.com"));
        assert!(!looks_like_email("trailing@dot."));
    }

    #[test]
    fn source_cleaning() {
        assert_eq!(clean_source(Some("hero".into())), Some("hero".into()));
        assert_eq!(
            clean_source(Some("final_cta".into())),
            Some("final_cta".into())
        );
        assert_eq!(clean_source(Some("  spaced out  ".into())), None);
        assert_eq!(clean_source(Some("<script>".into())), None);
        assert_eq!(clean_source(None), None);
    }

    #[test]
    fn hash_is_normalized_and_stable() {
        // Same address in different case/whitespace hashes identically once
        // normalized by the handler.
        assert_eq!(
            email_hash("sarah@example.com"),
            email_hash("sarah@example.com")
        );
        assert_ne!(email_hash("a@example.com"), email_hash("b@example.com"));
        assert_eq!(email_hash("sarah@example.com").len(), 64);
    }

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
    async fn join_seals_dedupes_and_validates() {
        ensure_test_master_key();
        let state = fresh_state().await;

        // Bad email is rejected (400 Validation).
        let bad = join(
            State(state.clone()),
            Json(JoinRequest {
                email: "not-an-email".into(),
                source: None,
            }),
        )
        .await;
        assert!(matches!(bad, Err(ApiError::Validation(_))), "got {bad:?}");

        // First signup persists one sealed row.
        let ok = join(
            State(state.clone()),
            Json(JoinRequest {
                email: "  Sarah@Example.com ".into(),
                source: Some("final_cta".into()),
            }),
        )
        .await
        .expect("first join ok");
        assert_eq!(ok, StatusCode::OK);

        // A repeat (different case/whitespace) is a no-op: still one row.
        let dup = join(
            State(state.clone()),
            Json(JoinRequest {
                email: "sarah@example.com".into(),
                source: None,
            }),
        )
        .await
        .expect("dup join ok");
        assert_eq!(dup, StatusCode::OK);

        let (count, ct, nonce, source): (i64, String, String, Option<String>) = sqlx::query_as(
            "SELECT COUNT(*) OVER (), email_ciphertext, email_nonce, source \
               FROM waitlist LIMIT 1",
        )
        .fetch_one(&state.db)
        .await
        .expect("one row");
        assert_eq!(count, 1, "deduped to a single row");
        assert_eq!(source.as_deref(), Some("final_cta"));

        // The sealed address round-trips to the normalized form, and the
        // ciphertext is not the plaintext.
        assert_ne!(ct, "sarah@example.com");
        let opened = crate::crypto::open_for_vault(
            "waitlist",
            &crate::crypto::SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nonce,
            },
        )
        .expect("open sealed email");
        assert_eq!(String::from_utf8(opened).unwrap(), "sarah@example.com");
    }
}
