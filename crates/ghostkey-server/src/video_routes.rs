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
        return Err(ApiError::Validation("owner_sig_b64 must be non-empty".into()));
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
    let row: Option<(String, Option<i64>, String)> = sqlx::query_as(
        "SELECT mime, duration_ms, created_at FROM vault_videos WHERE vault_id = ?",
    )
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

#[derive(Debug, Serialize)]
pub struct VideoView {
    pub vault_id: String,
    pub video_ct_b64: String,
    pub video_nonce_b64: String,
    pub mime: String,
    pub duration_ms: Option<i64>,
    pub owner_sig_b64: String,
    pub signed_sha256_hex: String,
}

type VideoRow = (String, String, String, Option<i64>, String, String);

/// Heir-side: fetch the encrypted clip for playback. Gated on a valid,
/// unconsumed claim token (the same credential that unlocks the rest of
/// the claim). Returns 404 when the vault has no video.
pub async fn get_claim_video(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<VideoView>, ApiError> {
    let hash = hash_claim_token(&token);
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        r#"SELECT id, claim_token_hash FROM vaults WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let (vault_id, stored_hash) = row.ok_or(ApiError::NotFound)?;
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }

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
    }))
}
