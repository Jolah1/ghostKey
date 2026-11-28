//! Moving an older vault to an heir code (option a), and the owner's
//! "I gave them the code" confirmation.
//!
//! Older vaults lock the heir's key under a claim token that the server
//! keeps (sealed under its master key) so it can email the link. That
//! means the server could rebuild the heir's key. Upgrading hands the
//! owner's browser that token and the locked key once, the browser
//! re-locks the key with a fresh heir code (and the video message with
//! the code's video key), and the server swaps them in and forgets the
//! token. From then on the vault is like any new one: the link is minted
//! at trigger time, hash-only.
//!
//! All three routes are owner-only. The token was never a secret from the
//! owner: their browser made it at setup, and the owner can move the coins
//! any time anyway.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::OwnerAuth;
use crate::routes::{record_event, ApiError, HeirCodeSeal};
use crate::AppState;

/// Where a vault stands with the heir code, for the owner's dashboard.
///
/// - `upgrade`: locked with a kept claim token, an heir is chosen, and no
///   claim is underway. The owner can move it to a code.
/// - `unshared`: locked with a code the owner hasn't confirmed handing over.
/// - `shared`: locked with a code the owner gave their heir.
/// - `None`: no heir key here (Door B, heir chosen later, older CLI
///   vaults), or a claim is already underway.
pub(crate) fn heir_code_state(
    status: &str,
    token_kept: bool,
    heir_key_sealed: bool,
    has_code: bool,
    shared: bool,
) -> Option<&'static str> {
    if has_code {
        return Some(if shared { "shared" } else { "unshared" });
    }
    if token_kept && heir_key_sealed && !claim_underway(status) {
        return Some("upgrade");
    }
    None
}

/// Once the heir has (or may have) their link, the key they'll open must
/// not change under them.
fn claim_underway(status: &str) -> bool {
    matches!(status, "timelock_started" | "claiming" | "claimed")
}

pub(crate) async fn load_heir_code_state(
    db: &sqlx::SqlitePool,
    vault_id: &str,
) -> Result<Option<&'static str>, ApiError> {
    let row: Option<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT status, claim_token_at_rest_b64 IS NOT NULL, heir_xprv_sealed_ct_b64 IS NOT NULL, \
                heir_code_salt_b64 IS NOT NULL, heir_code_shared_at IS NOT NULL \
           FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(db)
    .await?;
    let (status, kept, sealed, code, shared) = row.ok_or(ApiError::NotFound)?;
    Ok(heir_code_state(
        &status,
        kept == 1,
        sealed == 1,
        code == 1,
        shared == 1,
    ))
}

async fn require_upgradable(db: &sqlx::SqlitePool, vault_id: &str) -> Result<(), ApiError> {
    match load_heir_code_state(db, vault_id).await? {
        Some("upgrade") => Ok(()),
        Some(_) => Err(ApiError::Conflict(
            "This vault already uses an heir code.".into(),
        )),
        None => Err(ApiError::Conflict(
            "This vault can't move to an heir code now.".into(),
        )),
    }
}

/// A video message, locked.
#[derive(Debug, Serialize, Deserialize)]
pub struct SealedVideo {
    pub video_ct_b64: String,
    pub video_nonce_b64: String,
}

/// What the owner's browser needs to re-lock: the kept token, the key
/// locked under it, and the video locked under it (if there is one).
#[derive(Debug, Serialize)]
pub struct HeirCodeUpgradeKit {
    pub claim_token_b64: String,
    pub heir_xprv_ct_b64: String,
    pub heir_xprv_nonce_b64: String,
    pub video: Option<SealedVideo>,
}

/// `GET /vaults/:id/heir-code/upgrade` (owner).
pub async fn get_upgrade_kit(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<HeirCodeUpgradeKit>, ApiError> {
    let id = auth.vault_id;
    require_upgradable(&state.db, &id).await?;
    let (at_rest, ct, nonce): (String, String, String) = sqlx::query_as(
        "SELECT claim_token_at_rest_b64, heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce \
           FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let video: Option<(String, String)> =
        sqlx::query_as("SELECT video_ct_b64, video_nonce_b64 FROM vault_videos WHERE vault_id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(HeirCodeUpgradeKit {
        claim_token_b64: crate::crypto::open_claim_token_at_rest(&id, &at_rest)?,
        heir_xprv_ct_b64: ct,
        heir_xprv_nonce_b64: nonce,
        video: video.map(|(video_ct_b64, video_nonce_b64)| SealedVideo {
            video_ct_b64,
            video_nonce_b64,
        }),
    }))
}

#[derive(Debug, Deserialize)]
pub struct HeirCodeUpgradeRequest {
    pub heir_xprv_ct_b64: String,
    pub heir_xprv_nonce_b64: String,
    pub heir_code: HeirCodeSeal,
    /// Required when the vault has a video: re-locked with the code's
    /// video key. The owner signature and digest stay as they were (they
    /// cover the clip itself, not how it's locked).
    #[serde(default)]
    pub video: Option<SealedVideo>,
}

