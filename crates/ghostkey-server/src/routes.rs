use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bitcoin::bip32::Fingerprint;
use bitcoin::Network;
use chrono::{DateTime, Duration, Utc};
use ghostkey_core::descriptor::{build_descriptor_pair, parse_descriptor};
use ghostkey_core::keys::{descriptor_key_fragment, parse_xpub, vault_account_path, Chain};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::Span;
use uuid::Uuid;

use crate::auth::{cors_allowed_origins, AdminAuth, OwnerAuth};
use crate::crypto::{
    self, hash_claim_token, issue_claim_token, issue_owner_token, open_for_vault, seal_for_vault,
    CryptoError, SealedContact,
};
use crate::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    // Build the CORS allowlist from env (or default to local dev
    // frontends). We tighten this from the previous Any/Any/Any
    // configuration so a hostile site can't drive the API from a
    // visitor's browser via XHR / fetch.
    let origins: Vec<axum::http::HeaderValue> = cors_allowed_origins()
        .into_iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Router::new()
        .route("/health", get(health))
        .route("/vaults", post(create_vault).get(list_vaults))
        .route("/vaults/from-xpub", post(create_vault_from_xpub))
        .route("/vaults/find", post(find_vaults_by_email))
        .route("/vaults/:id", get(get_vault))
        .route("/vaults/:id/address", get(get_vault_address))
        .route("/vaults/:id/sealed-blobs", get(get_sealed_blobs))
        .route("/vaults/:id/seal-owner-token", post(seal_owner_token))
        .route("/vaults/:id/checkin", post(checkin))
        .route(
            "/vaults/:id/lightning-checkin/invoice",
            post(lightning_create_invoice),
        )
        .route(
            "/vaults/:id/lightning-checkin/status/:payment_hash",
            get(lightning_invoice_status),
        )
        .route("/vaults/:id/events", get(list_events))
        .route("/vaults/:id/issue-claim", post(issue_claim))
        .route("/claim/:token", get(resolve_claim))
        .route(
            "/claim/:token/sealed-heir",
            get(crate::psbt_routes::get_sealed_heir_xprv),
        )
        .route(
            "/claim/:token/heir-claim",
            post(crate::psbt_routes::heir_claim),
        )
        .route(
            "/claim/:token/build-psbt",
            post(crate::psbt_routes::build_claim_psbt),
        )
        .route(
            "/claim/:token/broadcast",
            post(crate::psbt_routes::broadcast_claim),
        )
        .layer(TraceLayer::new_for_http().make_span_with(make_request_span))
        .layer(cors)
        .with_state(state)
}

/// Build a tracing span for an incoming request with the URI redacted
/// when it carries a bearer token in the path. A claim URL looks like
/// `GET /claim/<token>`; without this layer the raw token would appear
/// verbatim in every access log line, which defeats the point of only
/// storing the SHA-256 hash server-side. The redaction is conservative:
/// any path starting with `/claim/` is rewritten to `/claim/[REDACTED]`
/// before the URI ever reaches the span.
fn make_request_span(request: &axum::http::Request<axum::body::Body>) -> Span {
    let method = request.method();
    let raw_path = request.uri().path();
    let safe_path: &str = if raw_path.starts_with("/claim/") {
        "/claim/[REDACTED]"
    } else {
        raw_path
    };
    tracing::info_span!("http", method = %method, path = %safe_path)
}

#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
    /// Whether this server has a configured Lightning provider. The
    /// web client uses this to decide whether to show the "check in
    /// with Lightning" button next to the existing tap-to-checkin
    /// affordance. When false the button is hidden and only the
    /// regular HTTP check-in is offered.
    lightning_enabled: bool,
    /// Whether this server is running in demonstration mode. When
    /// true, the web client surfaces the seconds-scale cadence
    /// presets and a prominent "DEMO MODE" banner; vault creation
    /// accepts cadences as low as a few seconds; mainnet vault
    /// creation is disabled. See `crate::demo` for the full list of
    /// loosened invariants. Operators MUST NOT enable demo mode on a
    /// production server.
    demo_mode: bool,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        lightning_enabled: state.lightning.is_enabled(),
        demo_mode: crate::demo::demo_mode(),
    })
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

