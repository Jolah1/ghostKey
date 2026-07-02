//! Owner video message (proof-of-life / anti-scam). See #85.
//!
//! The owner optionally records a short clip while alive; the heir plays
//! it at claim time to confirm the claim is genuine. The server is a
//! dumb encrypted store: it never sees plaintext and never verifies the
//! clip — confidentiality comes from the client-side claim-token KEK,
//! integrity from the owner's signature which the heir's browser checks
//! against the owner xpub in the public descriptor.
//!
//! Endpoints:
//!   `POST   /vaults/:id/video`   (OwnerAuth) — store/replace the clip.
//!   `GET    /vaults/:id/video`   (OwnerAuth) — metadata only (has_video).
//!   `DELETE /vaults/:id/video`   (OwnerAuth) — remove it.
//!   `GET    /claim/:token/video` (claim token) — fetch ciphertext to play.
//!
//! Unlike the sealed heir xprv, the claim fetch is NOT behind the
//! claim-challenge window: the clip is a trust signal, not key material,
//! and a scam link carries a token that can never decrypt the real clip.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::OwnerAuth;
use crate::crypto::{claim_token_matches, hash_claim_token};
use crate::routes::ApiError;
use crate::AppState;

/// Hard cap on the stored ciphertext (base64 chars). ~14 MB of base64
/// is ~10 MB of raw video — far more than a 30s low-res webm needs,
/// while bounding what one row (and the Litestream WAL) has to carry.
const MAX_VIDEO_CT_B64: usize = 14 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct UploadVideoRequest {
    pub video_ct_b64: String,
    pub video_nonce_b64: String,
    pub mime: String,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    pub owner_sig_b64: String,
    pub signed_sha256_hex: String,
}