/// `POST /vaults/:id/heir-code/upgrade` (owner). Swaps in the code-locked
/// key and video and forgets the claim token, in one transaction. Refused
/// once a claim is underway, or if the vault changed since the kit was
/// fetched.
pub async fn upgrade(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<HeirCodeUpgradeRequest>,
) -> Result<StatusCode, ApiError> {
    let id = auth.vault_id;
    req.heir_code.validate()?;
    for (name, v) in [
        ("heir_xprv_ct_b64", &req.heir_xprv_ct_b64),
        ("heir_xprv_nonce_b64", &req.heir_xprv_nonce_b64),
    ] {
        if v.trim().is_empty() || v.len() > 4096 {
            return Err(ApiError::Validation(format!(
                "{name} is missing or too long"
            )));
        }
    }
    require_upgradable(&state.db, &id).await?;

    let mut tx = state.db.begin().await?;
    let has_video: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_videos WHERE vault_id = ?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    match (has_video > 0, req.video.as_ref()) {
        (true, None) => {
            return Err(ApiError::Validation(
                "re-lock the video message too, or it can't be played".into(),
            ))
        }
        (false, Some(_)) => {
            return Err(ApiError::Validation(
                "this vault has no video message".into(),
            ))
        }
        _ => {}
    }

    let c = &req.heir_code;
    let updated = sqlx::query(
        r#"UPDATE vaults
              SET heir_xprv_sealed_ct_b64 = ?,
                  heir_xprv_sealed_nonce = ?,
                  heir_code_salt_b64 = ?,
                  heir_code_kdf_mem_kib = ?,
                  heir_code_kdf_iters = ?,
                  heir_code_owner_sealed_ct_b64 = ?,
                  heir_code_owner_sealed_nonce = ?,
                  heir_code_check_ct_b64 = ?,
                  heir_code_check_nonce = ?,
                  heir_code_shared_at = NULL,
                  claim_token_at_rest_b64 = NULL,
                  claim_token_hash = NULL,
                  claim_code_lookup = NULL,
                  claim_code_sealed = NULL,
                  claim_token_issued_at = NULL,
                  claim_token_used_at = NULL
            WHERE id = ?
              AND claim_token_at_rest_b64 IS NOT NULL
              AND heir_code_salt_b64 IS NULL
              AND status NOT IN ('timelock_started', 'claiming', 'claimed')"#,
    )
    .bind(&req.heir_xprv_ct_b64)
    .bind(&req.heir_xprv_nonce_b64)
    .bind(&c.salt_b64)
    .bind(c.kdf_mem_kib)
    .bind(c.kdf_iters)
    .bind(&c.owner_ct_b64)
    .bind(&c.owner_nonce_b64)
    .bind(&c.check_ct_b64)
    .bind(&c.check_nonce_b64)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::Conflict(
            "This vault changed while you were upgrading it. Try again.".into(),
        ));
    }
    if let Some(v) = req.video.as_ref() {
        sqlx::query(
            "UPDATE vault_videos SET video_ct_b64 = ?, video_nonce_b64 = ? WHERE vault_id = ?",
        )
        .bind(&v.video_ct_b64)
        .bind(&v.video_nonce_b64)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    record_event(&state.db, &id, "heir_code_upgraded", None).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /vaults/:id/heir-code/shared` (owner): "I gave them the code."
/// Stops the dashboard asking. Only for a vault with a code.
pub async fn mark_shared(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let updated = sqlx::query(
        "UPDATE vaults SET heir_code_shared_at = ? \
          WHERE id = ? AND heir_code_salt_b64 IS NOT NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(&auth.vault_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::Conflict("This vault has no heir code.".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dashboard_state_follows_the_vault() {
        // A kept token on a vault with an heir key: offer the upgrade...
        assert_eq!(
            heir_code_state("ok", true, true, false, false),
            Some("upgrade")
        );
        assert_eq!(
            heir_code_state("alarmed", true, true, false, false),
            Some("upgrade")
        );
        assert_eq!(
            heir_code_state("unfunded", true, true, false, false),
            Some("upgrade")
        );
        // ...but never under a claim that's underway.
        for s in ["timelock_started", "claiming", "claimed"] {
            assert_eq!(heir_code_state(s, true, true, false, false), None, "{s}");
        }
        // No heir key (Door B, heir chosen later): nothing to upgrade.
        assert_eq!(heir_code_state("ok", false, false, false, false), None);
        // A code: ask until the owner says they gave it.
        assert_eq!(
            heir_code_state("ok", false, true, true, false),
            Some("unshared")
        );
        assert_eq!(
            heir_code_state("ok", false, true, true, true),
            Some("shared")
        );
    }
}
