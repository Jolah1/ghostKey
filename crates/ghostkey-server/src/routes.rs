use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bitcoin::bip32::Fingerprint;
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
use crate::config::parse_rfc;
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
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    // ---- Per-route rate-limit budgets ----
    //
    // Four budgets, scaled by the cost / abuse profile of the route
    // each one wraps. All four key on the client IP (see
    // `rate_limit::client_key`); buckets refill continuously.
    //
    // Each budget's `(burst, refill_per_sec)` can be overridden per
    // deployment via `GHOSTKEY_RL_<NAME>_BURST` and
    // `GHOSTKEY_RL_<NAME>_PER_SEC` env vars (see DEPLOY.md). A bad
    // value falls back to the default; we don't refuse to boot.
    //
    //   ASSIST: hits the Anthropic Messages API on every accepted
    //   request, so each token costs real money. 3-token burst lets
    //   a user fire off "hi", then a follow-up, then a clarification
    //   without waiting; steady-state is one request every 5s.
    //
    //   CREATE: covers the two unauthenticated vault-creation paths
    //   (`/vaults`, `/vaults/from-xpub`). Vault creation is a couple
    //   of disk writes plus an HKDF and "should be rare" per the
    //   threat model in #25. 3-token burst absorbs genuine setup
    //   retries; steady-state ~3/min.
    //
    //   FIND: covers `/vaults/find` — the email→vault registry
    //   lookup used for cross-device recovery. A different abuse
    //   profile from creation (enumeration vs. flood) and a
    //   different legitimate-use shape (an owner searching for
    //   their vaults will reasonably issue several lookups in a
    //   row). Own bucket, larger budget: 30 burst, ~30/min.
    //
    //   CLAIM: covers the heir-claim flow (resolve, build-psbt,
    //   broadcast, heir-claim, sealed-heir, derivation-params). The
    //   token is 256 bits so brute force is infeasible — this
    //   limiter exists to cap the *cost* of an attacker probing
    //   with a known-good token (Esplora full-scan is expensive).
    //   20-token burst absorbs the heir's natural reload + sign +
    //   broadcast trio; steady-state ~1/3s.
    let assist_limiter =
        crate::rate_limit::Limiter::from_env("assist", "GHOSTKEY_RL_ASSIST", 3, 0.2);
    let create_limiter =
        crate::rate_limit::Limiter::from_env("create", "GHOSTKEY_RL_CREATE", 3, 1.0 / 20.0);
    let find_limiter = crate::rate_limit::Limiter::from_env("find", "GHOSTKEY_RL_FIND", 30, 0.5);
    let claim_limiter =
        crate::rate_limit::Limiter::from_env("claim", "GHOSTKEY_RL_CLAIM", 20, 1.0 / 3.0);
    // /events is hit on every landing-page section view. Generous
    // budget — 60 burst, 1/s steady — because a single visitor
    // emits ~7 events per page load and we don't want to lose
    // signal during a healthy traffic spike.
    let analytics_limiter =
        crate::rate_limit::Limiter::from_env("analytics", "GHOSTKEY_RL_ANALYTICS", 60, 1.0);

    // The four rate-limited surfaces, each a small sub-router that
    // we'll merge into the main one. Keeping them separate makes the
    // policy choice visible at the route definition site.
    let assist_routes: Router<Arc<AppState>> = Router::new()
        .route("/assist/chat", post(crate::assist::assist_chat))
        .layer(axum::middleware::from_fn_with_state(
            assist_limiter,
            crate::rate_limit::enforce,
        ));

    let create_routes: Router<Arc<AppState>> = Router::new()
        .route("/vaults", post(create_vault))
        .route("/vaults/from-xpub", post(create_vault_from_xpub))
        .layer(axum::middleware::from_fn_with_state(
            create_limiter,
            crate::rate_limit::enforce,
        ));

    let find_routes: Router<Arc<AppState>> = Router::new()
        .route("/vaults/find", post(find_vaults_by_email))
        .layer(axum::middleware::from_fn_with_state(
            find_limiter,
            crate::rate_limit::enforce,
        ));

    let analytics_routes: Router<Arc<AppState>> = Router::new()
        .route("/events", post(crate::analytics::track))
        .layer(axum::middleware::from_fn_with_state(
            analytics_limiter,
            crate::rate_limit::enforce,
        ));

    let claim_routes: Router<Arc<AppState>> = Router::new()
        .route("/claim/:token", get(resolve_claim))
        .route(
            "/claim/:token/sealed-heir",
            get(crate::psbt_routes::get_sealed_heir_xprv),
        )
        .route(
            "/claim/:token/heir-derivation-params",
            get(crate::psbt_routes::get_heir_derivation_params),
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
        .layer(axum::middleware::from_fn_with_state(
            claim_limiter,
            crate::rate_limit::enforce,
        ));

    // Routes whose owner-auth or one-tap token already gates abuse,
    // plus the always-open `/health` and the LNURL endpoints (capped
    // upstream by the Lightning provider's own minting limits).
    let open_routes: Router<Arc<AppState>> = Router::new()
        .route("/health", get(health))
        .route("/vaults", get(list_vaults))
        .route("/vaults/:id", get(get_vault).delete(delete_vault))
        .route("/vaults/:id/address", get(get_vault_address))
        .route(
            "/vaults/:id/balance",
            get(crate::psbt_routes::get_vault_balance),
        )
        .route("/vaults/:id/sealed-blobs", get(get_sealed_blobs))
        .route("/vaults/:id/seal-owner-token", post(seal_owner_token))
        .route("/vaults/:id/checkin", post(checkin))
        .route(
            "/vaults/:id/checkin-from-link/:token",
            post(checkin_from_link),
        )
        .route(
            "/vaults/:id/lightning-checkin/invoice",
            post(lightning_create_invoice),
        )
        .route(
            "/vaults/:id/lightning-checkin/status/:payment_hash",
            get(lightning_invoice_status),
        )
        // Static LNURL-pay endpoints. No auth — the vault UUID is the
        // access control (1-sat invoices are cheap; a stolen UUID lets
        // a stranger help the owner stay alive, which is harmless).
        // See lnurl.rs for the LUD-06 spec links.
        .route("/lnurlp/:vault_id", get(lnurlp_pay_request))
        .route("/lnurlp/:vault_id/cb", get(lnurlp_callback))
        .route("/lnurlp/:vault_id/panic", get(lnurlp_panic_pay_request))
        .route("/lnurlp/:vault_id/panic/cb", get(lnurlp_panic_callback))
        .route("/vaults/:id/events", get(list_events))
        .route("/vaults/:id/issue-claim", post(issue_claim));

    Router::new()
        .merge(open_routes)
        .merge(assist_routes)
        .merge(create_routes)
        .merge(find_routes)
        .merge(claim_routes)
        .merge(analytics_routes)
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
    /// Which Bitcoin network the web UI should pre-select for new
    /// vault creation. Mirrors the server's `GHOSTKEY_DEFAULT_NETWORK`
    /// env var (`testnet` when unset). Lets a single web bundle work
    /// against testnet, signet, and regtest servers — the alpha
    /// banner names this network, and the setup wizards POST it as
    /// `network` in the create-vault payload.
    default_network: &'static str,
    /// Whether the AI onboarding guide is reachable. True iff
    /// `ANTHROPIC_API_KEY` is configured. Lets the UI hide the chat
    /// affordance gracefully when the server can't proxy.
    assist_enabled: bool,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let assist_enabled = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        lightning_enabled: state.lightning.is_enabled(),
        demo_mode: crate::demo::demo_mode(),
        default_network: crate::config::default_network(),
        assist_enabled,
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
    /// Optional channel for the owner contact above. Same vocabulary
    /// as `heir_contact_channel`: `"email"` (default if omitted),
    /// `"sms"`, or `"whatsapp"`. The scheduler uses this when it
    /// fires an "you missed your check-in" notification.
    pub owner_contact_channel: Option<String>,
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
    /// When the heir will be eligible to claim, if the owner does
    /// not check in. Mirrors the `claim_eligible_at` column. The
    /// dashboard surfaces this as "X days until heir is notified".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_eligible_at: Option<DateTime<Utc>>,
    /// If a panic-stop is active, when the vault auto-unfreezes.
    /// `None` whenever `status != "frozen"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panic_frozen_until: Option<DateTime<Utc>>,
    /// LNURL-pay string for the check-in invoice. `None` when
    /// Lightning is disabled (the operator has not set
    /// `GHOSTKEY_API_BASE_URL` and/or has not configured the
    /// Breez sidecar).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lnurl_checkin: Option<String>,
    /// LNURL-pay string for the panic-stop invoice. Same null rules
    /// as `lnurl_checkin`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lnurl_panic: Option<String>,
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

/// Reject anything that isn't one of the channels the notifier
/// understands. Both heir_contact_channel and owner_contact_channel
/// share this vocabulary so the wire shape stays consistent and the
/// notifier can switch on a single column.
///
/// Returning `Err` is preferable to silently coercing — an unknown
/// channel almost always means the caller typo'd or invented a name
/// we don't deliver to yet; we'd rather fail loudly at creation
/// than enqueue a notification with `channel = "telegram"` that
/// the worker will then skip forever.
fn validate_contact_channel(field: &str, ch: Option<&str>) -> Result<(), ApiError> {
    if let Some(c) = ch {
        match c {
            "email" | "sms" | "whatsapp" => {}
            _ => {
                return Err(ApiError::Validation(format!(
                    "unknown {field} {c:?}; expected email, sms, or whatsapp"
                )));
            }
        }
    }
    Ok(())
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
    validate_contact_channel(
        "owner_contact_channel",
        req.owner_contact_channel.as_deref(),
    )?;
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
                claim_eligible_at: Some(claim_eligible),
                panic_frozen_until: None,
                lnurl_checkin: None,
                lnurl_panic: None,
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
    /// Optional channel for the owner contact above. Same vocabulary
    /// as `heir_contact_channel`: `"email"` (default if omitted),
    /// `"sms"`, or `"whatsapp"`. The scheduler uses this when it
    /// fires an "you missed your check-in" notification.
    pub owner_contact_channel: Option<String>,
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

    /// F2: heir has no Bitcoin wallet. When present, the server derives
    /// the heir's xpub deterministically from `heir_derivation.email`
    /// (which is also stored as the heir contact) and the master key.
    /// The `heir` field's xpub is ignored in that path — the browser
    /// can pass any placeholder.
    #[serde(default)]
    pub heir_derivation: Option<HeirDerivation>,

    /// F4: trusted contact for panic-stop. Optional. When present and
    /// the owner triggers panic-pay, this address receives an alert.
    pub trusted_contact: Option<String>,
    /// Channel for `trusted_contact`. Same vocabulary as `heir_contact_channel`.
    pub trusted_contact_channel: Option<String>,
}

/// Opt-in heir-derivation parameters (F2).
#[derive(Debug, Deserialize)]
pub struct HeirDerivation {
    /// The heir's email address. Lowercased + trimmed before use, and
    /// also stored as the heir contact (so the claim email reaches
    /// them through the existing scheduler). Required.
    pub email: String,
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

    // ---- Validate heir + owner contact channels ---------------------
    // The channel string is echoed back to the heir at claim time and
    // also winds up in tracing logs. We refuse anything that isn't one
    // of the recognised channels so an attacker (creation is currently
    // unauthenticated) can't stuff control characters into our logs.
    validate_contact_channel("heir_contact_channel", req.heir_contact_channel.as_deref())?;
    validate_contact_channel(
        "owner_contact_channel",
        req.owner_contact_channel.as_deref(),
    )?;
    validate_contact_channel(
        "trusted_contact_channel",
        req.trusted_contact_channel.as_deref(),
    )?;

    // ---- Resolve network ---------------------------------------------
    let network = crate::config::parse_network(&req.network)
        .map_err(|name| ApiError::Validation(format!("unknown network {name}")))?;
    crate::demo::ensure_demo_safe_for_network(&req.network).map_err(ApiError::Validation)?;
    let path = vault_account_path(network);

    // ---- Parse owner + heir xpubs ------------------------------------
    let (owner_fp, owner_xpub) =
        resolve_party("owner", &req.owner.xpub, req.owner.fingerprint.as_deref())?;

    // F2: when heir_derivation is opted into, the server derives the
    // heir's account xpub from (heir_email, vault_id, master_key) and
    // the user-supplied heir.xpub is ignored. The fingerprint is a
    // synthetic zero — heirs in this flow have no hardware wallet, so
    // there is no real BIP32 master to fingerprint. We allocate the
    // vault id earlier than the non-derived branch so the derivation
    // can consume it.
    //
    // The result is byte-for-byte reconstructible in the heir's browser
    // at claim time via `crypto/heirKey.ts`, which is the whole point
    // of the feature: an heir with nothing but an email gets a real
    // BIP86 key without setup ahead of time.
    let (id, heir_fp, heir_xpub, heir_derived) = if let Some(hd) = req.heir_derivation.as_ref() {
        let id = Uuid::new_v4().to_string();
        let email = hd.email.trim();
        if email.is_empty() {
            return Err(ApiError::Validation(
                "heir_derivation.email must be non-empty".into(),
            ));
        }
        let master = crate::crypto::master_key_bytes()?;
        // `network` is already resolved above; we just rebind here so the
        // block is self-contained for readers and the call to
        // `derive_heir_seed` lines up with the local variable name.
        let net = network;
        let (_entropy, derived_xpub) =
            ghostkey_core::keys::derive_heir_seed(email, &id, &master, net)
                .map_err(|e| ApiError::Validation(format!("heir_derivation: {e}")))?;
        (id, Fingerprint::default(), derived_xpub, true)
    } else {
        let (fp, xpub) = resolve_party("heir", &req.heir.xpub, req.heir.fingerprint.as_deref())?;
        (Uuid::new_v4().to_string(), fp, xpub, false)
    };

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
    // `id` was allocated above as part of resolving the heir xpub so
    // the F2 derivation can be bound to it. Reusing here.
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
    //
    // F2: when the heir is server-derived, the email used for derivation
    // is also the heir contact. The browser may still pass `heir_contact`
    // explicitly — we honour an explicit value when provided, otherwise
    // fall back to the derivation email so the scheduler can email the
    // claim link without needing a second field.
    let effective_heir_contact: Option<String> = req
        .heir_contact
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            req.heir_derivation
                .as_ref()
                .map(|hd| hd.email.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    let sealed: Option<SealedContact> = match effective_heir_contact.as_deref() {
        Some(pt) if !pt.is_empty() => Some(seal_for_vault(&id, pt.as_bytes())?),
        _ => None,
    };
    let ciphertext_b64 = sealed.as_ref().map(|s| s.ciphertext_b64.clone());
    let nonce_b64 = sealed.as_ref().map(|s| s.nonce_b64.clone());

    // F4: seal the trusted contact (panic-alert recipient) the same way.
    // This is the only contact who learns the owner triggered a panic;
    // we encrypt at rest so a compromised DB doesn't leak the
    // relationship.
    let trusted_sealed: Option<SealedContact> = match req.trusted_contact.as_deref() {
        Some(pt) if !pt.is_empty() => Some(seal_for_vault(&id, pt.as_bytes())?),
        _ => None,
    };
    let trusted_ct_b64 = trusted_sealed.as_ref().map(|s| s.ciphertext_b64.clone());
    let trusted_nn_b64 = trusted_sealed.as_ref().map(|s| s.nonce_b64.clone());
    let trusted_channel = req
        .trusted_contact_channel
        .clone()
        .or_else(|| trusted_sealed.as_ref().map(|_| "email".to_string()));

    // Seal the owner contact the same way. New as of 20260527: this
    // unlocks the scheduler's "you missed your check-in" email path.
    // We don't populate the legacy plaintext `owner_contact` column
    // for sealed rows; the scheduler reads from the sealed columns
    // first and only falls back to plaintext for legacy rows that
    // pre-date this migration.
    let owner_sealed: Option<SealedContact> = match req.owner_contact.as_deref() {
        Some(pt) if !pt.is_empty() => Some(seal_for_vault(&id, pt.as_bytes())?),
        _ => None,
    };
    let owner_ct_b64 = owner_sealed.as_ref().map(|s| s.ciphertext_b64.clone());
    let owner_nn_b64 = owner_sealed.as_ref().map(|s| s.nonce_b64.clone());
    // Default the channel to "email" when an address is supplied
    // without one. Today email is the only delivery rail, so this
    // matches behaviour; when SMS / WhatsApp arrive, defaulting will
    // need a deliberate decision but no migration.
    let owner_channel = req
        .owner_contact_channel
        .clone()
        .or_else(|| owner_sealed.as_ref().map(|_| "email".to_string()));

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
            owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel,
            claim_eligible_at,
            owner_token_hash,
            password_salt_b64, password_kdf_mem_kib, password_kdf_iters,
            owner_xprv_sealed_ct_b64, owner_xprv_sealed_nonce,
            owner_token_sealed_ct_b64, owner_token_sealed_nonce,
            heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce,
            owner_email_hash,
            claim_token_at_rest_b64, claim_token_hash, claim_token_issued_at,
            heir_derived,
            trusted_contact_ciphertext, trusted_contact_nonce, trusted_contact_channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ok',
                  ?, ?, ?, ?, ?,
                  ?, ?,
                  ?, ?, ?,
                  ?,
                  ?,
                  ?, ?, ?,
                  ?, ?,
                  ?, ?,
                  ?, ?,
                  ?,
                  ?, ?, ?,
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
    // Legacy plaintext owner_contact column: write NULL for sealed
    // rows, so we have a single source of truth per vault. Only the
    // legacy CLI route (`POST /vaults`) still populates this column.
    .bind(Option::<String>::None)
    .bind(&now_s)
    .bind(&next_s)
    .bind(&owner_ext)
    .bind(&owner_int)
    .bind(&heir_ext)
    .bind(&heir_int)
    .bind(&req.heir_contact_channel)
    .bind(&ciphertext_b64)
    .bind(&nonce_b64)
    .bind(&owner_ct_b64)
    .bind(&owner_nn_b64)
    .bind(&owner_channel)
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
    .bind(if heir_derived { 1_i64 } else { 0_i64 })
    .bind(&trusted_ct_b64)
    .bind(&trusted_nn_b64)
    .bind(&trusted_channel)
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
                claim_eligible_at: Some(claim_eligible),
                panic_frozen_until: None,
                lnurl_checkin: None,
                lnurl_panic: None,
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
            Option<String>, // claim_eligible_at
            Option<String>, // panic_frozen_until
        ),
    >(
        r#"SELECT id, label, network, timelock_blocks,
                  checkin_period_secs, grace_period_secs,
                  status, created_at, last_checkin_at, next_deadline_at,
                  claim_eligible_at, panic_frozen_until
           FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    // Build the LNURL pair only when both prerequisites hold: Lightning
    // is wired up (otherwise the QR is a footgun — the owner would scan
    // it and the callback would 503) AND the operator has set the public
    // base URL (otherwise we'd encode `None` and produce garbage).
    let (lnurl_checkin, lnurl_panic) = if state.lightning.is_enabled() {
        match crate::config::api_base_url() {
            Some(base) => (
                Some(crate::lnurl::encode(&format!("{base}/lnurlp/{id}"))),
                Some(crate::lnurl::encode(&format!("{base}/lnurlp/{id}/panic"))),
            ),
            None => (None, None),
        }
    } else {
        (None, None)
    };

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
        claim_eligible_at: row.10.as_deref().map(parse_rfc),
        panic_frozen_until: row.11.as_deref().map(parse_rfc),
        lnurl_checkin,
        lnurl_panic,
    }))
}