pub async fn upload_video(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadVideoRequest>,
) -> Result<StatusCode, ApiError> {
    if req.video_ct_b64.is_empty() || req.video_nonce_b64.is_empty() {
        return Err(ApiError::Validation(
            "video_ct_b64 and video_nonce_b64 must be non-empty".into(),
        ));
    }
    if req.video_ct_b64.len() > MAX_VIDEO_CT_B64 {
        return Err(ApiError::Validation("video too large".into()));
    }
    // 24-byte XChaCha20-Poly1305 nonce, base64-encoded = 32 chars.
    if req.video_nonce_b64.len() != 32 {
        return Err(ApiError::Validation(
            "video_nonce_b64 must be 32 base64 chars (24 raw bytes)".into(),
        ));
    }
    if req.owner_sig_b64.is_empty() {
        return Err(ApiError::Validation(
            "owner_sig_b64 must be non-empty".into(),
        ));
    }
    if req.signed_sha256_hex.len() != 64
        || !req.signed_sha256_hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(ApiError::Validation(
            "signed_sha256_hex must be 64 hex chars".into(),
        ));
    }
    if !req.mime.starts_with("video/") || req.mime.len() > 64 {
        return Err(ApiError::Validation("mime must be a video/* type".into()));
    }

    // OwnerAuth already proved the caller holds the owner token for this
    // vault id; confirm the vault still exists so we don't insert an
    // orphan row pointing at a deleted vault.
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM vaults WHERE id = ?")
        .bind(&auth.vault_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }

    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"INSERT INTO vault_videos
              (vault_id, video_ct_b64, video_nonce_b64, mime, duration_ms,
               owner_sig_b64, signed_sha256_hex, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(vault_id) DO UPDATE SET
               video_ct_b64      = excluded.video_ct_b64,
               video_nonce_b64   = excluded.video_nonce_b64,
               mime              = excluded.mime,
               duration_ms       = excluded.duration_ms,
               owner_sig_b64     = excluded.owner_sig_b64,
               signed_sha256_hex = excluded.signed_sha256_hex,
               created_at        = excluded.created_at"#,
    )
    .bind(&auth.vault_id)
    .bind(&req.video_ct_b64)
    .bind(&req.video_nonce_b64)
    .bind(&req.mime)
    .bind(req.duration_ms)
    .bind(&req.owner_sig_b64)
    .bind(&req.signed_sha256_hex)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_video(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM vault_videos WHERE vault_id = ?")
        .bind(&auth.vault_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
pub struct VideoStatusView {
    pub has_video: bool,
    pub mime: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: Option<String>,
}

/// Owner-side: does this vault have a video, and its metadata. Never
/// returns the ciphertext (the owner can't decrypt it anyway — it's
/// sealed under the claim-token KEK, not the password).
pub async fn get_video_status(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<VideoStatusView>, ApiError> {
    let row: Option<(String, Option<i64>, String)> =
        sqlx::query_as("SELECT mime, duration_ms, created_at FROM vault_videos WHERE vault_id = ?")
            .bind(&auth.vault_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(match row {
        Some((mime, duration_ms, created_at)) => VideoStatusView {
            has_video: true,
            mime: Some(mime),
            duration_ms,
            created_at: Some(created_at),
        },
        None => VideoStatusView {
            has_video: false,
            mime: None,
            duration_ms: None,
            created_at: None,
        },
    }))
}

/// The heir's claim token, released to the authenticated owner (#222).
#[derive(Debug, Serialize)]
pub struct ClaimTokenView {
    pub claim_token_b64: String,
}

/// Owner-side: return the heir's claim token so the owner's browser can
/// seal a (re-)recorded video message under the claim-token KEK for an
/// existing vault — the same sealing the setup flow performs when the
/// vault is first created.
///
/// Why releasing it to the owner is safe:
///   - OwnerAuth gates it: only the vault owner's bearer token works.
///   - The owner's browser *generated* this token at setup and handed
///     it to the server; it was never a secret from the owner.
///   - The owner spend path can drain the vault at any time, so the
///     token grants the owner no power they don't already have.
///
/// Door B vaults (heir holds their own key) and legacy CLI vaults store
/// no token at rest — those get 404, and the dashboard explains that
/// video messages aren't available there.
pub async fn get_claim_token(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ClaimTokenView>, ApiError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT claim_token_at_rest_b64 FROM vaults WHERE id = ?")
            .bind(&auth.vault_id)
            .fetch_optional(&state.db)
            .await?;
    let stored = row.and_then(|r| r.0).ok_or(ApiError::NotFound)?;
    let claim_token_b64 = crate::crypto::open_claim_token_at_rest(&auth.vault_id, &stored)?;
    Ok(Json(ClaimTokenView { claim_token_b64 }))
}

#[derive(Debug, Serialize)]
pub struct VideoView {
    pub vault_id: String,
    pub video_ct_b64: String,
    pub video_nonce_b64: String,
    pub mime: String,
    pub duration_ms: Option<i64>,
    pub owner_sig_b64: String,
    pub signed_sha256_hex: String,
    /// The vault owner's account xpub, extracted from the stored
    /// descriptor. The heir verifies `owner_sig_b64` against it before
    /// playing — a clip signed by any other key is shown as not
    /// authentic. Anchored to the same key that controls the coins.
    pub owner_xpub: String,
}

type VideoRow = (String, String, String, Option<i64>, String, String);

/// Pull the owner account xpub out of a vault descriptor. The owner key
/// is the first `pk(...)` in `tr(NUMS,or_d(pk([origin]XPUB/0/*),...))`;
/// the xpub runs from just after the `]` origin tag to the `/` chain
/// suffix.
fn owner_xpub_from_descriptor(desc: &str) -> Option<String> {
    let pk = desc.find("pk(")?;
    let after = &desc[pk + 3..];
    let rest = if let Some(stripped) = after.strip_prefix('[') {
        let close = stripped.find(']')? + 1;
        &stripped[close..]
    } else {
        after
    };
    let end = rest.find('/')?;
    let xpub = &rest[..end];
    if xpub.is_empty() {
        None
    } else {
        Some(xpub.to_string())
    }
}

/// Heir-side: fetch the encrypted clip for playback. Gated on a valid,
/// unconsumed claim token (the same credential that unlocks the rest of
/// the claim). Returns 404 when the vault has no video.
pub async fn get_claim_video(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<VideoView>, ApiError> {
    let hash = hash_claim_token(&token);
    let row: Option<(String, Option<String>, String)> = sqlx::query_as(
        r#"SELECT id, claim_token_hash, descriptor_external
             FROM vaults WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let (vault_id, stored_hash, descriptor_external) = row.ok_or(ApiError::NotFound)?;
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    let owner_xpub = owner_xpub_from_descriptor(&descriptor_external)
        .ok_or_else(|| ApiError::Validation("could not read owner key from descriptor".into()))?;

    let v: Option<VideoRow> = sqlx::query_as(
        r#"SELECT video_ct_b64, video_nonce_b64, mime, duration_ms,
                  owner_sig_b64, signed_sha256_hex
             FROM vault_videos WHERE vault_id = ?"#,
    )
    .bind(&vault_id)
    .fetch_optional(&state.db)
    .await?;
    let v = v.ok_or(ApiError::NotFound)?;
    Ok(Json(VideoView {
        vault_id,
        video_ct_b64: v.0,
        video_nonce_b64: v.1,
        mime: v.2,
        duration_ms: v.3,
        owner_sig_b64: v.4,
        signed_sha256_hex: v.5,
        owner_xpub,
    }))
}

#[cfg(test)]
mod tests {
    use super::owner_xpub_from_descriptor;

    #[test]
    fn extracts_owner_xpub_with_origin() {
        let d = "tr(50929b74,or_d(pk([6b3b6632/86'/0'/0']xpub6BhZnOwner/0/*),and_v(v:pk([00000000/86'/0'/0']xpub6DNGqHeir/1/*),older(4320))))";
        assert_eq!(
            owner_xpub_from_descriptor(d).as_deref(),
            Some("xpub6BhZnOwner"),
        );
    }

    #[test]
    fn none_when_no_pk() {
        assert!(owner_xpub_from_descriptor("tr(50929b74)").is_none());
    }
}

/* -------------------------------------------------------------------------- *
 *  HTTP-level tests for GET /vaults/:id/claim-token (#222)                   *
 *                                                                            *
 *  Same harness as auth.rs::http_tests: real router, in-memory SQLite with   *
 *  every migration applied, driven through tower::ServiceExt::oneshot. The   *
 *  endpoint releases key-gating material (the claim token seals the video    *
 *  KEK and the heir xprv), so the auth and absence cases matter as much as   *
 *  the happy path.                                                           *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod claim_token_http_tests {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use base64::Engine as _;
    use serde_json::Value;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    use crate::crypto::ensure_master_key_loaded;
    use crate::routes;

    async fn fresh_state() -> std::sync::Arc<crate::AppState> {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let _ = ensure_master_key_loaded();
        unsafe { std::env::remove_var("GHOSTKEY_AUTH_DISABLED") };

        let pool: SqlitePool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        std::sync::Arc::new(crate::AppState {
            db: pool,
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        })
    }

    /// Insert a vault with an owner token hash and (optionally) a claim
    /// token sealed at rest, mirroring what password-vault setup stores.
    async fn insert_vault(
        pool: &SqlitePool,
        id: &str,
        owner_token_hash: &str,
        claim_token_at_rest: Option<&str>,
    ) {
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                owner_token_hash, claim_token_at_rest_b64
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z',
                      '2099-01-01T00:00:00Z', 'ok',
                      '2099-01-02T00:00:00Z',
                      ?, ?)"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(owner_token_hash)
        .bind(claim_token_at_rest)
        .execute(pool)
        .await
        .expect("insert vault");
    }

    fn get_claim_token_req(vault_id: &str, bearer: Option<&str>) -> Request<Body> {
        let b = Request::builder()
            .method("GET")
            .uri(format!("/vaults/{vault_id}/claim-token"));
        let b = match bearer {
            Some(t) => b.header(header::AUTHORIZATION, format!("Bearer {t}")),
            None => b,
        };
        b.body(Body::empty()).expect("request")
    }

    #[tokio::test]
    async fn claim_token_without_auth_is_401() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        let sealed = crate::crypto::seal_claim_token_at_rest("vault-ct-a", "tok-a")
            .expect("seal claim token");
        insert_vault(&state.db, "vault-ct-a", &issued.hash_hex, Some(&sealed)).await;

        let resp = routes::router(state)
            .oneshot(get_claim_token_req("vault-ct-a", None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn claim_token_with_wrong_owner_token_is_401() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        let sealed = crate::crypto::seal_claim_token_at_rest("vault-ct-b", "tok-b")
            .expect("seal claim token");
        insert_vault(&state.db, "vault-ct-b", &issued.hash_hex, Some(&sealed)).await;

        let resp = routes::router(state)
            .oneshot(get_claim_token_req("vault-ct-b", Some("not-the-token")))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn claim_token_roundtrips_for_the_owner() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        let sealed = crate::crypto::seal_claim_token_at_rest("vault-ct-c", "raw-claim-token")
            .expect("seal claim token");
        insert_vault(&state.db, "vault-ct-c", &issued.hash_hex, Some(&sealed)).await;

        let resp = routes::router(state)
            .oneshot(get_claim_token_req("vault-ct-c", Some(&issued.token)))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .expect("body");
        let v: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(v["claim_token_b64"], "raw-claim-token");
    }

    #[tokio::test]
    async fn claim_token_missing_at_rest_is_404() {
        // Door B / legacy vaults store no claim token at rest; the
        // owner gets 404 and the UI explains video isn't available.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-ct-d", &issued.hash_hex, None).await;

        let resp = routes::router(state)
            .oneshot(get_claim_token_req("vault-ct-d", Some(&issued.token)))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
