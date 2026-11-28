//! `POST /claim-code` (#393): the heir types the code from their message
//! at the site instead of opening the link, and gets the same claim.
//!
//! A real claim's code is checked first, then a practice run's. Either
//! way the answer is only the token the link already carries, and the
//! claim page then applies every guard the link gets. A code is cleared
//! whenever its claim is (check-in, freeze, re-issue), and a code whose
//! token no longer matches the live one is refused, so a stale code can't
//! open a newer claim.
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::crypto::{
    claim_code_lookup, claim_token_matches, normalize_claim_code, open_claim_code,
};
use crate::routes::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ClaimCodeRequest {
    pub code: String,
}

#[derive(Debug, Serialize)]
pub struct ClaimCodeResponse {
    /// The token the message's link carries: open `#/claim/{token}`.
    pub token: String,
}

pub async fn exchange_claim_code(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ClaimCodeRequest>,
) -> Result<Json<ClaimCodeResponse>, ApiError> {
    let Some(code) = normalize_claim_code(&req.code) else {
        return Err(ApiError::Validation(
            "That doesn't look like the code. It's 12 letters and numbers, like ABCD-EFGH-JKMN."
                .into(),
        ));
    };
    let lookup = claim_code_lookup(&code)?;
    for (lookup_col, sealed_col, hash_col) in [
        ("claim_code_lookup", "claim_code_sealed", "claim_token_hash"),
        ("drill_code_lookup", "drill_code_sealed", "drill_token_hash"),
    ] {
        let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(&format!(
            "SELECT id, {sealed_col}, {hash_col} FROM vaults WHERE {lookup_col} = ?"
        ))
        .bind(&lookup)
        .fetch_optional(&state.db)
        .await?;
        if let Some((id, Some(sealed), Some(hash))) = row {
            let (_, token) = open_claim_code(&id, &sealed)?;
            if claim_token_matches(&token, &hash) {
                return Ok(Json(ClaimCodeResponse { token }));
            }
        }
    }
    Err(ApiError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{hash_claim_token, issue_claim_code, seal_claim_code};

    fn ensure_test_master_key() {
        use base64::Engine;
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0u8; 32]);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe { std::env::set_var("GHOSTKEY_MASTER_KEY", &b64) };
        }
        let _ = crate::crypto::ensure_master_key_loaded();
    }

    async fn state() -> Arc<AppState> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        Arc::new(AppState { db: pool })
    }

    async fn vault(state: &AppState, id: &str) {
        let ts = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO vaults (id, network, descriptor_external, descriptor_internal, timelock_blocks, \
                                 checkin_period_secs, grace_period_secs, created_at, next_deadline_at) \
             VALUES (?, 'signet', ?, ?, 144, 3600, 3600, ?, ?)",
        )
        .bind(id)
        .bind(format!("ext-{id}"))
        .bind(format!("int-{id}"))
        .bind(&ts)
        .bind(&ts)
        .execute(&state.db)
        .await
        .unwrap();
    }

    /// Give `id` a code for `token` in the real-claim or practice columns.
    async fn give_code(
        state: &AppState,
        id: &str,
        practice: bool,
        token: &str,
        live_token: &str,
    ) -> String {
        let code = issue_claim_code().unwrap();
        let sealed = seal_claim_code(id, &code.code, token).unwrap();
        let (l, s, h) = if practice {
            ("drill_code_lookup", "drill_code_sealed", "drill_token_hash")
        } else {
            ("claim_code_lookup", "claim_code_sealed", "claim_token_hash")
        };
        sqlx::query(&format!(
            "UPDATE vaults SET {l} = ?, {s} = ?, {h} = ? WHERE id = ?"
        ))
        .bind(&code.lookup)
        .bind(&sealed)
        .bind(hash_claim_token(live_token))
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
        code.code
    }

    async fn exchange(state: &Arc<AppState>, code: &str) -> Result<String, ApiError> {
        exchange_claim_code(
            State(state.clone()),
            Json(ClaimCodeRequest { code: code.into() }),
        )
        .await
        .map(|r| r.0.token)
    }

    #[tokio::test]
    async fn a_typed_code_opens_its_claim_or_practice_and_nothing_else() {
        ensure_test_master_key();
        let s = state().await;
        vault(&s, "v-real").await;
        vault(&s, "v-practice").await;
        vault(&s, "v-stale").await;
        let real = give_code(&s, "v-real", false, "real-token", "real-token").await;
        let practice = give_code(&s, "v-practice", true, "drill-token", "drill-token").await;
        // Re-issued since: the code's token is no longer the live one.
        let stale = give_code(&s, "v-stale", false, "old-token", "new-token").await;

        assert_eq!(exchange(&s, &real).await.unwrap(), "real-token");
        // However it's typed.
        assert_eq!(
            exchange(&s, &real.to_lowercase().replace('-', " "))
                .await
                .unwrap(),
            "real-token"
        );
        assert_eq!(exchange(&s, &practice).await.unwrap(), "drill-token");
        assert!(matches!(
            exchange(&s, &stale).await,
            Err(ApiError::NotFound)
        ));
        // A code nobody was given.
        let unknown = issue_claim_code().unwrap().code;
        assert!(matches!(
            exchange(&s, &unknown).await,
            Err(ApiError::NotFound)
        ));
        // Not a code at all.
        assert!(matches!(
            exchange(&s, "hello").await,
            Err(ApiError::Validation(_))
        ));
    }
}