/// Owner-initiated vault deletion. Removes the server-side vault row
/// and its dependents (events, notifications, lightning_invoices) via
/// `ON DELETE CASCADE`. The owner's on-chain funds are unaffected —
/// they're spendable from the owner's xpub/seed, which the server
/// never held. Returns 204 on success; 404 if the vault has already
/// been removed.
async fn delete_vault(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let id = auth.vault_id;
    let res = sqlx::query("DELETE FROM vaults WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
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
    // Fetch the cadence + last_checkin so we can both recompute the
    // deadline and enforce once-per-period.
    let row = sqlx::query_as::<_, (i64, i64, Option<String>)>(
        "SELECT checkin_period_secs, grace_period_secs, last_checkin_at \
           FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let now = Utc::now();
    // Once-per-period guard: if the owner already checked in inside
    // the current cycle, refuse the duplicate so the deadline doesn't
    // keep getting pushed forward by repeated taps.
    if let Some(last_s) = row.2.as_deref() {
        if let Ok(last) = DateTime::parse_from_rfc3339(last_s) {
            let last_utc = last.with_timezone(&Utc);
            let next_open = last_utc + Duration::seconds(row.0);
            if now < next_open {
                return Err(ApiError::Conflict(format!(
                    "already checked in this period; next check-in opens at {}",
                    next_open.to_rfc3339()
                )));
            }
        }
    }
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
                  claim_token_used_at  = NULL,
                  pre_deadline_reminder_sent_at = NULL,
                  last_alarm_reminder_sent_at  = NULL,
                  alarm_reminder_count          = 0,
                  checkin_link_token_hash      = NULL,
                  checkin_link_token_issued_at = NULL,
                  checkin_link_token_used_at   = NULL
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

/* -------------------------------------------------------------------------- *
 *  POST /vaults/:id/checkin-from-link/:token                                 *
 *                                                                            *
 *  One-tap check-in from the link the scheduler embeds in pre-deadline       *
 *  reminders and alarm-fired owner emails. The link carries a fresh          *
 *  per-cycle bearer token; the server stores only its SHA-256 hash so a     *
 *  DB leak cannot impersonate the owner. The token is single-use AND        *
 *  single-cycle: consumed on first POST, AND cleared on every successful    *
 *  check-in (button, Lightning, or one-tap).                                *
 *                                                                            *
 *  Threat model: anyone who reads the owner's email can check in for that   *
 *  vault until the next cycle starts or the link is consumed. That's the    *
 *  same shape as the heir's claim link. We document the trade-off and       *
 *  rely on the per-cycle expiry to bound the blast radius of a leaked       *
 *  email.                                                                    *
 *                                                                            *
 *  No `OwnerAuth` extractor here: the token IS the auth. We index the row   *
 *  by `checkin_link_token_hash` (the migration adds the index), then        *
 *  constant-time-verify the presented token against the stored hash before  *
 *  doing anything else.                                                      *
 * -------------------------------------------------------------------------- */

async fn checkin_from_link(
    State(state): State<Arc<AppState>>,
    Path((id, token)): Path<(String, String)>,
) -> Result<Json<CheckinResponse>, ApiError> {
    let hash = hash_claim_token(&token);

    // Look up by hash AND vault id together. Two reasons:
    //   - matches the index `idx_vaults_checkin_link_token`,
    //   - refuses to authenticate a token that was minted for a
    //     different vault (defence in depth — a hash collision
    //     would be astronomical for a 256-bit token, but the cost
    //     of the extra predicate is one column compare).
    let row: Option<(
        Option<String>, // checkin_link_token_hash
        Option<String>, // checkin_link_token_used_at
        i64,            // checkin_period_secs
        i64,            // grace_period_secs
        Option<String>, // last_checkin_at
    )> = sqlx::query_as(
        r#"SELECT checkin_link_token_hash, checkin_link_token_used_at,
                  checkin_period_secs, grace_period_secs, last_checkin_at
             FROM vaults
            WHERE id = ?
              AND checkin_link_token_hash = ?"#,
    )
    .bind(&id)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    let (stored_hash, used_at, checkin_secs, grace_secs, last_checkin_at) =
        row.ok_or(ApiError::NotFound)?;
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !crypto::claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if used_at.is_some() {
        // Single-use: the owner (or someone with the email) has already
        // tapped this link. Don't silently re-check-in; tell the caller
        // so they can show "already used" rather than "success".
        return Err(ApiError::Conflict("check-in link already used".into()));
    }
    // Once-per-period guard mirrors the button check-in path.
    if let Some(last_s) = last_checkin_at.as_deref() {
        if let Ok(last) = DateTime::parse_from_rfc3339(last_s) {
            let last_utc = last.with_timezone(&Utc);
            let next_open = last_utc + Duration::seconds(checkin_secs);
            if Utc::now() < next_open {
                return Err(ApiError::Conflict(format!(
                    "already checked in this period; next check-in opens at {}",
                    next_open.to_rfc3339()
                )));
            }
        }
    }

    // Reset the vault state exactly the way `checkin` does, plus
    // mark the one-tap token used. Wrapped in a single transaction
    // so the marker write is atomic with the deadline reset; a
    // partial commit would let the link be tapped twice.
    let now = Utc::now();
    let next = now + Duration::seconds(checkin_secs + grace_secs);
    let claim_eligible = next + Duration::seconds(grace_secs);
    let now_s = now.to_rfc3339();
    let next_s = next.to_rfc3339();
    let claim_eligible_s = claim_eligible.to_rfc3339();

    let mut tx = state.db.begin().await?;
    let upd = sqlx::query(
        r#"UPDATE vaults
              SET last_checkin_at      = ?,
                  next_deadline_at     = ?,
                  status               = 'ok',
                  claim_eligible_at    = ?,
                  claim_token_hash     = NULL,
                  claim_token_issued_at = NULL,
                  claim_token_used_at  = NULL,
                  pre_deadline_reminder_sent_at = NULL,
                  last_alarm_reminder_sent_at  = NULL,
                  alarm_reminder_count          = 0,
                  -- single-use marker: write used_at first so a
                  -- racing second tap sees `used_at IS NOT NULL`
                  -- and gets a 409 above.
                  checkin_link_token_used_at = ?
            WHERE id = ?
              AND checkin_link_token_hash = ?
              AND checkin_link_token_used_at IS NULL"#,
    )
    .bind(&now_s)
    .bind(&next_s)
    .bind(&claim_eligible_s)
    .bind(&now_s)
    .bind(&id)
    .bind(&stored_hash)
    .execute(&mut *tx)
    .await?;
    if upd.rows_affected() == 0 {
        // Lost the race against another concurrent tap. Treat as
        // "already used" — the owner is checked in either way.
        return Err(ApiError::Conflict("check-in link already used".into()));
    }

    // Now that we've recorded the use, scrub the hash columns so the
    // link can't be tapped again even if `used_at` were somehow
    // cleared by an admin script. This mirrors the routes::checkin
    // behaviour of clearing the columns on every successful check-in.
    sqlx::query(
        r#"UPDATE vaults
              SET checkin_link_token_hash      = NULL,
                  checkin_link_token_issued_at = NULL,
                  checkin_link_token_used_at   = NULL
            WHERE id = ?"#,
    )
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    record_event(
        &state.db,
        &id,
        "checkin",
        Some(serde_json::json!({ "source": "one_tap_link" })),
    )
    .await?;

    tracing::info!(
        vault_id = %id,
        "one-tap check-in accepted; deadline reset"
    );

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

    let network = crate::config::parse_network(&network_str)
        .map_err(|name| ApiError::Validation(format!("stored vault has unknown network {name}")))?;

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

    // Refuse to mint a duplicate check-in invoice inside the current
    // period. Spec: at most one successful check-in per period. We
    // catch it at mint time so the owner doesn't pay sats that won't
    // count.
    let cad: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT checkin_period_secs, last_checkin_at FROM vaults WHERE id = ?")
            .bind(&auth.vault_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((period, Some(last_s))) = cad {
        if let Ok(last) = DateTime::parse_from_rfc3339(&last_s) {
            let next_open = last.with_timezone(&Utc) + Duration::seconds(period);
            if Utc::now() < next_open {
                return Err(ApiError::Conflict(format!(
                    "already checked in this period; next check-in opens at {}",
                    next_open.to_rfc3339()
                )));
            }
        }
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

    let rec = crate::lightning::insert_invoice(
        &state.db,
        &auth.vault_id,
        &invoice,
        crate::lightning::INVOICE_TYPE_CHECKIN,
    )
    .await?;

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
 *  LNURL-pay handlers (F1, F4)                                                *
 *                                                                            *
 *  Static per-vault URLs that wallets like Phoenix and BlueWallet hit when    *
 *  the owner scans the QR rendered in the dashboard. Two endpoints per       *
 *  vault: check-in (resets the deadline) and panic (freezes the vault).      *
 *                                                                            *
 *  No auth. The vault UUID IS the access control — a 1-sat payment can only  *
 *  ever help the owner stay alive (check-in) or freeze their own vault       *
 *  (panic). Both are favourable to the owner; neither leaks information to   *
 *  the payer.                                                                *
 *                                                                            *
 *  LNURL spec demands HTTP 200 with `{ status: "ERROR", reason: ... }` on    *
 *  protocol-level errors, never 4xx/5xx. We honour that strictly: every     *
 *  branch below returns an axum `Response` rather than `ApiError`.          *
 * -------------------------------------------------------------------------- */

async fn lnurlp_pay_request(
    State(state): State<Arc<AppState>>,
    Path(vault_id): Path<String>,
) -> axum::response::Response {
    lnurlp_pay_request_inner(state, vault_id, /*panic=*/ false).await
}

async fn lnurlp_panic_pay_request(
    State(state): State<Arc<AppState>>,
    Path(vault_id): Path<String>,
) -> axum::response::Response {
    lnurlp_pay_request_inner(state, vault_id, /*panic=*/ true).await
}

async fn lnurlp_pay_request_inner(
    state: Arc<AppState>,
    vault_id: String,
    is_panic: bool,
) -> axum::response::Response {
    if !state.lightning.is_enabled() {
        return lnurl_error("lightning disabled on this server");
    }
    let Some(base) = crate::config::api_base_url() else {
        return lnurl_error("server misconfigured (no GHOSTKEY_API_BASE_URL)");
    };

    // Confirm the vault row exists; an LNURL on a deleted vault should
    // fail clean rather than mint orphan invoices.
    let exists: Option<(String,)> = match sqlx::query_as("SELECT id FROM vaults WHERE id = ?")
        .bind(&vault_id)
        .fetch_optional(&state.db)
        .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!(vault_id = %vault_id, error = ?e, "lnurlp_pay_request db error");
            return lnurl_error("internal");
        }
    };
    if exists.is_none() {
        return lnurl_error("unknown vault");
    }

    let cb_path = if is_panic { "/panic/cb" } else { "/cb" };
    let segment = if is_panic { "/panic" } else { "" };
    let callback_url = format!("{base}/lnurlp/{vault_id}{segment}{cb_path}");
    let body = if is_panic {
        crate::lnurl::panic_pay_request_json(&callback_url)
    } else {
        crate::lnurl::pay_request_json(&callback_url)
    };
    lnurl_ok(body)
}

#[derive(Debug, Deserialize)]
struct LnurlCallbackParams {
    amount: Option<u64>,
}

async fn lnurlp_callback(
    State(state): State<Arc<AppState>>,
    Path(vault_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<LnurlCallbackParams>,
) -> axum::response::Response {
    lnurlp_callback_inner(state, vault_id, params, /*panic=*/ false).await
}

async fn lnurlp_panic_callback(
    State(state): State<Arc<AppState>>,
    Path(vault_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<LnurlCallbackParams>,
) -> axum::response::Response {
    lnurlp_callback_inner(state, vault_id, params, /*panic=*/ true).await
}

async fn lnurlp_callback_inner(
    state: Arc<AppState>,
    vault_id: String,
    params: LnurlCallbackParams,
    is_panic: bool,
) -> axum::response::Response {
    if !state.lightning.is_enabled() {
        return lnurl_error("lightning disabled on this server");
    }

    // LUD-06: amount is in millisats. Our pay_request pins both
    // min and max to 1000 msat, so anything else is a wallet bug.
    match params.amount {
        Some(1000) => {}
        Some(other) => return lnurl_error(&format!("amount must be 1000 msat, got {other}")),
        None => return lnurl_error("amount query parameter required"),
    }

    let invoice_type = if is_panic {
        crate::lightning::INVOICE_TYPE_PANIC
    } else {
        crate::lightning::INVOICE_TYPE_CHECKIN
    };

    // Reuse an existing pending invoice of the same type if there is
    // one. LUD-06 doesn't require this, but mints-per-scan churn is
    // wasteful and most wallets cache pay_response for a couple of
    // seconds anyway, so two back-to-back scans should observe the
    // same bolt11.
    let existing: Result<Option<(String,)>, sqlx::Error> = sqlx::query_as(
        r#"SELECT bolt11
             FROM lightning_invoices
            WHERE vault_id     = ?
              AND invoice_type = ?
              AND status       = 'pending'
              AND expires_at   > ?
            ORDER BY created_at DESC
            LIMIT 1"#,
    )
    .bind(&vault_id)
    .bind(invoice_type)
    .bind(chrono::Utc::now().to_rfc3339())
    .fetch_optional(&state.db)
    .await;
    match existing {
        Ok(Some((bolt11,))) => return lnurl_ok(crate::lnurl::pay_response_json(&bolt11)),
        Ok(None) => {}
        Err(e) => {
            tracing::error!(vault_id = %vault_id, error = ?e, "lnurlp_callback existing-invoice lookup failed");
            return lnurl_error("internal");
        }
    }

    let description = format!("ghostkey:{invoice_type}:{vault_id}");
    let invoice = match state
        .lightning
        .create_invoice(crate::lightning::HEARTBEAT_AMOUNT_SAT, &description)
        .await
    {
        Ok(inv) => inv,
        Err(e) => {
            tracing::error!(vault_id = %vault_id, error = ?e, "lnurlp_callback mint failed");
            return lnurl_error("provider failed to mint invoice");
        }
    };
    if let Err(e) =
        crate::lightning::insert_invoice(&state.db, &vault_id, &invoice, invoice_type).await
    {
        tracing::error!(vault_id = %vault_id, error = ?e, "lnurlp_callback insert failed");
        return lnurl_error("internal");
    }
    let _ = record_event(
        &state.db,
        &vault_id,
        "lightning_invoice_issued",
        Some(serde_json::json!({
            "payment_hash": invoice.payment_hash,
            "amount_sat":  invoice.amount_sat,
            "source":      "lnurl",
            "invoice_type": invoice_type,
        })),
    )
    .await;

    lnurl_ok(crate::lnurl::pay_response_json(&invoice.bolt11))
}

/// Build an HTTP 200 with an LNURL JSON body. Wallets reject anything
/// that isn't `application/json` regardless of the body shape, so the
/// header is mandatory.
fn lnurl_ok(json: String) -> axum::response::Response {
    use axum::http::header::CONTENT_TYPE;
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(json))
        .expect("constant headers")
}

fn lnurl_error(reason: &str) -> axum::response::Response {
    lnurl_ok(crate::lnurl::error_json(reason))
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
    use bitcoin::Network;

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
