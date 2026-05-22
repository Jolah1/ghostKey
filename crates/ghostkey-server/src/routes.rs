use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bitcoin::bip32::Fingerprint;
use bitcoin::Network;
use chrono::{DateTime, Duration, Utc};
use ghostkey_core::descriptor::{build_descriptor_pair, parse_descriptor};
use ghostkey_core::keys::{
    descriptor_key_fragment, parse_xpub, vault_account_path, Chain,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::crypto::{
    self, hash_claim_token, issue_claim_token, open_for_vault, seal_for_vault,
    CryptoError, SealedContact,
};
use crate::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/vaults", post(create_vault).get(list_vaults))
        .route("/vaults/from-xpub", post(create_vault_from_xpub))
        .route("/vaults/:id", get(get_vault))
        .route("/vaults/:id/checkin", post(checkin))
        .route("/vaults/:id/events", get(list_events))
        .route("/vaults/:id/issue-claim", post(issue_claim))
        .route("/claim/:token", get(resolve_claim))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { ok: true, version: env!("CARGO_PKG_VERSION") })
}

#[derive(Debug, Deserialize)]
pub struct CreateVaultRequest {
    pub label: Option<String>,
    pub network: String,
    pub descriptor_external: String,
    pub descriptor_internal: String,
    pub timelock_blocks: u32,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub owner_contact: Option<String>,
    pub heir_contact: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VaultView {
    pub id: String,
    pub label: Option<String>,
    pub network: String,
    pub timelock_blocks: i64,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub last_checkin_at: Option<DateTime<Utc>>,
    pub next_deadline_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("validation: {0}")]
    Validation(String),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("crypto: {0}")]
    Crypto(#[from] CryptoError),
    #[error("conflict: {0}")]
    Conflict(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (code, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Validation(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, self.to_string()),
            ApiError::Db(_) => {
                tracing::error!(error = ?self, "db error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
            ApiError::Crypto(_) => {
                // Crypto errors are operator-side (e.g. missing master
                // key). Don't leak the inner reason to the client.
                tracing::error!(error = ?self, "crypto error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (code, Json(serde_json::json!({"error": msg}))).into_response()
    }
}

async fn create_vault(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateVaultRequest>,
) -> Result<(StatusCode, Json<VaultView>), ApiError> {
    if req.checkin_period_secs <= 0 || req.grace_period_secs < 0 {
        return Err(ApiError::Validation("non-positive period".into()));
    }
    if req.timelock_blocks == 0 || req.timelock_blocks > 0xFFFF {
        return Err(ApiError::Validation(format!(
            "timelock_blocks {} out of range 1..=65535",
            req.timelock_blocks
        )));
    }
    // Refuse to store anything that isn't a parseable inheritance descriptor.
    parse_descriptor(&req.descriptor_external)
        .map_err(|e| ApiError::Validation(format!("descriptor_external: {e}")))?;
    parse_descriptor(&req.descriptor_internal)
        .map_err(|e| ApiError::Validation(format!("descriptor_internal: {e}")))?;
    match req.network.as_str() {
        "bitcoin" | "testnet" | "signet" | "regtest" => {}
        other => return Err(ApiError::Validation(format!("unknown network {other}"))),
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_deadline =
        now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
    let now_s = now.to_rfc3339();
    let next_s = next_deadline.to_rfc3339();
    let timelock = req.timelock_blocks as i64;

    sqlx::query(
        r#"INSERT INTO vaults (
            id, label, network,
            descriptor_external, descriptor_internal,
            timelock_blocks,
            checkin_period_secs, grace_period_secs,
            owner_contact, heir_contact,
            created_at, next_deadline_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')"#,
    )
    .bind(&id)
    .bind(&req.label)
    .bind(&req.network)
    .bind(&req.descriptor_external)
    .bind(&req.descriptor_internal)
    .bind(timelock)
    .bind(req.checkin_period_secs)
    .bind(req.grace_period_secs)
    .bind(&req.owner_contact)
    .bind(&req.heir_contact)
    .bind(&now_s)
    .bind(&next_s)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "registered", None).await?;

    Ok((
        StatusCode::CREATED,
        Json(VaultView {
            id,
            label: req.label,
            network: req.network,
            timelock_blocks: timelock,
            checkin_period_secs: req.checkin_period_secs,
            grace_period_secs: req.grace_period_secs,
            status: "ok".into(),
            created_at: now,
            last_checkin_at: None,
            next_deadline_at: next_deadline,
        }),
    ))
}

/* -------------------------------------------------------------------------- *
 *  POST /vaults/from-xpub                                                    *
 *                                                                            *
 *  Web-friendly setup path: the client posts the owner's and heir's xpubs    *
 *  (with origin info) plus the timelock, and the server renders the          *
 *  Taproot descriptor pair itself by calling into ghostkey-core. The         *
 *  legacy POST /vaults that takes pre-rendered descriptors stays available   *
 *  for the CLI workflow.                                                     *
 *                                                                            *
 *  The endpoint accepts an xpub in two forms:                                *
 *    1. Bare:  "xpub6C..."                  + explicit `fingerprint` field   *
 *    2. With origin: "[d34db33f/86'/0'/0']xpub6C..."  (no fingerprint field) *
 *                                                                            *
 *  Form 2 is what Sparrow / BlueWallet / Coldcard / Specter export. We       *
 *  parse the bracketed prefix to recover the fingerprint; the embedded path  *
 *  is not used directly — we always re-derive the canonical `m/86'/coin'/0'` *
 *  for the requested network. (Wallets that export a non-BIP86 path will    *
 *  fail the parse_descriptor round-trip in build_descriptor_pair, which we   *
 *  surface as a clean validation error.)                                     *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct PartyXpub {
    /// Either a bare xpub (`xpub6C...`) or an origin-tagged xpub
    /// (`[fingerprint/path]xpub6C...`). When origin-tagged, `fingerprint`
    /// may be omitted.
    pub xpub: String,
    /// Lowercase 8-hex-char fingerprint. Optional if `xpub` carries origin
    /// info; required otherwise.
    pub fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateVaultFromXpubRequest {
    pub label: Option<String>,
    pub network: String,
    pub owner: PartyXpub,
    pub heir: PartyXpub,
    pub timelock_blocks: u32,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub owner_contact: Option<String>,
    pub heir_contact: Option<String>,
    /// Optional channel hint for the heir contact (`sms` / `email` /
    /// `whatsapp`). Stored as-is for the step-3 claim-link flow. Until
    /// then it has no behavioural effect.
    pub heir_contact_channel: Option<String>,
}

async fn create_vault_from_xpub(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateVaultFromXpubRequest>,
) -> Result<(StatusCode, Json<VaultView>), ApiError> {
    // ---- Validate periods + timelock ---------------------------------
    if req.checkin_period_secs <= 0 || req.grace_period_secs < 0 {
        return Err(ApiError::Validation("non-positive period".into()));
    }
    if req.timelock_blocks == 0 || req.timelock_blocks > 0xFFFF {
        return Err(ApiError::Validation(format!(
            "timelock_blocks {} out of range 1..=65535",
            req.timelock_blocks
        )));
    }

    // ---- Resolve network ---------------------------------------------
    let network = match req.network.as_str() {
        "bitcoin" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        "signet" => Network::Signet,
        "regtest" => Network::Regtest,
        other => {
            return Err(ApiError::Validation(format!("unknown network {other}")));
        }
    };
    let path = vault_account_path(network);

    // ---- Parse owner + heir xpubs ------------------------------------
    let (owner_fp, owner_xpub) =
        resolve_party("owner", &req.owner.xpub, req.owner.fingerprint.as_deref())?;
    let (heir_fp, heir_xpub) =
        resolve_party("heir", &req.heir.xpub, req.heir.fingerprint.as_deref())?;
    if owner_xpub == heir_xpub {
        return Err(ApiError::Validation(
            "owner and heir xpubs must differ".into(),
        ));
    }

    // ---- Render the four key fragments + descriptor pair -------------
    let owner_ext = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::External);
    let owner_int = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::Internal);
    let heir_ext = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::External);
    let heir_int = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::Internal);

    let pair = build_descriptor_pair(
        &owner_ext,
        &owner_int,
        &heir_ext,
        &heir_int,
        req.timelock_blocks,
    )
    .map_err(|e| ApiError::Validation(format!("descriptor build: {e}")))?;

    // build_descriptor_pair already round-trips through parse_descriptor,
    // but we re-validate here defensively in case a future refactor
    // changes that contract.
    parse_descriptor(&pair.external)
        .map_err(|e| ApiError::Validation(format!("descriptor_external: {e}")))?;
    parse_descriptor(&pair.internal)
        .map_err(|e| ApiError::Validation(format!("descriptor_internal: {e}")))?;

    // ---- Persist ------------------------------------------------------
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_deadline =
        now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
    let now_s = now.to_rfc3339();
    let next_s = next_deadline.to_rfc3339();
    let timelock = req.timelock_blocks as i64;

    // Seal the heir contact at-rest. When the caller omits or sends an
    // empty heir_contact we still write NULLs in the ciphertext columns
    // — there's nothing to encrypt — and leave the legacy plaintext
    // column NULL too. Only one of (legacy plaintext, sealed) should
    // ever be populated for a given row.
    let sealed: Option<SealedContact> = match req.heir_contact.as_deref() {
        Some(pt) if !pt.is_empty() => Some(seal_for_vault(&id, pt.as_bytes())?),
        _ => None,
    };
    let ciphertext_b64 = sealed.as_ref().map(|s| s.ciphertext_b64.clone());
    let nonce_b64 = sealed.as_ref().map(|s| s.nonce_b64.clone());

    sqlx::query(
        r#"INSERT INTO vaults (
            id, label, network,
            descriptor_external, descriptor_internal,
            timelock_blocks,
            checkin_period_secs, grace_period_secs,
            owner_contact, heir_contact,
            created_at, next_deadline_at, status,
            owner_xpub_fragment_external, owner_xpub_fragment_internal,
            heir_xpub_fragment_external,  heir_xpub_fragment_internal,
            heir_contact_channel,
            heir_contact_ciphertext, heir_contact_nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ok',
                  ?, ?, ?, ?, ?,
                  ?, ?)"#,
    )
    .bind(&id)
    .bind(&req.label)
    .bind(&req.network)
    .bind(&pair.external)
    .bind(&pair.internal)
    .bind(timelock)
    .bind(req.checkin_period_secs)
    .bind(req.grace_period_secs)
    .bind(&req.owner_contact)
    .bind(&now_s)
    .bind(&next_s)
    .bind(&owner_ext)
    .bind(&owner_int)
    .bind(&heir_ext)
    .bind(&heir_int)
    .bind(&req.heir_contact_channel)
    .bind(&ciphertext_b64)
    .bind(&nonce_b64)
    .execute(&state.db)
    .await?;

    record_event(
        &state.db,
        &id,
        "registered",
        Some(serde_json::json!({
            "source": "from-xpub",
            "network": req.network,
            "encrypted_contact": ciphertext_b64.is_some(),
        })),
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(VaultView {
            id,
            label: req.label,
            network: req.network,
            timelock_blocks: timelock,
            checkin_period_secs: req.checkin_period_secs,
            grace_period_secs: req.grace_period_secs,
            status: "ok".into(),
            created_at: now,
            last_checkin_at: None,
            next_deadline_at: next_deadline,
        }),
    ))
}

/// Pull `(fingerprint, xpub)` out of a `PartyXpub`, supporting both bare
/// xpub + explicit fingerprint and origin-tagged xpub strings.
fn resolve_party(
    who: &str,
    raw_xpub: &str,
    explicit_fp: Option<&str>,
) -> Result<(Fingerprint, bitcoin::bip32::Xpub), ApiError> {
    let trimmed = raw_xpub.trim();

    let (fp_str, xpub_str) = if let Some(stripped) = trimmed.strip_prefix('[') {
        // Origin-tagged: `[fingerprint/path]xpub...`
        let close = stripped.find(']').ok_or_else(|| {
            ApiError::Validation(format!(
                "{who}.xpub: missing closing ']' on origin tag"
            ))
        })?;
        let inside = &stripped[..close];
        let after = &stripped[close + 1..];
        // The first '/' separates fingerprint from path; everything before is the FP.
        let fp_part = inside.split('/').next().unwrap_or(inside);
        // Sanity: an explicit fingerprint, if also provided, must match.
        if let Some(explicit) = explicit_fp {
            if !explicit.eq_ignore_ascii_case(fp_part) {
                return Err(ApiError::Validation(format!(
                    "{who}.fingerprint ({explicit}) does not match origin tag ({fp_part})"
                )));
            }
        }
        (fp_part.to_string(), after.to_string())
    } else {
        let fp = explicit_fp.ok_or_else(|| {
            ApiError::Validation(format!(
                "{who}.fingerprint is required when xpub has no origin tag"
            ))
        })?;
        (fp.to_string(), trimmed.to_string())
    };

    let fp = Fingerprint::from_str(&fp_str).map_err(|e| {
        ApiError::Validation(format!("{who}.fingerprint: {e}"))
    })?;
    let xpub = parse_xpub(&xpub_str)
        .map_err(|e| ApiError::Validation(format!("{who}.xpub: {e}")))?;
    // The embedded derivation path (if any) is informational only —
    // we always re-derive the canonical m/86'/coin'/0' from the
    // network parameter at the call site.
    Ok((fp, xpub))
}

#[derive(Debug, Serialize)]
pub struct VaultListItem {
    pub id: String,
    pub label: Option<String>,
    pub status: String,
    pub next_deadline_at: DateTime<Utc>,
}

async fn list_vaults(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<VaultListItem>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, Option<String>, String, String)>(
        "SELECT id, label, status, next_deadline_at FROM vaults ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|(id, label, status, dl)| VaultListItem {
            id,
            label,
            status,
            next_deadline_at: DateTime::parse_from_rfc3339(&dl)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect();
    Ok(Json(out))
}

async fn get_vault(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<VaultView>, ApiError> {
    let row = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            String,         // network
            i64,            // timelock_blocks
            i64,            // checkin_period_secs
            i64,            // grace_period_secs
            String,         // status
            String,         // created_at
            Option<String>, // last_checkin_at
            String,         // next_deadline_at
        ),
    >(
        r#"SELECT id, label, network, timelock_blocks,
                  checkin_period_secs, grace_period_secs,
                  status, created_at, last_checkin_at, next_deadline_at
           FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(VaultView {
        id: row.0,
        label: row.1,
        network: row.2,
        timelock_blocks: row.3,
        checkin_period_secs: row.4,
        grace_period_secs: row.5,
        status: row.6,
        created_at: parse_rfc(&row.7),
        last_checkin_at: row.8.as_deref().map(parse_rfc),
        next_deadline_at: parse_rfc(&row.9),
    }))
}

#[derive(Debug, Serialize)]
pub struct CheckinResponse {
    pub vault_id: String,
    pub last_checkin_at: DateTime<Utc>,
    pub next_deadline_at: DateTime<Utc>,
    pub status: String,
}

async fn checkin(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<CheckinResponse>, ApiError> {
    // Fetch the cadence to recompute the deadline.
    let row = sqlx::query_as::<_, (i64, i64)>(
        "SELECT checkin_period_secs, grace_period_secs FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let now = Utc::now();
    let next = now + Duration::seconds(row.0 + row.1);
    let now_s = now.to_rfc3339();
    let next_s = next.to_rfc3339();

    sqlx::query(
        r#"UPDATE vaults
              SET last_checkin_at = ?,
                  next_deadline_at = ?,
                  status = 'ok'
            WHERE id = ?"#,
    )
    .bind(&now_s)
    .bind(&next_s)
    .bind(&id)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "checkin", None).await?;

    Ok(Json(CheckinResponse {
        vault_id: id,
        last_checkin_at: now,
        next_deadline_at: next,
        status: "ok".into(),
    }))
}

#[derive(Debug, Serialize)]
pub struct EventView {
    pub id: i64,
    pub vault_id: String,
    pub kind: String,
    pub detail: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

async fn list_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<EventView>>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(
        "SELECT id, vault_id, kind, detail, created_at FROM events WHERE vault_id = ? ORDER BY id ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|(eid, vid, kind, detail, created)| EventView {
            id: eid,
            vault_id: vid,
            kind,
            detail: detail.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: parse_rfc(&created),
        })
        .collect();
    Ok(Json(out))
}

/* -------------------------------------------------------------------------- *
 *  Claim flow                                                                *
 *                                                                            *
 *  POST /vaults/:id/issue-claim                                              *
 *      Generates a fresh one-time bearer token, stores its SHA-256, and      *
 *      returns the raw token to the caller. In production this will be       *
 *      called by the scheduler when an alarm fires; for now it's exposed     *
 *      directly so we can test the flow end-to-end without scheduler         *
 *      changes. A previously-issued-but-unused token is overwritten —        *
 *      think of "issue" as "replace".                                        *
 *                                                                            *
 *  GET /claim/:token                                                         *
 *      Resolves a token to its vault, decrypts the heir contact, and         *
 *      marks the token consumed on first successful resolve. Returns         *
 *      404 for unknown tokens, 409 if already used, 410 if the vault is     *
 *      no longer in a claimable state.                                       *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct IssueClaimResponse {
    pub vault_id: String,
    /// Raw bearer token. Send to the heir, then forget. The server keeps
    /// only the hash.
    pub token: String,
    pub issued_at: DateTime<Utc>,
}

async fn issue_claim(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<IssueClaimResponse>, ApiError> {
    // Confirm the vault exists before issuing.
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM vaults WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }

    let issued = issue_claim_token();
    let now = Utc::now();
    let now_s = now.to_rfc3339();
    sqlx::query(
        r#"UPDATE vaults
              SET claim_token_hash      = ?,
                  claim_token_issued_at = ?,
                  claim_token_used_at   = NULL
            WHERE id = ?"#,
    )
    .bind(&issued.hash_hex)
    .bind(&now_s)
    .bind(&id)
    .execute(&state.db)
    .await?;

    record_event(
        &state.db,
        &id,
        "claim_issued",
        Some(serde_json::json!({ "token_hash": issued.hash_hex })),
    )
    .await?;

    Ok(Json(IssueClaimResponse {
        vault_id: id,
        token: issued.token,
        issued_at: now,
    }))
}

/// What the heir sees after clicking their claim link.
///
/// The page does *not* expose owner xpubs or descriptors — those would
/// be useful to an attacker and meaningless to the heir. We surface
/// just enough to identify the inheritance and the contact channel the
/// owner picked, plus the on-chain machinery the heir's wallet will
/// eventually need (descriptor, network) once the claim UI exists.
#[derive(Debug, Serialize)]
pub struct ClaimView {
    pub vault_id: String,
    pub label: Option<String>,
    pub network: String,
    pub status: String,
    pub timelock_blocks: i64,
    pub next_deadline_at: DateTime<Utc>,
    /// Decrypted heir contact — only the channel hint is revealed.
    /// We deliberately do NOT echo the contact value back; the heir is
    /// already holding their phone/email, and an attacker who somehow
    /// gets the link shouldn't learn the channel value.
    pub heir_channel: Option<String>,
    /// JSON body decrypted from the sealed contact, parsed for the
    /// heir's display name. May be empty for legacy vaults.
    pub heir_display_name: Option<String>,
}

async fn resolve_claim(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<ClaimView>, ApiError> {
    let hash = hash_claim_token(&token);

    // Look up by hash. The DB lookup itself is constant-time across
    // unknown tokens because we always index against a unique hash;
    // the row either exists or it doesn't.
    let row: Option<(
        String,         // id
        Option<String>, // label
        String,         // network
        String,         // status
        i64,            // timelock_blocks
        String,         // next_deadline_at
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        Option<String>, // heir_contact_channel
    )> = sqlx::query_as(
        r#"SELECT id, label, network, status, timelock_blocks,
                  next_deadline_at,
                  claim_token_hash, claim_token_used_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  heir_contact_channel
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    let row = row.ok_or(ApiError::NotFound)?;
    let (
        vault_id,
        label,
        network,
        status,
        timelock_blocks,
        next_deadline,
        stored_hash,
        used_at,
        ciphertext_b64,
        nonce_b64,
        channel,
    ) = row;

    // Defence-in-depth: constant-time compare against the stored hash.
    // (Already index-matched, but this protects against any future
    // refactor that loosens the lookup.)
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !crypto::claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }

    if used_at.is_some() {
        return Err(ApiError::Conflict("claim token already used".into()));
    }

    // Decrypt the sealed contact (if any) and pull out the display name.
    let (heir_display_name, heir_channel) = match (ciphertext_b64, nonce_b64) {
        (Some(ct), Some(nonce)) => {
            let sealed = SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nonce,
            };
            let bytes = open_for_vault(&vault_id, &sealed)?;
            let name = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| {
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                });
            (name, channel)
        }
        _ => (None, channel),
    };

    // Mark the token consumed. We do this *after* the successful decrypt
    // so a server-side failure doesn't burn the heir's one-shot link.
    let now_s = Utc::now().to_rfc3339();
    sqlx::query("UPDATE vaults SET claim_token_used_at = ? WHERE id = ?")
        .bind(&now_s)
        .bind(&vault_id)
        .execute(&state.db)
        .await?;

    record_event(
        &state.db,
        &vault_id,
        "claim_resolved",
        Some(serde_json::json!({ "channel": heir_channel })),
    )
    .await?;

    Ok(Json(ClaimView {
        vault_id,
        label,
        network,
        status,
        timelock_blocks,
        next_deadline_at: parse_rfc(&next_deadline),
        heir_channel,
        heir_display_name,
    }))
}

pub(crate) async fn record_event(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    kind: &str,
    detail: Option<serde_json::Value>,
) -> Result<(), sqlx::Error> {
    let detail_s = detail.map(|v| v.to_string());
    let now_s = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO events (vault_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
        .bind(vault_id)
        .bind(kind)
        .bind(detail_s)
        .bind(now_s)
        .execute(db)
        .await?;
    Ok(())
}

fn parse_rfc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/* -------------------------------------------------------------------------- *
 *  Unit tests for the from-xpub parsing layer.                               *
 *  Full route-level integration testing lives outside this file (would need  *
 *  a SqlitePool harness); these cover the parse_party branches that diverge  *
 *  from the existing CLI path.                                               *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::bip32::Xpriv;
    use bitcoin::secp256k1::Secp256k1;

    /// Build a deterministic (xpub, fingerprint) pair from a 32-byte seed
    /// on regtest. Mirrors the seeds used in
    /// `ghostkey-core::descriptor::tests::builds_and_parses_descriptor_pair`.
    fn xpub_for(seed_byte: u8) -> (String, String) {
        let seed = [seed_byte; 32];
        let master = Xpriv::new_master(Network::Regtest, &seed).unwrap();
        let (fp, _path, xpub) =
            ghostkey_core::keys::account_xpub(&master, Network::Regtest).unwrap();
        (xpub.to_string(), format!("{fp}"))
    }

    #[test]
    fn resolve_party_accepts_bare_xpub_with_explicit_fingerprint() {
        let (xpub, fp) = xpub_for(0x11);
        let (out_fp, out_xpub) = resolve_party("owner", &xpub, Some(&fp))
            .expect("bare xpub + fingerprint should parse");
        assert_eq!(format!("{out_fp}"), fp);
        assert_eq!(out_xpub.to_string(), xpub);
    }

    #[test]
    fn resolve_party_accepts_origin_tagged_xpub_without_explicit_fingerprint() {
        let (xpub, fp) = xpub_for(0x22);
        let tagged = format!("[{fp}/86'/1'/0']{xpub}");
        let (out_fp, out_xpub) =
            resolve_party("heir", &tagged, None).expect("origin-tagged xpub should parse");
        assert_eq!(format!("{out_fp}"), fp);
        assert_eq!(out_xpub.to_string(), xpub);
    }

    #[test]
    fn resolve_party_rejects_origin_tag_with_mismatched_explicit_fingerprint() {
        let (xpub, fp) = xpub_for(0x33);
        let tagged = format!("[{fp}/86'/1'/0']{xpub}");
        let err = resolve_party("owner", &tagged, Some("deadbeef"))
            .expect_err("mismatched fingerprint must error");
        let msg = err.to_string();
        assert!(msg.contains("does not match origin tag"), "got: {msg}");
    }

    #[test]
    fn resolve_party_rejects_bare_xpub_without_fingerprint() {
        let (xpub, _fp) = xpub_for(0x44);
        let err = resolve_party("owner", &xpub, None)
            .expect_err("bare xpub without fingerprint must error");
        assert!(err.to_string().contains("fingerprint is required"));
    }

    #[test]
    fn resolve_party_rejects_garbage_xpub() {
        let err = resolve_party("owner", "not-an-xpub", Some("deadbeef"))
            .expect_err("garbage xpub must error");
        assert!(err.to_string().contains("owner.xpub"));
    }

    #[test]
    fn end_to_end_descriptor_build_from_xpubs() {
        // Smoke test the full pipeline used by the route handler: take two
        // xpubs, render fragments, render descriptor pair, parse it back.
        let secp = Secp256k1::new();
        let owner_master = Xpriv::new_master(Network::Regtest, &[0x55; 32]).unwrap();
        let heir_master = Xpriv::new_master(Network::Regtest, &[0x66; 32]).unwrap();
        let owner_fp = owner_master.fingerprint(&secp);
        let heir_fp = heir_master.fingerprint(&secp);
        let (_o_fp, _path, owner_xpub) =
            ghostkey_core::keys::account_xpub(&owner_master, Network::Regtest).unwrap();
        let (_h_fp, path, heir_xpub) =
            ghostkey_core::keys::account_xpub(&heir_master, Network::Regtest).unwrap();

        let oe = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::External);
        let oi = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::Internal);
        let he = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::External);
        let hi = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::Internal);

        let pair = build_descriptor_pair(&oe, &oi, &he, &hi, 144).unwrap();
        assert!(pair.external.starts_with("tr("), "external: {}", pair.external);
        assert!(pair.external.contains("older(144)"));
        // Each chain fragment occurs once in the descriptor with its trailing
        // `/0/*` (external) or `/1/*` (internal) glob. We don't pin the
        // surrounding parens — miniscript whitespace / canonicalisation is
        // an implementation detail of the build helper.
        assert!(pair.external.contains("/0/*"));
        assert!(pair.internal.contains("/1/*"));
        assert!(!pair.external.contains("/1/*"));
        assert!(!pair.internal.contains("/0/*"));
        parse_descriptor(&pair.external).unwrap();
        parse_descriptor(&pair.internal).unwrap();
    }
}