/// Response shape from a successful vault creation.
///
/// Carries everything `VaultView` does plus the freshly issued
/// `owner_token`. The raw token is returned exactly once here and
/// never re-emitted by any other route. The caller must capture it;
/// the server only stores the SHA-256 hash going forward.
#[derive(Debug, Serialize)]
pub struct CreatedVault {
    #[serde(flatten)]
    pub vault: VaultView,
    /// The bearer credential required on `Authorization: Bearer ...`
    /// for every authenticated route on this vault. Treat it like a
    /// password: store it in the same place you'd store a wallet
    /// recovery file. If you lose it, you lose the ability to
    /// check in or list events for this vault — though the on-chain
    /// inheritance is unaffected (the owner can still spend, the
    /// heir can still wait out the timelock).
    pub owner_token: String,
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
) -> Result<(StatusCode, Json<CreatedVault>), ApiError> {
    crate::demo::validate_periods(req.checkin_period_secs, req.grace_period_secs)
        .map_err(ApiError::Validation)?;
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
    crate::demo::ensure_demo_safe_for_network(&req.network).map_err(ApiError::Validation)?;

    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_deadline = now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
    let now_s = now.to_rfc3339();
    let next_s = next_deadline.to_rfc3339();
    let timelock = req.timelock_blocks as i64;
    let claim_eligible = next_deadline + Duration::seconds(req.grace_period_secs);
    let claim_eligible_s = claim_eligible.to_rfc3339();

    // Mint the owner token now so we can store the hash in the same
    // INSERT and return the raw value to the caller exactly once.
    let issued_owner = issue_owner_token();

    sqlx::query(
        r#"INSERT INTO vaults (
            id, label, network,
            descriptor_external, descriptor_internal,
            timelock_blocks,
            checkin_period_secs, grace_period_secs,
            owner_contact, heir_contact,
            created_at, next_deadline_at, status,
            claim_eligible_at,
            owner_token_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)"#,
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
    .bind(&claim_eligible_s)
    .bind(&issued_owner.hash_hex)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "registered", None).await?;

    Ok((
        StatusCode::CREATED,
        Json(CreatedVault {
            vault: VaultView {
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
            },
            owner_token: issued_owner.token,
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

    /// Sealed material from the in-browser keygen flow (optional).
    /// When present, the server treats this as a "password vault":
    /// the browser generated owner+heir xprvs, sealed them, and is
    /// shipping the ciphertexts here. The server stores them verbatim
    /// and never sees the plaintext xprvs during owner setup.
    ///
    /// All fields in `SealedSetup` are required together — partial
    /// payloads are rejected as a validation error.
    #[serde(default)]
    pub sealed: Option<SealedSetup>,
}

/// Sealed material the browser ships during the password-vault flow.
///
/// See `migrations/20260525000002_password_vault.sql` for the threat
/// model these blobs participate in. Briefly: the server cannot open
/// any of these blobs during the owner's lifetime, but it does hold
/// `claim_token_at_rest` once issued (so it can put the token in the
/// heir's notification when the trigger fires).
#[derive(Debug, Deserialize)]
pub struct SealedSetup {
    pub password_salt_b64: String,
    pub password_kdf_mem_kib: i64,
    pub password_kdf_iters: i64,

    pub owner_xprv_ct_b64: String,
    pub owner_xprv_nonce_b64: String,
    pub owner_token_ct_b64: String,
    pub owner_token_nonce_b64: String,

    pub heir_xprv_ct_b64: String,
    pub heir_xprv_nonce_b64: String,

    /// SHA-256 hex of the lower-cased, NFKC-normalised owner email.
    /// Used by `/vaults/find` for cross-device password recovery.
    pub owner_email_hash: String,

    /// Claim token used by the browser to derive the heir-xprv wrapping
    /// key. The server stores this verbatim so that when the trigger
    /// fires it can construct the heir's URL fragment. SHA-256 hash is
    /// also computed and stored as `claim_token_hash` for the
    /// `/claim/:token` resolver.
    pub claim_token_b64: String,
}

async fn create_vault_from_xpub(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateVaultFromXpubRequest>,
) -> Result<(StatusCode, Json<CreatedVault>), ApiError> {
    // ---- Validate periods + timelock ---------------------------------
    crate::demo::validate_periods(req.checkin_period_secs, req.grace_period_secs)
        .map_err(ApiError::Validation)?;
    if req.timelock_blocks == 0 || req.timelock_blocks > 0xFFFF {
        return Err(ApiError::Validation(format!(
            "timelock_blocks {} out of range 1..=65535",
            req.timelock_blocks
        )));
    }

    // ---- Validate heir contact channel -------------------------------
    // The channel string is echoed back to the heir at claim time and
    // also winds up in tracing logs. We refuse anything that isn't one
    // of the recognised channels so an attacker (creation is currently
    // unauthenticated) can't stuff control characters into our logs.
    if let Some(ref ch) = req.heir_contact_channel {
        match ch.as_str() {
            "email" | "sms" | "whatsapp" => {}
            _ => {
                return Err(ApiError::Validation(format!(
                    "unknown heir_contact_channel {ch:?}; expected email, sms, or whatsapp"
                )));
            }
        }
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
    crate::demo::ensure_demo_safe_for_network(&req.network).map_err(ApiError::Validation)?;
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
    let next_deadline = now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
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

    // When may the scheduler issue a claim token? We add one extra
    // grace window past `next_deadline_at` (which already includes
    // the first grace period). That gives the owner a real chance
    // to come back from the dead before we email the heir.
    let claim_eligible = next_deadline + Duration::seconds(req.grace_period_secs);
    let claim_eligible_s = claim_eligible.to_rfc3339();

    // Mint the owner token. The raw value is returned exactly once
    // in the response; only the hash hits the database.
    let issued_owner = issue_owner_token();

    // ---- Sealed-vault material (password flow only) ------------------
    //
    // When `req.sealed` is present the browser has already done all the
    // sensitive work: it generated owner+heir xprvs, sealed them with
    // the password (owner side) and with a fresh claim token (heir
    // side), and posted us only the ciphertexts. We store everything
    // verbatim and also derive `claim_token_hash` so the resolver path
    // already used by the heir UI continues to work unchanged.
    let (
        sealed_password_salt,
        sealed_password_mem,
        sealed_password_iters,
        sealed_owner_xprv_ct,
        sealed_owner_xprv_nonce,
        sealed_owner_token_ct,
        sealed_owner_token_nonce,
        sealed_heir_xprv_ct,
        sealed_heir_xprv_nonce,
        sealed_owner_email_hash,
        sealed_claim_token_at_rest,
        sealed_claim_token_hash,
        sealed_claim_token_issued_at,
    ) = if let Some(s) = req.sealed.as_ref() {
        // Light shape validation. We don't open the blobs (that needs
        // the password / claim token) but we do reject obviously bogus
        // sizes so a typo client doesn't poison the DB.
        if s.password_kdf_mem_kib < 1024 || s.password_kdf_iters < 1 {
            return Err(ApiError::Validation(
                "password KDF parameters out of range".into(),
            ));
        }
        if s.owner_email_hash.len() != 64
            || !s.owner_email_hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(ApiError::Validation(
                "owner_email_hash must be 64 hex characters".into(),
            ));
        }
        let token_hash = crypto::hash_claim_token(&s.claim_token_b64);
        (
            Some(s.password_salt_b64.clone()),
            Some(s.password_kdf_mem_kib),
            Some(s.password_kdf_iters),
            Some(s.owner_xprv_ct_b64.clone()),
            Some(s.owner_xprv_nonce_b64.clone()),
            Some(s.owner_token_ct_b64.clone()),
            Some(s.owner_token_nonce_b64.clone()),
            Some(s.heir_xprv_ct_b64.clone()),
            Some(s.heir_xprv_nonce_b64.clone()),
            Some(s.owner_email_hash.clone()),
            Some(s.claim_token_b64.clone()),
            Some(token_hash),
            Some(now_s.clone()),
        )
    } else {
        (
            None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
    };

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
            heir_contact_ciphertext, heir_contact_nonce,
            claim_eligible_at,
            owner_token_hash,
            password_salt_b64, password_kdf_mem_kib, password_kdf_iters,
            owner_xprv_sealed_ct_b64, owner_xprv_sealed_nonce,
            owner_token_sealed_ct_b64, owner_token_sealed_nonce,
            heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce,
            owner_email_hash,
            claim_token_at_rest_b64, claim_token_hash, claim_token_issued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ok',
                  ?, ?, ?, ?, ?,
                  ?, ?,
                  ?,
                  ?,
                  ?, ?, ?,
                  ?, ?,
                  ?, ?,
                  ?, ?,
                  ?,
                  ?, ?, ?)"#,
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
    .bind(&claim_eligible_s)
    .bind(&issued_owner.hash_hex)
    .bind(&sealed_password_salt)
    .bind(sealed_password_mem)
    .bind(sealed_password_iters)
    .bind(&sealed_owner_xprv_ct)
    .bind(&sealed_owner_xprv_nonce)
    .bind(&sealed_owner_token_ct)
    .bind(&sealed_owner_token_nonce)
    .bind(&sealed_heir_xprv_ct)
    .bind(&sealed_heir_xprv_nonce)
    .bind(&sealed_owner_email_hash)
    .bind(&sealed_claim_token_at_rest)
    .bind(&sealed_claim_token_hash)
    .bind(&sealed_claim_token_issued_at)
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
            "password_vault": req.sealed.is_some(),
        })),
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreatedVault {
            vault: VaultView {
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
            },
            owner_token: issued_owner.token,
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
            ApiError::Validation(format!("{who}.xpub: missing closing ']' on origin tag"))
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

    let fp = Fingerprint::from_str(&fp_str)
        .map_err(|e| ApiError::Validation(format!("{who}.fingerprint: {e}")))?;
    let xpub =
        parse_xpub(&xpub_str).map_err(|e| ApiError::Validation(format!("{who}.xpub: {e}")))?;
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
    _admin: AdminAuth,
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
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<VaultView>, ApiError> {
    let id = auth.vault_id;
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
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<CheckinResponse>, ApiError> {
    let id = auth.vault_id;
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
    // Reset the claim-eligibility gate too. If the owner missed the
    // previous window and was within an inch of having a token issued,
    // checking in now pushes the gate back into the future and clears
    // any stale claim_token_hash so a follow-on alarm starts fresh.
    let claim_eligible = next + Duration::seconds(row.1);
    let now_s = now.to_rfc3339();
    let next_s = next.to_rfc3339();
    let claim_eligible_s = claim_eligible.to_rfc3339();

    sqlx::query(
        r#"UPDATE vaults
              SET last_checkin_at      = ?,
                  next_deadline_at     = ?,
                  status               = 'ok',
                  claim_eligible_at    = ?,
                  claim_token_hash     = NULL,
                  claim_token_issued_at = NULL,
                  claim_token_used_at  = NULL
            WHERE id = ?"#,
    )
    .bind(&now_s)
    .bind(&next_s)
    .bind(&claim_eligible_s)
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
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<EventView>>, ApiError> {
    let id = auth.vault_id;
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
 *      Resolves a token to its vault and decrypts the heir contact for       *
 *      display. The token is NOT consumed on resolve — the heir typically    *
 *      revisits the page to copy a PSBT into their wallet and come back to   *
 *      paste the signed PSBT. Consumption happens on a successful            *
 *      `/claim/:token/broadcast` (see `psbt_routes`). Returns 404 for        *
 *      unknown tokens, 409 if the broadcast already happened, 410 if the    *
 *      vault is no longer in a claimable state.                              *
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
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<IssueClaimResponse>, ApiError> {
    let id = auth.vault_id;
    // Confirm the vault exists before issuing.
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM vaults WHERE id = ?")
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

    // We deliberately do NOT mark the token consumed here. The heir
    // needs to come back to this URL repeatedly during the claim flow
    // (to build a PSBT, then to broadcast a signed one). The token
    // becomes "used" only when /claim/:token/broadcast lands a tx on
    // the network; see psbt_routes::broadcast_claim.

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
 *  Cross-device owner recovery + funding address.                            *
 *                                                                            *
 *  These three endpoints together let an owner walk up to any browser,       *
 *  enter their email and password, and recover full control of their         *
 *  vault — including the bearer credential that authorises check-ins.        *
 *                                                                            *
 *    POST /vaults/find                                                       *
 *        Body: { owner_email_hash }                                          *
 *        Returns: [{ id, label, created_at, status }, …]                     *
 *                                                                            *
 *    GET /vaults/:id/sealed-blobs                                            *
 *        Returns the password-wrapped ciphertexts so the browser can         *
 *        unwrap them locally with the user's password. No auth — the         *
 *        blobs are useless without the password.                             *
 *                                                                            *
 *    GET /vaults/:id/address                                                 *
 *        Returns the next external vault address so the owner can fund       *
 *        the vault. Public information (the descriptor is server-side        *
 *        anyway); no auth.                                                   *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct FindVaultsRequest {
    pub owner_email_hash: String,
}

#[derive(Debug, Serialize)]
pub struct FoundVault {
    pub id: String,
    pub label: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub next_deadline_at: DateTime<Utc>,
}

async fn find_vaults_by_email(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FindVaultsRequest>,
) -> Result<Json<Vec<FoundVault>>, ApiError> {
    let hash = req.owner_email_hash.trim().to_lowercase();
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::Validation(
            "owner_email_hash must be 64 hex characters".into(),
        ));
    }
    let rows = sqlx::query_as::<_, (String, Option<String>, String, String, String)>(
        r#"SELECT id, label, status, created_at, next_deadline_at
             FROM vaults
            WHERE owner_email_hash = ?
            ORDER BY created_at DESC"#,
    )
    .bind(&hash)
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|(id, label, status, created, next)| FoundVault {
            id,
            label,
            status,
            created_at: parse_rfc(&created),
            next_deadline_at: parse_rfc(&next),
        })
        .collect();
    Ok(Json(out))
}

/// Sealed material returned to the owner's browser during cross-device
/// recovery. The browser unwraps everything locally with the user's
/// password; the server cannot.
#[derive(Debug, Serialize)]
pub struct SealedBlobsView {
    pub vault_id: String,
    pub password_salt_b64: String,
    pub password_kdf_mem_kib: i64,
    pub password_kdf_iters: i64,
    pub owner_xprv_ct_b64: String,
    pub owner_xprv_nonce_b64: String,
    pub owner_token_ct_b64: String,
    pub owner_token_nonce_b64: String,
    pub network: String,
    pub timelock_blocks: i64,
}

async fn get_sealed_blobs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SealedBlobsView>, ApiError> {
    type Row = (
        String,         // id
        Option<String>, // password_salt
        Option<i64>,    // mem
        Option<i64>,    // iters
        Option<String>, // owner_xprv_ct
        Option<String>, // owner_xprv_nonce
        Option<String>, // owner_token_ct
        Option<String>, // owner_token_nonce
        String,         // network
        i64,            // timelock
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, password_salt_b64, password_kdf_mem_kib, password_kdf_iters,
                  owner_xprv_sealed_ct_b64, owner_xprv_sealed_nonce,
                  owner_token_sealed_ct_b64, owner_token_sealed_nonce,
                  network, timelock_blocks
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;

    let (salt, mem, iters, ox_ct, ox_n, ot_ct, ot_n) =
        match (row.1, row.2, row.3, row.4, row.5, row.6, row.7) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f), Some(g)) => {
                (a, b, c, d, e, f, g)
            }
            _ => {
                return Err(ApiError::Validation(
                    "this vault was not created with a password; cross-device recovery unavailable"
                        .into(),
                ));
            }
        };

    Ok(Json(SealedBlobsView {
        vault_id: row.0,
        password_salt_b64: salt,
        password_kdf_mem_kib: mem,
        password_kdf_iters: iters,
        owner_xprv_ct_b64: ox_ct,
        owner_xprv_nonce_b64: ox_n,
        owner_token_ct_b64: ot_ct,
        owner_token_nonce_b64: ot_n,
        network: row.8,
        timelock_blocks: row.9,
    }))
}

/* -------------------------------------------------------------------------- *
 *  Re-seal the owner token.                                                  *
 *                                                                            *
 *  The password-vault setup flow has a chicken-and-egg: the browser wants    *
 *  to ship a sealed owner_token to the server *during* vault creation, but   *
 *  the server only mints the real owner_token in its create response. The    *
 *  browser solves this by shipping a placeholder ciphertext during creation  *
 *  and immediately calling this endpoint with the *real* owner-token         *
 *  ciphertext once it has it.                                                *
 *                                                                            *
 *  Authentication is the freshly-issued owner_token itself (Bearer). That    *
 *  proves the caller is the same browser that just received the token —     *
 *  no other party can ever overwrite the sealed value.                       *
 *                                                                            *
 *  Idempotent in spirit: callers can re-seal at any point in the vault's     *
 *  life (e.g. to rotate KDF params). We do not version the field; later     *
 *  writes simply replace.                                                    *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct SealOwnerTokenRequest {
    pub owner_token_ct_b64: String,
    pub owner_token_nonce_b64: String,
}

async fn seal_owner_token(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SealOwnerTokenRequest>,
) -> Result<StatusCode, ApiError> {
    // Light shape validation. We won't open the blob (that needs the
    // password the server doesn't have), but we do reject obviously
    // bogus payloads so a typo client doesn't poison the column.
    if req.owner_token_ct_b64.is_empty() || req.owner_token_nonce_b64.is_empty() {
        return Err(ApiError::Validation(
            "owner_token_ct_b64 and owner_token_nonce_b64 must be non-empty".into(),
        ));
    }
    // 24-byte XChaCha20-Poly1305 nonce, base64-encoded = 32 chars.
    if req.owner_token_nonce_b64.len() != 32 {
        return Err(ApiError::Validation(
            "owner_token_nonce_b64 must be 32 base64 chars (24 raw bytes)".into(),
        ));
    }

    // Only allow re-sealing on vaults that were created with the
    // password flow. Legacy vaults have all sealed_* columns NULL and
    // accepting a write here would leave the row in a half-sealed
    // state.
    let exists: Option<(Option<String>,)> =
        sqlx::query_as("SELECT password_salt_b64 FROM vaults WHERE id = ?")
            .bind(&auth.vault_id)
            .fetch_optional(&state.db)
            .await?;
    match exists {
        Some((Some(_),)) => {}
        Some((None,)) => {
            return Err(ApiError::Validation(
                "this vault was not created with a password; cannot seal owner_token".into(),
            ));
        }
        None => return Err(ApiError::NotFound),
    }

    sqlx::query(
        r#"UPDATE vaults
              SET owner_token_sealed_ct_b64 = ?,
                  owner_token_sealed_nonce  = ?
            WHERE id = ?"#,
    )
    .bind(&req.owner_token_ct_b64)
    .bind(&req.owner_token_nonce_b64)
    .bind(&auth.vault_id)
    .execute(&state.db)
    .await?;

    // No event recorded — re-sealing is a routine, expected step in
    // the setup flow and we don't want to pollute the timeline.

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
pub struct VaultAddressView {
    pub vault_id: String,
    pub network: String,
    /// The first external (receive) address derived from the vault
    /// descriptor. The owner can fund the vault by sending Bitcoin
    /// here from any wallet they have.
    pub address: String,
}

async fn get_vault_address(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<VaultAddressView>, ApiError> {
    type Row = (String, String, String, i64); // network, ext, int, timelock
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT network, descriptor_external, descriptor_internal, timelock_blocks
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (network_str, ext, int_, timelock) = row.ok_or(ApiError::NotFound)?;

    let network = match network_str.as_str() {
        "bitcoin" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        "signet" => Network::Signet,
        "regtest" => Network::Regtest,
        other => {
            return Err(ApiError::Validation(format!(
                "stored vault has unknown network {other}"
            )))
        }
    };

    // Build a watch-only wallet from the stored descriptors and reveal
    // address #0. Idempotent: the same vault always returns the same
    // first address.
    let vault_config = ghostkey_core::vault::VaultConfig {
        descriptor_external: ext,
        descriptor_internal: int_,
        timelock_blocks: timelock as u32,
        network,
        role: ghostkey_core::vault::VaultRole::Watchonly,
        label: None,
    };
    let vault = ghostkey_core::vault::Vault::from_config(vault_config)
        .map_err(|e| ApiError::Validation(format!("stored descriptors invalid: {e}")))?;
    let mut wallet = ghostkey_core::wallet::build_watch_only(&vault)
        .map_err(|e| ApiError::Validation(format!("watch-only wallet build failed: {e}")))?;
    let address = ghostkey_core::wallet::next_receive_address(&mut wallet).to_string();

    Ok(Json(VaultAddressView {
        vault_id: id,
        network: network_str,
        address,
    }))
}

/* -------------------------------------------------------------------------- *
 *  Lightning check-ins.                                                      *
 *                                                                            *
 *  Two routes, both scoped to a single vault:                                *
 *                                                                            *
 *    POST /vaults/:id/lightning-checkin/invoice                              *
 *        Owner-authenticated. Mints a 1-sat BOLT11 invoice through the      *
 *        configured LightningProvider, writes a `lightning_invoices` row,    *
 *        and returns the bolt11 + payment_hash + expiry to the browser.     *
 *                                                                            *
 *    GET  /vaults/:id/lightning-checkin/status/:payment_hash                 *
 *        Owner-authenticated. Returns the current status of a previously    *
 *        minted invoice. The browser polls this while showing the QR code   *
 *        and flips to "checked in!" when status becomes `paid`. The         *
 *        background poller (lightning::run_poller) also updates the row;    *
 *        this route just surfaces whatever is in the DB. If you need a       *
 *        live read from the provider on demand, prefer waiting for the      *
 *        next poller tick (default 3s) — that's what the UI does.           *
 *                                                                            *
 *  Both routes return 503 when no Lightning provider is configured. The      *
 *  UI uses the body field `lightning_enabled` on `GET /health` (added in    *
 *  a follow-up) to decide whether to surface the Lightning option at all.   *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct LightningInvoiceView {
    pub bolt11: String,
    pub payment_hash: String,
    pub amount_sat: u64,
    pub expires_at: DateTime<Utc>,
    pub status: String,
}

async fn lightning_create_invoice(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<LightningInvoiceView>, ApiError> {
    if !state.lightning.is_enabled() {
        return Err(ApiError::Validation(
            "lightning provider not configured on this server".into(),
        ));
    }

    let description = format!("ghostkey:checkin:{}", auth.vault_id);
    let invoice = state
        .lightning
        .create_invoice(crate::lightning::HEARTBEAT_AMOUNT_SAT, &description)
        .await
        .map_err(|e| match e {
            crate::lightning::LightningError::NotConfigured => {
                ApiError::Validation("lightning provider not configured".into())
            }
            crate::lightning::LightningError::InvalidAmount(m) => ApiError::Validation(m),
            crate::lightning::LightningError::Provider(m) => {
                tracing::error!(error = %m, "lightning provider failed to mint invoice");
                ApiError::Validation(format!("lightning provider error: {m}"))
            }
        })?;

    let rec = crate::lightning::insert_invoice(&state.db, &auth.vault_id, &invoice).await?;

    record_event(
        &state.db,
        &auth.vault_id,
        "lightning_invoice_issued",
        Some(serde_json::json!({
            "payment_hash": invoice.payment_hash,
            "amount_sat": invoice.amount_sat,
        })),
    )
    .await?;

    Ok(Json(LightningInvoiceView {
        bolt11: rec.bolt11,
        payment_hash: rec.payment_hash,
        amount_sat: rec.amount_sat as u64,
        expires_at: rec.expires_at,
        status: rec.status,
    }))
}

#[derive(Debug, Serialize)]
pub struct LightningInvoiceStatusView {
    pub payment_hash: String,
    pub status: String,
    pub paid_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
}

async fn lightning_invoice_status(
    State(state): State<Arc<AppState>>,
    Path((vault_id, payment_hash)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Result<Json<LightningInvoiceStatusView>, ApiError> {
    // Two-param route so we can't use the OwnerAuth extractor (it
    // assumes a single :id path param). Inline the same check.
    inline_owner_auth(&state, &vault_id, &headers).await?;

    let rec = crate::lightning::fetch_invoice_by_hash(&state.db, &payment_hash)
        .await?
        .ok_or(ApiError::NotFound)?;

    if rec.vault_id != vault_id {
        // Caller authenticated for vault A but is asking about an
        // invoice that belongs to vault B. Treat as 404 to avoid
        // leaking the cross-vault relationship.
        return Err(ApiError::NotFound);
    }

    Ok(Json(LightningInvoiceStatusView {
        payment_hash: rec.payment_hash,
        status: rec.status,
        paid_at: rec.paid_at,
        expires_at: rec.expires_at,
    }))
}

/// Inline equivalent of the `OwnerAuth` extractor for routes that
/// have more than one path parameter (axum's `Path<String>` extractor
/// can't be used in that case). Returns the same error types so the
/// HTTP responses are indistinguishable.
async fn inline_owner_auth(
    state: &Arc<AppState>,
    vault_id: &str,
    headers: &axum::http::HeaderMap,
) -> Result<(), ApiError> {
    use axum::http::header;

    if crate::auth::auth_disabled() {
        tracing::warn!(
            vault_id = %vault_id,
            "owner auth bypassed by GHOSTKEY_AUTH_DISABLED"
        );
        return Ok(());
    }

    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Validation("missing Authorization header".into()))?;
    let token = raw
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::Validation("Authorization must be Bearer ...".into()))?;

    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT owner_token_hash FROM vaults WHERE id = ?")
            .bind(vault_id)
            .fetch_optional(&state.db)
            .await?;
    let stored_hash = match row {
        Some((Some(h),)) => h,
        _ => return Err(ApiError::Validation("unauthorized".into())),
    };
    if !crate::crypto::owner_token_matches(token, &stored_hash) {
        return Err(ApiError::Validation("unauthorized".into()));
    }
    Ok(())
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
        let (out_fp, out_xpub) =
            resolve_party("owner", &xpub, Some(&fp)).expect("bare xpub + fingerprint should parse");
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
        assert!(
            pair.external.starts_with("tr("),
            "external: {}",
            pair.external
        );
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
