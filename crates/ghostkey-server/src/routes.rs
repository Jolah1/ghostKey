use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bitcoin::bip32::Fingerprint;
use chrono::{DateTime, Duration, Utc};
use ghostkey_core::descriptor::{
    build_descriptor_pair, build_guardian_descriptor_pair, parse_descriptor,
};
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
        .route("/vaults/guardian", post(create_vault_guardian))
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

    // /events (aggregate analytics), /waitlist (early-access signups), and
    // /price (cached BTC/USD for fiat display) share the same posture —
    // public, unauthenticated, low-volume — so they ride the same per-IP
    // rate-limit bucket.
    let analytics_routes: Router<Arc<AppState>> = Router::new()
        .route("/events", post(crate::analytics::track))
        .route("/waitlist", post(crate::waitlist::join))
        .route("/price", get(crate::price::get_price))
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
            "/claim/:token/unlock-estimate",
            get(crate::psbt_routes::claim_unlock_estimate),
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
            "/claim/:token/sealed-guardian",
            get(crate::psbt_routes::get_sealed_guardian_xprv),
        )
        .route(
            "/claim/:token/guardian-claim",
            post(crate::psbt_routes::guardian_claim),
        )
        .route(
            "/claim/:token/build-psbt",
            post(crate::psbt_routes::build_claim_psbt),
        )
        .route(
            "/claim/:token/broadcast",
            post(crate::psbt_routes::broadcast_claim),
        )
        .route(
            "/claim/:token/video",
            get(crate::video_routes::get_claim_video),
        )
        .layer(axum::middleware::from_fn_with_state(
            claim_limiter,
            crate::rate_limit::enforce,
        ));

    // Owner video message (#85). The POST carries a multi-MB encrypted
    // clip, so this sub-router raises the body limit well above axum's
    // 2 MB default; it stays scoped here so no other route inherits it.
    let video_routes: Router<Arc<AppState>> = Router::new()
        .route(
            "/vaults/:id/video",
            post(crate::video_routes::upload_video)
                .get(crate::video_routes::get_video_status)
                .delete(crate::video_routes::delete_video),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024));

    // Routes whose owner-auth or one-tap token already gates abuse,
    // plus the always-open `/health` and the LNURL endpoints (capped
    // upstream by the Lightning provider's own minting limits).
    let open_routes: Router<Arc<AppState>> = Router::new()
        .route("/health", get(health))
        .route("/health/lightning", get(health_lightning))
        .route("/vaults", get(list_vaults))
        .route("/vaults/:id", get(get_vault).delete(delete_vault))
        .route("/vaults/:id/heir", get(get_vault_heir))
        .route("/vaults/:id/address", get(get_vault_address))
        .route(
            "/vaults/:id/balance",
            get(crate::psbt_routes::get_vault_balance),
        )
        .route("/vaults/:id/send", post(crate::psbt_routes::owner_send))
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
        // One-tap-link Lightning check-in: same mint/poll flow as above
        // but gated by the email link token instead of owner auth, so the
        // owner can pay the check-in straight from a reminder email.
        .route(
            "/vaults/:id/checkin-link/:token/lightning-invoice",
            post(lightning_create_invoice_from_link),
        )
        .route(
            "/vaults/:id/checkin-link/:token/lightning-status/:payment_hash",
            get(lightning_invoice_status_from_link),
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
        .route("/vaults/:id/issue-claim", post(issue_claim))
        .route(
            "/vaults/:id/push-subscriptions",
            post(push_subscribe).delete(push_unsubscribe),
        )
        // Token-gated like checkin-from-link: the emailed token IS
        // the credential, so the owner can confirm from any device.
        .route("/vaults/:id/verify-contact/:token", post(verify_contact))
        .route("/vaults/:id/resend-verification", post(resend_verification));

    Router::new()
        .merge(open_routes)
        .merge(assist_routes)
        .merge(create_routes)
        .merge(find_routes)
        .merge(claim_routes)
        .merge(video_routes)
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
    /// VAPID public key (base64url, uncompressed SEC1 point) when web
    /// push is configured, else null. The web client passes this as
    /// `applicationServerKey` to `pushManager.subscribe()` and hides
    /// the reminder opt-in entirely when null.
    push_public_key: Option<String>,

    /// Monitoring: RFC3339 time of the last successful scheduler tick,
    /// null if it has never ticked since boot.
    scheduler_last_tick_at: Option<String>,
    /// Seconds since the last scheduler tick, null if never.
    scheduler_age_secs: Option<i64>,
    /// False if the scheduler has never ticked or is stale (older than
    /// 3 ticks, floored at 120s). An external uptime check should alert
    /// on this: a process that is up but whose scheduler has stalled
    /// will never fire an alarm, so the inheritance trigger silently
    /// stops working. This is the failure we most need to surface.
    scheduler_healthy: bool,

    /// Monitoring: notifications that are due to send (status pending or
    /// retrying, scheduled time reached) but haven't yet. A small,
    /// transient number is normal; a number that only grows means the
    /// notifier worker is stuck and reminders / alarm / claim emails are
    /// not going out.
    notifications_due: i64,
    /// Age in seconds of the oldest due-but-unsent notification, null
    /// when there are none. The clearest "notifier is stuck" signal.
    notifications_oldest_due_secs: Option<i64>,
    /// Notifications that exhausted their retries and will never send.
    /// Non-zero warrants an operator look (bad address, dead SMTP creds).
    notifications_failed: i64,
    /// False when the oldest due notification has been waiting past the
    /// stuck threshold (15 min). Alert on this alongside
    /// `scheduler_healthy`: a stalled notifier silently stops contacting
    /// owners and heirs.
    notifier_healthy: bool,

    /// Monitoring: on-chain maturity scans gate heir contact (Fix A).
    /// When Esplora is unreachable these scans fail and heir contact
    /// silently pauses (the safe direction). False after several
    /// consecutive scan failures — on mainnet a persistently failing
    /// scan means no claim ever advances, so alert on this. True when
    /// healthy or simply idle (no vault waiting on a timelock).
    chain_scan_healthy: bool,
    /// Consecutive failed maturity scans (0 when healthy or idle).
    chain_scan_consecutive_failures: i64,
    /// Last maturity-scan error, null when the most recent scan (or no
    /// scan at all) succeeded.
    chain_scan_last_error: Option<String>,
    /// RFC3339 time of the last successful maturity scan, null if none
    /// has run since boot.
    chain_scan_last_ok_at: Option<String>,
}

/// A due notification older than this is treated as evidence the notifier
/// worker is stuck (retries already push `scheduled_at` out, so a due row
/// this old is not just normal backoff).
const NOTIFIER_STUCK_SECS: i64 = 15 * 60;

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let assist_enabled = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    // Effective scheduler tick, matching main.rs: demo mode forces it to
    // 1s, otherwise GHOSTKEY_TICK_SECS (default 30). We treat the
    // scheduler as stale once it's missed ~3 ticks, floored at 120s so a
    // production 30s tick doesn't flap on a brief GC/IO pause.
    let tick_secs: i64 = if crate::demo::demo_mode() {
        crate::demo::DEMO_SCHEDULER_TICK_SECS as i64
    } else {
        std::env::var("GHOSTKEY_TICK_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30)
    };
    let stale_after = (tick_secs * 3).max(120);

    let scheduler_last_tick_at: Option<String> =
        sqlx::query_scalar("SELECT last_tick_at FROM scheduler_heartbeat WHERE id = 1")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let scheduler_age_secs = scheduler_last_tick_at
        .as_deref()
        .map(|s| (Utc::now() - crate::config::parse_rfc(s)).num_seconds());
    let scheduler_healthy = scheduler_age_secs.is_some_and(|a| a >= 0 && a <= stale_after);

    // Notifier-queue health. A due notification is one that should have
    // been sent by now (pending/retrying with its scheduled time reached).
    // Best-effort: a query error must not fail the health probe.
    let now_iso = Utc::now().to_rfc3339();
    let (notifications_due, oldest_due_iso, notifications_failed): (i64, Option<String>, i64) =
        sqlx::query_as(
            r#"SELECT
                 COALESCE(SUM(CASE WHEN status IN ('pending','failed_retrying')
                                    AND scheduled_at <= ?1 THEN 1 ELSE 0 END), 0),
                 MIN(CASE WHEN status IN ('pending','failed_retrying')
                           AND scheduled_at <= ?1 THEN scheduled_at END),
                 COALESCE(SUM(CASE WHEN status = 'failed_permanent' THEN 1 ELSE 0 END), 0)
               FROM notifications"#,
        )
        .bind(&now_iso)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0, None, 0));
    let notifications_oldest_due_secs = oldest_due_iso
        .as_deref()
        .map(|s| (Utc::now() - crate::config::parse_rfc(s)).num_seconds());
    let notifier_healthy = notifications_oldest_due_secs.is_none_or(|a| a <= NOTIFIER_STUCK_SECS);

    // On-chain maturity-scan health (Fix A heir-contact gate).
    let scan = crate::scheduler::chain_scan_health_snapshot();
    let chain_scan_healthy =
        scan.consecutive_failures < crate::scheduler::CHAIN_SCAN_UNHEALTHY_THRESHOLD;

    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        lightning_enabled: state.lightning.is_enabled(),
        demo_mode: crate::demo::demo_mode(),
        default_network: crate::config::default_network(),
        assist_enabled,
        push_public_key: crate::push::VapidConfig::public_key_from_env(),
        scheduler_last_tick_at,
        scheduler_age_secs,
        scheduler_healthy,
        notifications_due,
        notifications_oldest_due_secs,
        notifications_failed,
        notifier_healthy,
        chain_scan_healthy,
        chain_scan_consecutive_failures: scan.consecutive_failures as i64,
        chain_scan_last_error: scan.last_err,
        chain_scan_last_ok_at: scan.last_ok_at.map(|t| t.to_rfc3339()),
    })
}

/// Ops-facing deep probe of the Lightning wire.
///
/// `GET /health` only tells you "the operator set the env vars."
/// `GET /health/lightning` actually issues the sidecar's `/v1/health`
/// and surfaces:
///   * `enabled` — the main app has a configured provider at all
///   * `ready` — the sidecar replied `ok: true, ready: true`
///   * `error` — the sidecar was unreachable or returned non-OK,
///     with a one-line excuse you can grep in logs
///
/// Cached in-provider for 5 seconds (see `HttpProvider::probe`),
/// so this endpoint can be curled tightly without DoSing the
/// sidecar. Always returns 200 — the JSON body is the signal.
#[derive(Debug, Serialize)]
struct LightningHealth {
    enabled: bool,
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn health_lightning(State(state): State<Arc<AppState>>) -> Json<LightningHealth> {
    if !state.lightning.is_enabled() {
        return Json(LightningHealth {
            enabled: false,
            ready: false,
            error: None,
        });
    }
    match state.lightning.probe().await {
        Ok(ready) => Json(LightningHealth {
            enabled: true,
            ready,
            error: None,
        }),
        Err(e) => Json(LightningHealth {
            enabled: true,
            ready: false,
            error: Some(e.to_string()),
        }),
    }
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
    /// Whether the owner's reminder email has been confirmed by
    /// tapping the verification link we sent at setup. `None` when
    /// the vault has no sealed owner email on file (legacy CLI rows,
    /// or non-email channels); the dashboard nags while this is
    /// `Some(false)`. Informational only — the scheduler delivers
    /// reminders to unverified addresses regardless.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_contact_verified: Option<bool>,
    /// The vault's descriptor pair (receive + change). Only populated
    /// on the owner-authenticated `GET /vaults/:id` — list/create
    /// responses leave them `None`. The dashboard embeds these in the
    /// downloadable independence proof so the owner can reconstruct
    /// the wallet without this server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_external: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_internal: Option<String>,
    /// Whether a trusted contact is on file. The dashboard's panic
    /// copy promises "your trusted contact will be alerted" — that
    /// promise must only render when it's true (issue #70). Only
    /// populated on owner-authenticated `GET /vaults/:id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_trusted_contact: Option<bool>,
    /// Rough wall-clock time the on-chain CSV timelock matures, derived
    /// from the cached maturity scan (the scheduler refreshes it; a
    /// dashboard read never triggers a scan). Lets the owner dashboard
    /// show "unlocks around <date>" while the heir is waiting to claim.
    /// RFC3339; absent when the vault has never been scanned, has no
    /// confirmed coin anchoring the timelock, or has already matured.
    /// Only populated on owner-authenticated `GET /vaults/:id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unlock_eta: Option<String>,
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
    /// F2 only: the vault secret the owner's browser HKDFs with the
    /// heir email to derive the heir's account key, so it can build the
    /// heir envelope (block A) at setup. `None` for vaults where the
    /// heir brought their own xpub. See the create handler for why this
    /// is no new exposure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_secret_hex: Option<String>,
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
    crate::demo::validate_timelock_blocks(req.timelock_blocks).map_err(ApiError::Validation)?;
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
                // Legacy CLI route stores the plaintext contact and
                // doesn't participate in email verification.
                owner_contact_verified: None,
                descriptor_external: None,
                descriptor_internal: None,
                has_trusted_contact: None,
                unlock_eta: None,
            },
            owner_token: issued_owner.token,
            vault_secret_hex: None,
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

    /// #98 Part 2 (item 3): a named, personal first contact. The owner's
    /// display name (renders as "Jane set this up for you") and a short
    /// note, both shown to the heir in the claim message. Sealed at rest
    /// as a JSON blob in `heir_intro_*`. Both optional.
    pub from_name: Option<String>,
    pub heir_note: Option<String>,
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

    /// The heir's sealed xprv. Absent for Door B vaults, where the heir
    /// holds their own key and the server stores nothing that can spend.
    /// When present, `claim_token_b64` must be present too (the xprv is
    /// sealed under it); when absent, so is the claim token.
    pub heir_xprv_ct_b64: Option<String>,
    pub heir_xprv_nonce_b64: Option<String>,

    /// SHA-256 hex of the lower-cased, NFKC-normalised owner email.
    /// Used by `/vaults/find` for cross-device password recovery.
    pub owner_email_hash: String,

    /// Claim token used by the browser to derive the heir-xprv wrapping
    /// key. The server stores this verbatim so that when the trigger
    /// fires it can construct the heir's URL fragment. SHA-256 hash is
    /// also computed and stored as `claim_token_hash` for the
    /// `/claim/:token` resolver. Absent for Door B vaults — there the
    /// scheduler mints a fresh claim token at trigger time, exactly like
    /// a legacy vault, since no heir secret is bound to it.
    pub claim_token_b64: Option<String>,
}

/// One *owner* per email — but an owner may have several heirs, each
/// its own vault row sharing the same `owner_email_hash` and the same
/// owner key. That's how a single owner adds heirs over time (and how
/// multi-heir setup creates several at once). So we no longer reject
/// every duplicate email; we reject only a vault whose owner *key*
/// differs from the ones already on file for this email — a genuine
/// collision (someone else's email, or the owner rotating keys) that
/// would confuse sign-in and dashboard grouping. A row with no owner
/// key fragment recorded is treated as a conflict, conservatively.
/// Claimed vaults don't count: their story is over, the email is free.
async fn reject_conflicting_owner_email(
    db: &sqlx::SqlitePool,
    owner_email_hash: &str,
    owner_xpub_fragment_external: &str,
) -> Result<(), ApiError> {
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM vaults \
          WHERE owner_email_hash = ? \
            AND status != 'claimed' \
            AND (owner_xpub_fragment_external IS NULL \
                 OR owner_xpub_fragment_external != ?) \
          LIMIT 1",
    )
    .bind(owner_email_hash)
    .bind(owner_xpub_fragment_external)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Err(ApiError::Conflict(
            "a vault already exists for this email under a different key. \
             Sign in to manage it instead"
                .into(),
        ));
    }
    Ok(())
}

async fn create_vault_from_xpub(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateVaultFromXpubRequest>,
) -> Result<(StatusCode, Json<CreatedVault>), ApiError> {
    // ---- Validate periods + timelock ---------------------------------
    crate::demo::validate_periods(req.checkin_period_secs, req.grace_period_secs)
        .map_err(ApiError::Validation)?;
    crate::demo::validate_timelock_blocks(req.timelock_blocks).map_err(ApiError::Validation)?;

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
    // `vault_secret_hex` is returned to the owner ONLY for heir-derived
    // (F2) vaults, so their browser can derive the heir's account key and
    // build the heir envelope (block A) at setup — the one moment that's
    // possible. It's no new exposure: the owner already controls the
    // funds via the owner branch, and the heir-claim flow already hands
    // the same secret to whoever holds a valid claim token.
    let (id, heir_fp, heir_xpub, heir_derived, vault_secret_hex) = if let Some(hd) =
        req.heir_derivation.as_ref()
    {
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
        let vault_secret = ghostkey_core::keys::compute_vault_secret(&id, &master)
            .map_err(|e| ApiError::Validation(format!("vault_secret: {e}")))?;
        (
            id,
            Fingerprint::default(),
            derived_xpub,
            true,
            Some(hex::encode(vault_secret)),
        )
    } else {
        let (fp, xpub) = resolve_party("heir", &req.heir.xpub, req.heir.fingerprint.as_deref())?;
        (Uuid::new_v4().to_string(), fp, xpub, false, None)
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

    // #98 Part 2 (item 3): seal the optional named/personal first
    // contact. Creation is unauthenticated and these land in an outgoing
    // email, so cap the lengths. We seal a JSON blob {from_name, note}
    // at rest, matching the contact-sealing pattern above.
    let intro_from_name = req
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let intro_note = req
        .heir_note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if intro_from_name.is_some_and(|s| s.chars().count() > 80) {
        return Err(ApiError::Validation("from_name too long (max 80)".into()));
    }
    if intro_note.is_some_and(|s| s.chars().count() > 500) {
        return Err(ApiError::Validation("heir_note too long (max 500)".into()));
    }
    let heir_intro_sealed: Option<SealedContact> =
        if intro_from_name.is_some() || intro_note.is_some() {
            let blob =
                serde_json::json!({ "from_name": intro_from_name, "note": intro_note }).to_string();
            Some(seal_for_vault(&id, blob.as_bytes())?)
        } else {
            None
        };
    let heir_intro_ct_b64 = heir_intro_sealed.as_ref().map(|s| s.ciphertext_b64.clone());
    let heir_intro_nn_b64 = heir_intro_sealed.as_ref().map(|s| s.nonce_b64.clone());

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
        // Heir sealed material and the claim token are coupled: the xprv
        // is sealed under the token. They must be all-present (Door A) or
        // all-absent (Door B). Reject a half-populated shape.
        let heir_present = s.heir_xprv_ct_b64.is_some() && s.heir_xprv_nonce_b64.is_some();
        if heir_present != s.claim_token_b64.is_some() {
            return Err(ApiError::Validation(
                "sealed heir xprv and claim token must be both present or both absent".into(),
            ));
        }
        // Door B: no heir secret, no at-rest claim token. The scheduler
        // mints a fresh token at trigger time (legacy path).
        //
        // Door A: we must keep the token at rest (the scheduler embeds it
        // in the heir's link once the owner is gone), but we seal it under
        // the per-vault AEAD instead of storing it verbatim, so a DB-only
        // dump doesn't leak the bearer credential. The hash stays plaintext
        // — it's a one-way digest used for the /claim/:token lookup.
        let (at_rest, token_hash, token_issued) = match s.claim_token_b64.as_ref() {
            Some(tok) => (
                Some(crypto::seal_claim_token_at_rest(&id, tok)?),
                Some(crypto::hash_claim_token(tok)),
                Some(now_s.clone()),
            ),
            None => (None, None, None),
        };
        (
            Some(s.password_salt_b64.clone()),
            Some(s.password_kdf_mem_kib),
            Some(s.password_kdf_iters),
            Some(s.owner_xprv_ct_b64.clone()),
            Some(s.owner_xprv_nonce_b64.clone()),
            Some(s.owner_token_ct_b64.clone()),
            Some(s.owner_token_nonce_b64.clone()),
            s.heir_xprv_ct_b64.clone(),
            s.heir_xprv_nonce_b64.clone(),
            Some(s.owner_email_hash.clone()),
            at_rest,
            token_hash,
            token_issued,
        )
    } else {
        (
            None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
    };

    if let Some(hash) = sealed_owner_email_hash.as_ref() {
        reject_conflicting_owner_email(&state.db, hash, &owner_ext).await?;
    }

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
            trusted_contact_ciphertext, trusted_contact_nonce, trusted_contact_channel,
            heir_intro_ciphertext, heir_intro_nonce
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
                  ?, ?, ?,
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
    .bind(&heir_intro_ct_b64)
    .bind(&heir_intro_nn_b64)
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

    // Kick off owner email verification: mint a token, store its
    // hash, and enqueue the confirmation email. Failure here must
    // not fail the creation — the vault is already live and the
    // dashboard's "send it again" button covers a lost first email.
    let has_owner_email = owner_sealed.is_some() && owner_channel.as_deref() == Some("email");
    if has_owner_email {
        if let Some(email) = req.owner_contact.as_deref() {
            if let Err(e) = send_contact_verification(&state, &id, email).await {
                tracing::warn!(
                    vault_id = %id,
                    error = ?e,
                    "could not enqueue owner contact verification email"
                );
            }
        }
    }

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
                owner_contact_verified: if has_owner_email { Some(false) } else { None },
                // Return the public descriptor pair so the setup browser
                // can build the heir envelope (block A) immediately,
                // without a second round-trip. Watch-only; no secrets.
                descriptor_external: Some(pair.external.clone()),
                descriptor_internal: Some(pair.internal.clone()),
                has_trusted_contact: None,
                unlock_eta: None,
            },
            owner_token: issued_owner.token,
            vault_secret_hex,
        }),
    ))
}

/* -------------------------------------------------------------------------- *
 *  POST /vaults/guardian  — guardian vaults for underage heirs (#81 P2)       *
 *                                                                            *
 *  Claim branch: heir AND (g1 OR g2) AND older(N). The heir reuses the        *
 *  existing inline sealed columns; the two guardians get rows in             *
 *  vault_guardian_keys. Every key is generated + sealed in the browser; the  *
 *  server stores only ciphertext (post-#124, no master-key derivation).      *
 * -------------------------------------------------------------------------- */

/// One guardian's xpub + browser-sealed key material.
#[derive(Debug, Deserialize)]
pub struct GuardianParty {
    /// Bare or origin-tagged xpub (the browser-generated guardian account key).
    pub xpub: String,
    pub fingerprint: Option<String>,
    /// The guardian's xprv, sealed under this guardian's claim token.
    pub xprv_ct_b64: String,
    pub xprv_nonce_b64: String,
    /// Claim token the xprv is sealed under; stored hashed + sealed-at-rest.
    pub claim_token_b64: String,
    /// Where this guardian's claim link is delivered, and on which channel.
    pub contact: Option<String>,
    pub contact_channel: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateGuardianVaultRequest {
    pub label: Option<String>,
    pub network: String,
    pub owner: PartyXpub,
    pub heir: PartyXpub,
    pub guardian1: GuardianParty,
    pub guardian2: GuardianParty,
    pub timelock_blocks: u32,
    /// Optional absolute unlock height (#81 P5). When set, the claim branch
    /// gains an `after(H)` CLTV so the heir + guardian cannot spend before
    /// block `H` (e.g. until a child reaches a chosen age), regardless of
    /// owner inactivity. The web computes this height from the owner's
    /// chosen unlock year. The owner branch is unaffected.
    #[serde(default)]
    pub unlock_height: Option<u32>,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub owner_contact: Option<String>,
    pub owner_contact_channel: Option<String>,
    pub heir_contact: Option<String>,
    pub heir_contact_channel: Option<String>,
    /// Owner + heir sealed material (password-vault flow). Required: a
    /// guardian vault is always browser-keygen, so the heir key is sealed
    /// here (Door B / self-xpub heir is not offered for guardian vaults).
    pub sealed: SealedSetup,
    pub from_name: Option<String>,
    pub heir_note: Option<String>,
}

async fn create_vault_guardian(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateGuardianVaultRequest>,
) -> Result<(StatusCode, Json<CreatedVault>), ApiError> {
    // ---- Validate periods + timelock (timelock enforces the 144 floor) ---
    crate::demo::validate_periods(req.checkin_period_secs, req.grace_period_secs)
        .map_err(ApiError::Validation)?;
    crate::demo::validate_timelock_blocks(req.timelock_blocks).map_err(ApiError::Validation)?;

    validate_contact_channel("heir_contact_channel", req.heir_contact_channel.as_deref())?;
    validate_contact_channel(
        "owner_contact_channel",
        req.owner_contact_channel.as_deref(),
    )?;
    validate_contact_channel(
        "guardian1.contact_channel",
        req.guardian1.contact_channel.as_deref(),
    )?;
    validate_contact_channel(
        "guardian2.contact_channel",
        req.guardian2.contact_channel.as_deref(),
    )?;

    let network = crate::config::parse_network(&req.network)
        .map_err(|name| ApiError::Validation(format!("unknown network {name}")))?;
    crate::demo::ensure_demo_safe_for_network(&req.network).map_err(ApiError::Validation)?;
    let path = vault_account_path(network);

    // ---- Resolve the four parties' xpubs -----------------------------
    let (owner_fp, owner_xpub) =
        resolve_party("owner", &req.owner.xpub, req.owner.fingerprint.as_deref())?;
    let (heir_fp, heir_xpub) =
        resolve_party("heir", &req.heir.xpub, req.heir.fingerprint.as_deref())?;
    let (g1_fp, g1_xpub) = resolve_party(
        "guardian1",
        &req.guardian1.xpub,
        req.guardian1.fingerprint.as_deref(),
    )?;
    let (g2_fp, g2_xpub) = resolve_party(
        "guardian2",
        &req.guardian2.xpub,
        req.guardian2.fingerprint.as_deref(),
    )?;

    // All four keys must be distinct — a shared key would collapse the
    // policy (e.g. heir == guardian would let the heir self-claim).
    let xpubs = [&owner_xpub, &heir_xpub, &g1_xpub, &g2_xpub];
    for i in 0..xpubs.len() {
        for j in (i + 1)..xpubs.len() {
            if xpubs[i] == xpubs[j] {
                return Err(ApiError::Validation(
                    "owner, heir, and both guardian keys must all differ".into(),
                ));
            }
        }
    }

    // ---- Build the guardian descriptor pair --------------------------
    let owner_ext = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::External);
    let owner_int = descriptor_key_fragment(owner_fp, &path, &owner_xpub, Chain::Internal);
    let heir_ext = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::External);
    let heir_int = descriptor_key_fragment(heir_fp, &path, &heir_xpub, Chain::Internal);
    let g1_ext = descriptor_key_fragment(g1_fp, &path, &g1_xpub, Chain::External);
    let g1_int = descriptor_key_fragment(g1_fp, &path, &g1_xpub, Chain::Internal);
    let g2_ext = descriptor_key_fragment(g2_fp, &path, &g2_xpub, Chain::External);
    let g2_int = descriptor_key_fragment(g2_fp, &path, &g2_xpub, Chain::Internal);

    let pair = build_guardian_descriptor_pair(
        &owner_ext,
        &owner_int,
        &heir_ext,
        &heir_int,
        &g1_ext,
        &g1_int,
        &g2_ext,
        &g2_int,
        req.timelock_blocks,
        req.unlock_height,
    )
    .map_err(|e| ApiError::Validation(format!("descriptor build: {e}")))?;

    // ---- Validate the sealed (heir + owner) material -----------------
    // Guardian vaults are always Door A: the heir's sealed xprv and its
    // claim token are mandatory (no self-xpub heir path here).
    let s = &req.sealed;
    if s.password_kdf_mem_kib < 1024 || s.password_kdf_iters < 1 {
        return Err(ApiError::Validation(
            "password KDF parameters out of range".into(),
        ));
    }
    if s.owner_email_hash.len() != 64 || !s.owner_email_hash.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(ApiError::Validation(
            "owner_email_hash must be 64 hex characters".into(),
        ));
    }
    let (heir_xprv_ct, heir_xprv_nonce, heir_token) = match (
        &s.heir_xprv_ct_b64,
        &s.heir_xprv_nonce_b64,
        &s.claim_token_b64,
    ) {
        (Some(ct), Some(nn), Some(tok)) => (ct.clone(), nn.clone(), tok.clone()),
        _ => {
            return Err(ApiError::Validation(
                "guardian vault requires a sealed heir xprv and its claim token".into(),
            ))
        }
    };

    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_deadline = now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
    let now_s = now.to_rfc3339();
    let next_s = next_deadline.to_rfc3339();
    let timelock = req.timelock_blocks as i64;
    let claim_eligible = next_deadline + Duration::seconds(req.grace_period_secs);
    let claim_eligible_s = claim_eligible.to_rfc3339();

    reject_conflicting_owner_email(&state.db, &s.owner_email_hash, &owner_ext).await?;

    // Heir claim token: sealed at rest + hashed (mirrors create_vault_from_xpub).
    let heir_at_rest = crypto::seal_claim_token_at_rest(&id, &heir_token)?;
    let heir_token_hash = crypto::hash_claim_token(&heir_token);

    // Seal contacts at rest.
    let seal_opt = |v: Option<&str>| -> Result<(Option<String>, Option<String>), ApiError> {
        match v.filter(|s| !s.is_empty()) {
            Some(pt) => {
                let sc = seal_for_vault(&id, pt.as_bytes())?;
                Ok((Some(sc.ciphertext_b64), Some(sc.nonce_b64)))
            }
            None => Ok((None, None)),
        }
    };
    let (heir_ct, heir_nn) = seal_opt(req.heir_contact.as_deref())?;
    let (owner_ct, owner_nn) = seal_opt(req.owner_contact.as_deref())?;
    let owner_channel = req
        .owner_contact_channel
        .clone()
        .or_else(|| owner_ct.as_ref().map(|_| "email".to_string()));

    // Personal opener for the heir's claim message (sealed at rest as JSON),
    // mirroring create_vault_from_xpub.
    let intro_from_name = req
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let intro_note = req
        .heir_note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if intro_from_name.is_some_and(|s| s.chars().count() > 80) {
        return Err(ApiError::Validation("from_name too long (max 80)".into()));
    }
    if intro_note.is_some_and(|s| s.chars().count() > 500) {
        return Err(ApiError::Validation("heir_note too long (max 500)".into()));
    }
    let (heir_intro_ct, heir_intro_nn) = if intro_from_name.is_some() || intro_note.is_some() {
        let blob =
            serde_json::json!({ "from_name": intro_from_name, "note": intro_note }).to_string();
        let sc = seal_for_vault(&id, blob.as_bytes())?;
        (Some(sc.ciphertext_b64), Some(sc.nonce_b64))
    } else {
        (None, None)
    };

    let issued_owner = issue_owner_token();

    // ---- Insert the vault row (heir inline, vault_kind='guardian') ---
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
            heir_intro_ciphertext, heir_intro_nonce,
            vault_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'ok',
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
                  0,
                  ?, ?,
                  'guardian')"#,
    )
    .bind(&id)
    .bind(&req.label)
    .bind(&req.network)
    .bind(&pair.external)
    .bind(&pair.internal)
    .bind(timelock)
    .bind(req.checkin_period_secs)
    .bind(req.grace_period_secs)
    .bind(&now_s)
    .bind(&next_s)
    .bind(&owner_ext)
    .bind(&owner_int)
    .bind(&heir_ext)
    .bind(&heir_int)
    .bind(&req.heir_contact_channel)
    .bind(&heir_ct)
    .bind(&heir_nn)
    .bind(&owner_ct)
    .bind(&owner_nn)
    .bind(&owner_channel)
    .bind(&claim_eligible_s)
    .bind(&issued_owner.hash_hex)
    .bind(&s.password_salt_b64)
    .bind(s.password_kdf_mem_kib)
    .bind(s.password_kdf_iters)
    .bind(&s.owner_xprv_ct_b64)
    .bind(&s.owner_xprv_nonce_b64)
    .bind(&s.owner_token_ct_b64)
    .bind(&s.owner_token_nonce_b64)
    .bind(&heir_xprv_ct)
    .bind(&heir_xprv_nonce)
    .bind(&s.owner_email_hash)
    .bind(&heir_at_rest)
    .bind(&heir_token_hash)
    .bind(&now_s)
    .bind(&heir_intro_ct)
    .bind(&heir_intro_nn)
    .execute(&state.db)
    .await?;

    // ---- Insert the two guardian rows --------------------------------
    for (slot, g, g_ext, g_int) in [
        (1_i64, &req.guardian1, &g1_ext, &g1_int),
        (2_i64, &req.guardian2, &g2_ext, &g2_int),
    ] {
        let at_rest = crypto::seal_claim_token_at_rest(&id, &g.claim_token_b64)?;
        let token_hash = crypto::hash_claim_token(&g.claim_token_b64);
        let (contact_ct, contact_nn) = seal_opt(g.contact.as_deref())?;
        let channel = g
            .contact_channel
            .clone()
            .or_else(|| contact_ct.as_ref().map(|_| "email".to_string()));
        sqlx::query(
            r#"INSERT INTO vault_guardian_keys (
                vault_id, slot,
                xprv_sealed_ct_b64, xprv_sealed_nonce,
                claim_token_at_rest_b64, claim_token_hash, claim_token_issued_at,
                contact_ciphertext, contact_nonce, contact_channel,
                xpub_fragment_external, xpub_fragment_internal,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(slot)
        .bind(&g.xprv_ct_b64)
        .bind(&g.xprv_nonce_b64)
        .bind(&at_rest)
        .bind(&token_hash)
        .bind(&now_s)
        .bind(&contact_ct)
        .bind(&contact_nn)
        .bind(&channel)
        .bind(g_ext)
        .bind(g_int)
        .bind(&now_s)
        .execute(&state.db)
        .await?;
    }

    record_event(
        &state.db,
        &id,
        "registered",
        Some(serde_json::json!({ "source": "guardian", "network": req.network })),
    )
    .await?;

    // Owner email verification (best-effort, mirrors from-xpub).
    let has_owner_email = owner_ct.is_some() && owner_channel.as_deref() == Some("email");
    if has_owner_email {
        if let Some(email) = req.owner_contact.as_deref() {
            if let Err(e) = send_contact_verification(&state, &id, email).await {
                tracing::warn!(vault_id = %id, error = ?e, "guardian: owner verification email");
            }
        }
    }

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
                owner_contact_verified: if has_owner_email { Some(false) } else { None },
                descriptor_external: Some(pair.external.clone()),
                descriptor_internal: Some(pair.internal.clone()),
                has_trusted_contact: None,
                unlock_eta: None,
            },
            owner_token: issued_owner.token,
            vault_secret_hex: None,
        }),
    ))
}

/// Mint a fresh verification token for `vault_id`, persist its hash,
/// and enqueue the confirmation email to `email`. Shared between
/// vault creation and the owner-requested resend route. Each call
/// invalidates any previously emailed link — last writer wins, which
/// is what "send it again" should mean.
async fn send_contact_verification(
    state: &AppState,
    vault_id: &str,
    email: &str,
) -> Result<(), ApiError> {
    let issued = issue_claim_token();
    let now_s = Utc::now().to_rfc3339();
    sqlx::query(
        r#"UPDATE vaults
              SET owner_contact_verify_token_hash = ?,
                  owner_contact_verify_sent_at    = ?
            WHERE id = ?"#,
    )
    .bind(&issued.hash_hex)
    .bind(&now_s)
    .bind(vault_id)
    .execute(&state.db)
    .await?;

    let base = crate::scheduler::public_base_url();
    let link = format!("{base}/#/verify-email/{vault_id}/{}", issued.token);
    let body = format!(
        "Hi,\n\n\
         This address was entered as the reminder email for a GhostKey \
         vault. GhostKey will remind you here before each check-in is \
         due.\n\n\
         Tap once to confirm reminders can reach you:\n\n\
         {link}\n\n\
         This link works for 7 days. If it expires, open your dashboard \
         and resend.\n\n\
         If you didn't set up a GhostKey vault, you can ignore this \
         email. Nothing is linked to your address until you tap.\n\n\
         From GhostKey"
    );
    crate::notifier::enqueue(
        &state.db,
        vault_id,
        crate::notifier::NotificationKind::ContactVerification,
        crate::notifier::Channel::Email,
        email,
        "Confirm your reminder email",
        &body,
    )
    .await
    .map_err(|e| ApiError::Validation(format!("could not enqueue verification email: {e}")))?;
    Ok(())
}

/* -------------------------------------------------------------------------- *
 *  Claim-challenge window                                                    *
 *                                                                            *
 *  The heir's claim link is a bearer credential: whoever holds it can        *
 *  sweep the vault. The challenge window is the defence against a           *
 *  compromised heir inbox: the FIRST resolve of a valid, unconsumed         *
 *  token stamps `claim_opened_at`, alerts the owner (with a one-tap         *
 *  check-in link — one tap cancels the whole claim) and the trusted         *
 *  contact, and every endpoint that hands out key material or moves         *
 *  funds stays locked until the window elapses. A live owner loses          *
 *  nothing; a dead one delays the heir by GHOSTKEY_CLAIM_CHALLENGE_SECS    *
 *  (default 48h, 0 disables).                                                *
 * -------------------------------------------------------------------------- */

/// Returns `Ok(None)` when the claim may proceed, `Ok(Some(t))` when
/// the window is still open until `t`. Stamps `claim_opened_at` and
/// fires the alerts on the first call for a claim cycle; alert
/// failures are logged, never surfaced — a broken SMTP config must
/// not brick the heir's claim.
pub(crate) async fn ensure_claim_challenge(
    state: &AppState,
    vault_id: &str,
) -> Result<Option<DateTime<Utc>>, ApiError> {
    let window = crate::config::claim_challenge_window_secs();
    if window == 0 {
        return Ok(None);
    }
    let now = Utc::now();

    let opened: Option<Option<String>> =
        sqlx::query_scalar("SELECT claim_opened_at FROM vaults WHERE id = ?")
            .bind(vault_id)
            .fetch_optional(&state.db)
            .await?;
    let opened = opened.ok_or(ApiError::NotFound)?;

    if let Some(opened_s) = opened.as_deref() {
        let available = parse_rfc(opened_s) + Duration::seconds(window);
        return Ok((now < available).then_some(available));
    }

    // First open of this claim cycle. CAS so two racing resolves
    // produce exactly one set of alerts.
    let stamped = sqlx::query(
        "UPDATE vaults SET claim_opened_at = ? WHERE id = ? AND claim_opened_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(vault_id)
    .execute(&state.db)
    .await?;

    let available = now + Duration::seconds(window);
    if stamped.rows_affected() == 1 {
        record_event(
            &state.db,
            vault_id,
            "claim_opened",
            Some(serde_json::json!({ "challenge_until": available.to_rfc3339() })),
        )
        .await?;
        if let Err(e) = notify_claim_opened(state, vault_id, available).await {
            tracing::warn!(
                vault_id = %vault_id,
                error = ?e,
                "claim-opened alerts could not be enqueued"
            );
        }
    }
    Ok(Some(available))
}

/// Alert the owner and the trusted contact that a claim has started.
/// Best-effort: a vault without contacts simply alerts nobody.
async fn notify_claim_opened(
    state: &AppState,
    vault_id: &str,
    available: DateTime<Utc>,
) -> anyhow::Result<()> {
    type Row = (
        Option<String>, // owner_contact_ciphertext
        Option<String>, // owner_contact_nonce
        Option<String>, // owner_contact_channel
        Option<String>, // trusted_contact_ciphertext
        Option<String>, // trusted_contact_nonce
        Option<String>, // trusted_contact_channel
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel, \
                trusted_contact_ciphertext, trusted_contact_nonce, trusted_contact_channel \
           FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((own_ct, own_nn, own_ch, tr_ct, tr_nn, tr_ch)) = row else {
        return Ok(());
    };

    let hours = (crate::config::claim_challenge_window_secs() + 3599) / 3600;
    let until = available.format("%B %-d, %Y at %H:%M UTC");
    let base = crate::scheduler::public_base_url();

    // Owner: the one-tap check-in link is the kill switch. If a live
    // unused token is outstanding we can't recover its raw value, so
    // fall back to the sign-in page — checking in there cancels the
    // claim just the same.
    if let Some(owner) = crate::notifier::parse_owner_contact(
        vault_id,
        own_ct.as_deref(),
        own_nn.as_deref(),
        own_ch.as_deref(),
    )? {
        let now_s = Utc::now().to_rfc3339();
        let cancel_url =
            match crate::scheduler::mint_or_reuse_one_tap_token(state, vault_id, &now_s).await? {
                Some(token) => format!("{base}/#/checkin-link/{vault_id}/{token}"),
                None => format!("{base}/#/checkin"),
            };
        let body = format!(
            "Someone just opened the claim link for your vault.\n\n\
             If you stopped checking in on purpose, you don't need to do \
             anything. The person you chose is collecting what you left \
             them.\n\n\
             If you're reading this and you're fine, your vault thinks \
             you're gone, or someone else got hold of the claim link. \
             One check-in stops the claim immediately:\n\n\
             {cancel_url}\n\n\
             Nothing can leave the vault before {until}. After checking \
             in, have a look at your dashboard.\n\n\
             From GhostKey"
        );
        crate::notifier::enqueue(
            &state.db,
            vault_id,
            crate::notifier::NotificationKind::ClaimOpened,
            owner.channel,
            &owner.address,
            "A claim on your vault has started. Check in if you're fine",
            &body,
        )
        .await?;
    }

    // Trusted contact: knows nothing about the vault. Like the heir's
    // email, this reveals no label, no amounts — just "check on them".
    if let Some(trusted) = crate::notifier::parse_owner_contact(
        vault_id,
        tr_ct.as_deref(),
        tr_nn.as_deref(),
        tr_ch.as_deref(),
    )? {
        let body = format!(
            "Someone you know named you as their emergency contact on \
             GhostKey, a service that passes their Bitcoin to a person \
             they chose if they ever stop responding.\n\n\
             A claim on their account has just started. That usually \
             means they have passed away.\n\n\
             If you know they're alive and well, please tell them to \
             check their email and sign in to GhostKey right away. \
             Nothing moves for at least {hours} hours, and one check-in \
             from them stops the claim.\n\n\
             From GhostKey"
        );
        crate::notifier::enqueue(
            &state.db,
            vault_id,
            crate::notifier::NotificationKind::ClaimOpened,
            trusted.channel,
            &trusted.address,
            "You're someone's emergency contact. Please check on them",
            &body,
        )
        .await?;
    }
    Ok(())
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

/// The heir's details, decrypted for the authenticated owner. Lets the
/// dashboard show who the vault is for (name, how they'll be reached,
/// and the note left for them). Owner-only: the heir contact is sealed
/// at rest and only the vault's owner token unlocks this view.
#[derive(Debug, Serialize)]
pub struct HeirProfileView {
    pub name: Option<String>,
    pub contact: Option<String>,
    pub channel: Option<String>,
    pub note: Option<String>,
}

async fn get_vault_heir(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<HeirProfileView>, ApiError> {
    let id = auth.vault_id;
    let row: (
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        Option<String>, // heir_contact_channel
        Option<String>, // heir_intro_ciphertext
        Option<String>, // heir_intro_nonce
    ) = sqlx::query_as(
        r#"SELECT heir_contact_ciphertext, heir_contact_nonce, heir_contact_channel,
                  heir_intro_ciphertext, heir_intro_nonce
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let (contact_ct, contact_nn, channel, intro_ct, intro_nn) = row;

    // Heir contact is a sealed JSON blob {name, contact, channel}.
    let (mut name, mut contact) = (None, None);
    if let (Some(ct), Some(nn)) = (contact_ct, contact_nn) {
        let bytes = open_for_vault(
            &id,
            &SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nn,
            },
        )?;
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            name = v
                .get("name")
                .and_then(|n| n.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            contact = v
                .get("contact")
                .and_then(|c| c.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
        }
    }

    // Heir intro is a separate sealed JSON blob {from_name, note}; we
    // surface only the note the owner left for the heir.
    let mut note = None;
    if let (Some(ct), Some(nn)) = (intro_ct, intro_nn) {
        let bytes = open_for_vault(
            &id,
            &SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nn,
            },
        )?;
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            note = v
                .get("note")
                .and_then(|n| n.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
        }
    }

    Ok(Json(HeirProfileView {
        name,
        contact,
        channel,
        note,
    }))
}

async fn get_vault(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<VaultView>, ApiError> {
    let id = auth.vault_id;
    // Named row struct rather than a tuple: sqlx only implements
    // FromRow for tuples up to 16 columns and this query carries 17.
    #[derive(sqlx::FromRow)]
    struct VaultRow {
        id: String,
        label: Option<String>,
        network: String,
        timelock_blocks: i64,
        checkin_period_secs: i64,
        grace_period_secs: i64,
        status: String,
        created_at: String,
        last_checkin_at: Option<String>,
        next_deadline_at: String,
        claim_eligible_at: Option<String>,
        panic_frozen_until: Option<String>,
        /// Sealed rows only.
        owner_contact_channel: Option<String>,
        /// Has a sealed owner contact (0/1).
        has_owner_contact: i64,
        owner_contact_verified_at: Option<String>,
        descriptor_external: String,
        descriptor_internal: String,
        /// Has a sealed trusted contact (0/1).
        has_trusted_contact: i64,
        /// Cached on-chain maturity scan (refreshed by the scheduler).
        chain_unlock_height: Option<i64>,
        chain_tip_height: Option<i64>,
    }
    let row = sqlx::query_as::<_, VaultRow>(
        r#"SELECT id, label, network, timelock_blocks,
                  checkin_period_secs, grace_period_secs,
                  status, created_at, last_checkin_at, next_deadline_at,
                  claim_eligible_at, panic_frozen_until,
                  owner_contact_channel,
                  owner_contact_ciphertext IS NOT NULL AS has_owner_contact,
                  owner_contact_verified_at,
                  descriptor_external, descriptor_internal,
                  trusted_contact_ciphertext IS NOT NULL AS has_trusted_contact,
                  chain_unlock_height, chain_tip_height
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

    // Derive the on-chain unlock date from the cached maturity scan. We
    // never scan here — a dashboard poll reads whatever the scheduler last
    // wrote. `None` tip means we've never scanned (or it matured), so the
    // dashboard falls back to generic "set time" copy.
    let unlock_eta = row.chain_tip_height.and_then(|tip| {
        let est = crate::psbt_routes::UnlockEstimate {
            tip_height: tip as u32,
            unlock_height: row.chain_unlock_height.map(|h| h as u32),
        };
        crate::psbt_routes::UnlockEstimateView::from_estimate(&est, Utc::now()).unlock_eta
    });

    Ok(Json(VaultView {
        id: row.id,
        label: row.label,
        network: row.network,
        timelock_blocks: row.timelock_blocks,
        checkin_period_secs: row.checkin_period_secs,
        grace_period_secs: row.grace_period_secs,
        status: row.status,
        created_at: parse_rfc(&row.created_at),
        last_checkin_at: row.last_checkin_at.as_deref().map(parse_rfc),
        next_deadline_at: parse_rfc(&row.next_deadline_at),
        claim_eligible_at: row.claim_eligible_at.as_deref().map(parse_rfc),
        panic_frozen_until: row.panic_frozen_until.as_deref().map(parse_rfc),
        lnurl_checkin,
        lnurl_panic,
        // Some(bool) only when there's a sealed email contact to
        // verify; legacy plaintext rows and SMS/WhatsApp channels
        // report None so the dashboard never nags about them.
        owner_contact_verified: if row.has_owner_contact == 1
            && row.owner_contact_channel.as_deref() == Some("email")
        {
            Some(row.owner_contact_verified_at.is_some())
        } else {
            None
        },
        descriptor_external: Some(row.descriptor_external),
        descriptor_internal: Some(row.descriptor_internal),
        has_trusted_contact: Some(row.has_trusted_contact == 1),
        unlock_eta,
    }))
}

/// Owner-initiated vault deletion (used by "remove a heir"). Removes
/// the server-side vault row and its dependents (events, notifications,
/// lightning_invoices) via `ON DELETE CASCADE`. The owner's on-chain
/// funds are unaffected — they're spendable from the owner's xpub/seed,
/// which the server never held. Returns 204 on success; 404 if the
/// vault has already been removed.
///
/// Heir protection: once the owner's time is up and the heir's claim is
/// live, removal is *locked*. The owner can remove a heir while they're
/// still checking in (`ok`) or in the grace window (`alarmed`, where a
/// check-in still cancels everything), and while a panic freeze is in
/// effect (`frozen` — the owner is demonstrably present). But once the
/// claim link has been issued (`timelock_started`) or the heir has
/// begun/finished claiming, the inheritance must be honoured — we
/// refuse with 409 so no one with owner access can yank it away after
/// the owner stopped checking in.
/// Whether a vault's claim has progressed far enough that the owner can
/// no longer remove the heir. Once the claim link is issued
/// (`timelock_started`) or the heir is mid/post-claim, the inheritance
/// must be honoured. `ok`, `alarmed`, and `frozen` are all owner-
/// controllable states where removal stays allowed. See `delete_vault`.
fn claim_is_live(status: &str) -> bool {
    matches!(status, "timelock_started" | "claiming" | "claimed")
}

async fn delete_vault(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let id = auth.vault_id;

    let status: Option<(String,)> = sqlx::query_as("SELECT status FROM vaults WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    let Some((status,)) = status else {
        return Err(ApiError::NotFound);
    };
    if claim_is_live(&status) {
        return Err(ApiError::Conflict(
            "this heir's claim is already underway and can no longer be \
             removed. To stop it, check in. That cancels the claim while \
             you're still within the waiting window."
                .into(),
        ));
    }

    let res = sqlx::query("DELETE FROM vaults WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Body of `POST /vaults/:id/push-subscriptions` — the three fields
/// of `PushSubscription.toJSON()`, flattened. The browser mints all
/// three; we validate shape server-side so a corrupt row can never
/// reach the send path (push::send re-validates, but failing at
/// subscribe time gives the user an error they can act on).
#[derive(Debug, Deserialize)]
struct PushSubscribeRequest {
    endpoint: String,
    /// Browser ECDH public key, base64url (65-byte uncompressed SEC1).
    p256dh: String,
    /// 16-byte shared auth secret, base64url.
    auth: String,
}

/// Decode a base64url field the browser produced. Browsers emit
/// unpadded base64url from `PushSubscription.toJSON()`, but some
/// client-side re-encodes add padding — strip it rather than reject.
fn b64url_field(name: &str, value: &str) -> Result<Vec<u8>, ApiError> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .map_err(|_| ApiError::Validation(format!("{name} must be base64url")))
}

async fn push_subscribe(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<PushSubscribeRequest>,
) -> Result<StatusCode, ApiError> {
    let vault_id = auth.vault_id;

    // The endpoint is an attacker-controlled URL we will later POST
    // encrypted payloads to. Require https so a malicious subscribe
    // can't point the worker at plaintext infrastructure.
    let parsed = reqwest::Url::parse(&req.endpoint)
        .map_err(|_| ApiError::Validation("endpoint must be a URL".into()))?;
    if parsed.scheme() != "https" {
        return Err(ApiError::Validation("endpoint must be https".into()));
    }

    let p256dh_bytes = b64url_field("p256dh", &req.p256dh)?;
    if p256::PublicKey::from_sec1_bytes(&p256dh_bytes).is_err() {
        return Err(ApiError::Validation(
            "p256dh must be a valid P-256 public key".into(),
        ));
    }
    let auth_bytes = b64url_field("auth", &req.auth)?;
    if auth_bytes.len() != 16 {
        return Err(ApiError::Validation("auth must be 16 bytes".into()));
    }

    // Upsert keyed on (vault_id, endpoint): a browser re-subscribing
    // after a push-service key rotation reuses the endpoint with new
    // encryption params, and re-running the opt-in flow must not
    // produce duplicate sends.
    sqlx::query(
        r#"INSERT INTO push_subscriptions (vault_id, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (vault_id, endpoint)
           DO UPDATE SET p256dh = excluded.p256dh,
                         auth = excluded.auth,
                         created_at = excluded.created_at"#,
    )
    .bind(&vault_id)
    .bind(&req.endpoint)
    .bind(&req.p256dh)
    .bind(&req.auth)
    .bind(Utc::now().to_rfc3339())
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Body of `DELETE /vaults/:id/push-subscriptions`. Deletes by
/// endpoint rather than clearing the whole vault so unsubscribing on
/// one device leaves the owner's other devices subscribed.
#[derive(Debug, Deserialize)]
struct PushUnsubscribeRequest {
    endpoint: String,
}

async fn push_unsubscribe(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<PushUnsubscribeRequest>,
) -> Result<StatusCode, ApiError> {
    // Idempotent: deleting an endpoint that was already pruned (or
    // never registered) is still a 204 — the end state is identical.
    sqlx::query("DELETE FROM push_subscriptions WHERE vault_id = ? AND endpoint = ?")
        .bind(&auth.vault_id)
        .bind(&req.endpoint)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/* -------------------------------------------------------------------------- *
 *  Owner email verification                                                  *
 *                                                                            *
 *  POST /vaults/:id/verify-contact/:token — the owner tapped the link we     *
 *  emailed at setup. The token is the credential (same hash-and-compare      *
 *  scheme as the one-tap check-in link); no OwnerAuth, because the owner     *
 *  may open the email on a device that has never seen the vault.            *
 *                                                                            *
 *  POST /vaults/:id/resend-verification — OwnerAuth; re-mints the token      *
 *  and re-enqueues the email. Throttled so a tap-happy owner can't turn      *
 *  the notifier into an email cannon.                                        *
 * -------------------------------------------------------------------------- */

async fn verify_contact(
    State(state): State<Arc<AppState>>,
    Path((id, token)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT owner_contact_verify_token_hash, owner_contact_verified_at, \
                owner_contact_verify_sent_at \
           FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (stored_hash, verified_at, sent_at) = row.ok_or(ApiError::NotFound)?;

    // Already confirmed: report success whatever token was presented.
    // The common path here is the owner tapping the same email link
    // twice; a 404 on the second tap would read as "something broke".
    if verified_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }

    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !crypto::claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }

    // A4 (#122): the verification link expires. An old link sitting in a
    // mailbox shouldn't be able to confirm the address weeks later — by
    // then the owner may no longer control that inbox. `resend_verification`
    // re-mints the token and resets sent_at, so a fresh window is always a
    // tap away from the dashboard.
    if verify_token_expired(sent_at.as_deref()) {
        return Err(ApiError::Validation(
            "This confirmation link has expired. Open your GhostKey dashboard \
             and resend the confirmation email."
                .into(),
        ));
    }

    sqlx::query(
        r#"UPDATE vaults
              SET owner_contact_verified_at       = ?,
                  owner_contact_verify_token_hash = NULL
            WHERE id = ?
              AND owner_contact_verify_token_hash = ?"#,
    )
    .bind(Utc::now().to_rfc3339())
    .bind(&id)
    .bind(&stored_hash)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "owner_contact_verified", None).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// How long a confirmation link stays valid. Seven days is long enough
/// for a real person to get to their inbox and tap, short enough that a
/// link leaked from an old mailbox can't be used to confirm the address
/// much later. Surfaced to the owner in the email body.
pub const VERIFY_TTL_SECS: i64 = 7 * 24 * 3600;

/// True when a verification token minted at `sent_at` is older than
/// [`VERIFY_TTL_SECS`]. A missing or unparseable `sent_at` is treated as
/// expired (fail closed): a token we can't date is one we won't trust.
fn verify_token_expired(sent_at: Option<&str>) -> bool {
    match sent_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(sent) => Utc::now().signed_duration_since(sent).num_seconds() > VERIFY_TTL_SECS,
        None => true,
    }
}

/// Minimum gap between verification emails. Generous enough for "it
/// never arrived, send another", tight enough that the button can't
/// be used to spam the owner's own inbox (or burn SMTP quota).
const VERIFY_RESEND_COOLDOWN_SECS: i64 = 60;

async fn resend_verification(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let id = auth.vault_id;
    #[allow(clippy::type_complexity)]
    let row: Option<(
        Option<String>, // owner_contact_ciphertext
        Option<String>, // owner_contact_nonce
        Option<String>, // owner_contact_channel
        Option<String>, // owner_contact_verified_at
        Option<String>, // owner_contact_verify_sent_at
    )> = sqlx::query_as(
        "SELECT owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel, \
                owner_contact_verified_at, owner_contact_verify_sent_at \
           FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (ct, nonce, channel, verified_at, sent_at) = row.ok_or(ApiError::NotFound)?;

    // Nothing to verify: no sealed email contact on file.
    let (Some(ct), Some(nonce)) = (ct, nonce) else {
        return Err(ApiError::Validation(
            "this vault has no reminder email on file".into(),
        ));
    };
    if channel.as_deref() != Some("email") {
        return Err(ApiError::Validation(
            "verification is only available for email contacts".into(),
        ));
    }
    // Already verified: idempotent success, no email.
    if verified_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(sent_s) = sent_at.as_deref() {
        if let Ok(sent) = DateTime::parse_from_rfc3339(sent_s) {
            let elapsed = Utc::now() - sent.with_timezone(&Utc);
            if elapsed.num_seconds() < VERIFY_RESEND_COOLDOWN_SECS {
                return Err(ApiError::Conflict(
                    "a confirmation email was just sent. Give it a minute, then check spam".into(),
                ));
            }
        }
    }

    let sealed = SealedContact {
        ciphertext_b64: ct,
        nonce_b64: nonce,
    };
    let email = String::from_utf8(open_for_vault(&id, &sealed)?)
        .map_err(|_| ApiError::Validation("stored contact is not valid UTF-8".into()))?;
    send_contact_verification(&state, &id, &email).await?;
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
                  claim_opened_at      = NULL,
                  claim_ready_notified_at = NULL,
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
        Option<String>, // claim_eligible_at
    )> = sqlx::query_as(
        r#"SELECT checkin_link_token_hash, checkin_link_token_used_at,
                  checkin_period_secs, grace_period_secs, last_checkin_at,
                  claim_eligible_at
             FROM vaults
            WHERE id = ?
              AND checkin_link_token_hash = ?"#,
    )
    .bind(&id)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    let (stored_hash, used_at, checkin_secs, grace_secs, last_checkin_at, claim_eligible_at) =
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

    // Free check-in via the link is a last resort: only allowed inside the
    // final 24h before the heir would be contacted (claim_eligible_at).
    // Outside that window Lightning is the only way to check in, so the
    // free path is refused (the Lightning-from-link route has no gate).
    // The matching UI only surfaces the free option after a Lightning
    // payment has actually failed, so both halves of the rule hold.
    let last_resort_window = Duration::seconds(24 * 60 * 60);
    let in_last_resort_window = claim_eligible_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|eligible| eligible.with_timezone(&Utc) - Utc::now() <= last_resort_window)
        .unwrap_or(false);
    if !in_last_resort_window {
        return Err(ApiError::Conflict(
            "free check-in is only available in the final 24 hours; \
             check in with Lightning instead"
                .into(),
        ));
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
                  claim_opened_at      = NULL,
                  claim_ready_notified_at = NULL,
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
                  claim_token_used_at   = NULL,
                  claim_opened_at       = NULL,
                  claim_ready_notified_at = NULL
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
    /// When the claim-challenge window ends and the claim can be
    /// completed. `None` means no wait — either the window is
    /// disabled or it has already elapsed. While set, the claim page
    /// shows the safety-wait screen and the key/PSBT endpoints refuse.
    pub claim_available_at: Option<DateTime<Utc>>,
    /// "standard" or "guardian" (#81). A guardian vault needs the heir
    /// plus one guardian to claim, so the claim page renders the
    /// two-link flow instead of the one-shot heir flow.
    pub vault_kind: String,
    /// Which party opened this link: "heir" or "guardian". Lets the
    /// claim page ask for the *other* party's link.
    pub token_role: String,
    /// For a guardian token, which slot (1 or 2). `None` for heir tokens.
    pub guardian_slot: Option<i64>,
}

async fn resolve_claim(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<ClaimView>, ApiError> {
    let hash = hash_claim_token(&token);

    // Look up by hash. The DB lookup itself is constant-time across
    // unknown tokens because we always index against a unique hash;
    // the row either exists or it doesn't. A guardian vault has the
    // heir token inline here AND each guardian's token in
    // vault_guardian_keys, so we try the heir (inline) lookup first and
    // fall back to a guardian-token lookup (#81).
    type HeirRow = (
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
        String,         // vault_kind
    );
    let heir_row: Option<HeirRow> = sqlx::query_as(
        r#"SELECT id, label, network, status, timelock_blocks,
                  next_deadline_at,
                  claim_token_hash, claim_token_used_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  heir_contact_channel, vault_kind
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    // Resolved into the shape the rest of the function (challenge window,
    // contact decrypt, ClaimView) consumes, with the role/slot the heir
    // and guardian paths differ on.
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
        vault_kind,
        token_role,
        guardian_slot,
    ) = match heir_row {
        Some(r) => (
            r.0,
            r.1,
            r.2,
            r.3,
            r.4,
            r.5,
            r.6,
            r.7,
            r.8,
            r.9,
            r.10,
            r.11,
            "heir".to_string(),
            None,
        ),
        None => {
            // Guardian token: join the guardian row to its vault. The
            // heir contact (for the display name) lives on the vault, so
            // a guardian still sees whose claim they're helping with.
            type GuardianRow = (
                String,         // vault id
                Option<String>, // label
                String,         // network
                String,         // status
                i64,            // timelock_blocks
                String,         // next_deadline_at
                Option<String>, // g.claim_token_hash
                Option<String>, // v.claim_token_used_at
                Option<String>, // heir_contact_ciphertext
                Option<String>, // heir_contact_nonce
                Option<String>, // heir_contact_channel
                i64,            // g.slot
            );
            let g: Option<GuardianRow> = sqlx::query_as(
                r#"SELECT v.id, v.label, v.network, v.status, v.timelock_blocks,
                          v.next_deadline_at,
                          g.claim_token_hash, v.claim_token_used_at,
                          v.heir_contact_ciphertext, v.heir_contact_nonce,
                          v.heir_contact_channel, g.slot
                     FROM vault_guardian_keys g
                     JOIN vaults v ON v.id = g.vault_id
                    WHERE g.claim_token_hash = ?"#,
            )
            .bind(&hash)
            .fetch_optional(&state.db)
            .await?;
            let g = g.ok_or(ApiError::NotFound)?;
            (
                g.0,
                g.1,
                g.2,
                g.3,
                g.4,
                g.5,
                g.6,
                g.7,
                g.8,
                g.9,
                g.10,
                "guardian".to_string(),
                "guardian".to_string(),
                Some(g.11),
            )
        }
    };

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

    // First valid resolve starts the challenge window and alerts the
    // owner + trusted contact; later resolves just report how long is
    // left so the claim page can render the wait screen.
    let claim_available_at = ensure_claim_challenge(&state, &vault_id).await?;

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
    //
    // We also do NOT record an event per resolve. The meaningful
    // "heir opened the claim link" moment is logged exactly once,
    // idempotently, by `ensure_claim_challenge` (the `claim_opened`
    // event). Recording on every GET here spammed the owner's
    // activity feed with one row per heir page refresh, mislabelled
    // as "Claim stopped, you checked in" — the opposite of the truth.

    Ok(Json(ClaimView {
        vault_id,
        label,
        network,
        status,
        timelock_blocks,
        next_deadline_at: parse_rfc(&next_deadline),
        heir_channel,
        heir_display_name,
        claim_available_at,
        vault_kind,
        token_role,
        guardian_slot,
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
    /// The owner's descriptor key fragment, e.g.
    /// `[fp/86'/0'/0']xpub.../0/*`. Lets the "add a heir" flow create a
    /// sibling vault under the *same* owner key without re-deriving the
    /// master fingerprint (which the account-level xprv can't reproduce):
    /// the client strips the `/0/*` suffix and passes the rest as an
    /// origin-tagged `owner.xpub`, so the server rebuilds an identical
    /// owner branch. `None` for legacy rows that predate this column.
    pub owner_xpub_fragment_external: Option<String>,
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
        Option<String>, // owner_xpub_fragment_external
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, password_salt_b64, password_kdf_mem_kib, password_kdf_iters,
                  owner_xprv_sealed_ct_b64, owner_xprv_sealed_nonce,
                  owner_token_sealed_ct_b64, owner_token_sealed_nonce,
                  network, timelock_blocks, owner_xpub_fragment_external
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
        owner_xpub_fragment_external: row.10,
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
    Ok(Json(create_checkin_invoice(&state, &auth.vault_id).await?))
}

/// Mint a check-in invoice for a vault. Shared by the owner-authenticated
/// route and the one-tap-link route below. Enforces "lightning enabled"
/// and the once-per-period guard, writes the `lightning_invoices` row,
/// records the event, and returns the view. The actual check-in happens
/// when the invoice is paid (see `lightning::mark_paid_and_checkin` in the
/// poller), not here.
async fn create_checkin_invoice(
    state: &Arc<AppState>,
    vault_id: &str,
) -> Result<LightningInvoiceView, ApiError> {
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
            .bind(vault_id)
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

    let description = format!("ghostkey:checkin:{vault_id}");
    let invoice = state
        .lightning
        .create_invoice(crate::lightning::heartbeat_amount_sat(), &description)
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
        vault_id,
        &invoice,
        crate::lightning::INVOICE_TYPE_CHECKIN,
    )
    .await?;

    record_event(
        &state.db,
        vault_id,
        "lightning_invoice_issued",
        Some(serde_json::json!({
            "payment_hash": invoice.payment_hash,
            "amount_sat": invoice.amount_sat,
        })),
    )
    .await?;

    Ok(LightningInvoiceView {
        bolt11: rec.bolt11,
        payment_hash: rec.payment_hash,
        amount_sat: rec.amount_sat as u64,
        expires_at: rec.expires_at,
        status: rec.status,
    })
}

/// Owner-free variant of the Lightning check-in mint, gated by a one-tap
/// check-in link token instead of the owner bearer. Lets the owner pay
/// the check-in invoice straight from the link in a reminder email,
/// without signing in. The token is verified but NOT consumed here: the
/// check-in (and token clearing) happens when the invoice is paid.
async fn lightning_create_invoice_from_link(
    State(state): State<Arc<AppState>>,
    Path((vault_id, token)): Path<(String, String)>,
) -> Result<Json<LightningInvoiceView>, ApiError> {
    verify_checkin_link_token(&state, &vault_id, &token).await?;
    Ok(Json(create_checkin_invoice(&state, &vault_id).await?))
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
    Ok(Json(
        read_invoice_status(&state, &vault_id, &payment_hash).await?,
    ))
}

/// Read an invoice's status for a vault. Shared by the owner-authenticated
/// route and the one-tap-link route. Cross-vault lookups are flattened to
/// NotFound so the relationship can't be probed.
async fn read_invoice_status(
    state: &Arc<AppState>,
    vault_id: &str,
    payment_hash: &str,
) -> Result<LightningInvoiceStatusView, ApiError> {
    let rec = crate::lightning::fetch_invoice_by_hash(&state.db, payment_hash)
        .await?
        .ok_or(ApiError::NotFound)?;

    if rec.vault_id != vault_id {
        return Err(ApiError::NotFound);
    }

    Ok(LightningInvoiceStatusView {
        payment_hash: rec.payment_hash,
        status: rec.status,
        paid_at: rec.paid_at,
        expires_at: rec.expires_at,
    })
}

/// Poll an invoice's status using a one-tap link token instead of the
/// owner bearer. Pairs with `lightning_create_invoice_from_link` so the
/// email-link Lightning flow can wait for payment without signing in.
async fn lightning_invoice_status_from_link(
    State(state): State<Arc<AppState>>,
    Path((vault_id, token, payment_hash)): Path<(String, String, String)>,
) -> Result<Json<LightningInvoiceStatusView>, ApiError> {
    verify_checkin_link_token(&state, &vault_id, &token).await?;
    Ok(Json(
        read_invoice_status(&state, &vault_id, &payment_hash).await?,
    ))
}

/// Verify a one-tap check-in link token WITHOUT consuming it. Used by the
/// Lightning-from-link routes, where the token only authorises minting and
/// polling an invoice; the check-in (and token clearing) happens when the
/// invoice is paid. Mirrors the validation in `checkin_from_link`:
/// NotFound for an unknown or already-cleared token, Conflict for one that
/// has been used.
async fn verify_checkin_link_token(
    state: &Arc<AppState>,
    vault_id: &str,
    token: &str,
) -> Result<(), ApiError> {
    let hash = hash_claim_token(token);
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT checkin_link_token_hash, checkin_link_token_used_at
             FROM vaults
            WHERE id = ?
              AND checkin_link_token_hash = ?"#,
    )
    .bind(vault_id)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let (stored_hash, used_at) = row.ok_or(ApiError::NotFound)?;
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !crypto::claim_token_matches(token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if used_at.is_some() {
        return Err(ApiError::Conflict("check-in link already used".into()));
    }
    Ok(())
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
    let amount_sat = crate::lightning::heartbeat_amount_sat();
    let body = if is_panic {
        crate::lnurl::panic_pay_request_json(&callback_url, amount_sat)
    } else {
        crate::lnurl::pay_request_json(&callback_url, amount_sat)
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
        .create_invoice(crate::lightning::heartbeat_amount_sat(), &description)
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
    fn verify_token_expiry_window() {
        // Fresh: minted now -> still valid.
        let now = Utc::now().to_rfc3339();
        assert!(!verify_token_expired(Some(&now)));

        // Just inside the window (6 days old) -> valid.
        let six_days = (Utc::now() - Duration::seconds(6 * 24 * 3600)).to_rfc3339();
        assert!(!verify_token_expired(Some(&six_days)));

        // Past the window (8 days old) -> expired.
        let eight_days = (Utc::now() - Duration::seconds(8 * 24 * 3600)).to_rfc3339();
        assert!(verify_token_expired(Some(&eight_days)));

        // Fail closed on missing or garbage timestamps.
        assert!(verify_token_expired(None));
        assert!(verify_token_expired(Some("not-a-date")));
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

    /* ---------------- owner email verification ---------------- */

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

    async fn insert_vault_with_email(state: &AppState, id: &str, email: &str) {
        let sealed = seal_for_vault(id, email.as_bytes()).expect("seal contact");
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'ok',
                      ?, ?, 'email')"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .execute(&state.db)
        .await
        .expect("insert vault");
    }

    #[tokio::test]
    async fn same_owner_may_add_heirs_but_different_owner_key_conflicts() {
        let state = fresh_state().await;
        let hash = "a".repeat(64);
        let owner_frag = "tr(OWNERKEY/0/*)";

        // No vault yet: creation may proceed.
        reject_conflicting_owner_email(&state.db, &hash, owner_frag)
            .await
            .expect("no conflict when table is empty");

        insert_vault_with_email(&state, "v-dup-1", "owner@example.com").await;
        sqlx::query(
            "UPDATE vaults \
                SET owner_email_hash = ?, owner_xpub_fragment_external = ? \
              WHERE id = 'v-dup-1'",
        )
        .bind(&hash)
        .bind(owner_frag)
        .execute(&state.db)
        .await
        .expect("set email hash + owner fragment");

        // Same owner key, same email → adding another heir is allowed.
        reject_conflicting_owner_email(&state.db, &hash, owner_frag)
            .await
            .expect("same owner may add more heirs under one email");

        // A *different* owner key on the same email is a real collision.
        let err = reject_conflicting_owner_email(&state.db, &hash, "tr(SOMEONEELSE/0/*)")
            .await
            .expect_err("different owner key on same email must conflict");
        assert!(matches!(err, ApiError::Conflict(_)), "got {err:?}");

        // A different email is unaffected.
        reject_conflicting_owner_email(&state.db, &"b".repeat(64), owner_frag)
            .await
            .expect("different email passes");

        // Once the vault is claimed, the email is free again — even for
        // a brand-new owner key.
        sqlx::query("UPDATE vaults SET status = 'claimed' WHERE id = 'v-dup-1'")
            .execute(&state.db)
            .await
            .expect("mark claimed");
        reject_conflicting_owner_email(&state.db, &hash, "tr(SOMEONEELSE/0/*)")
            .await
            .expect("claimed vault frees the email");
    }

    #[test]
    fn claim_is_live_locks_removal_once_claim_starts() {
        // Owner-controllable states: heir removal stays allowed.
        for s in ["ok", "alarmed", "frozen"] {
            assert!(!claim_is_live(s), "{s} should allow removal");
        }
        // Claim underway or done: removal is locked (heir protection).
        for s in ["timelock_started", "claiming", "claimed"] {
            assert!(claim_is_live(s), "{s} should lock removal");
        }
    }

    async fn verified_at(state: &AppState, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT owner_contact_verified_at FROM vaults WHERE id = ?")
            .bind(id)
            .fetch_one(&state.db)
            .await
            .expect("read verified_at")
    }

    #[tokio::test]
    async fn verify_contact_happy_path_sets_verified_and_clears_hash() {
        let state = fresh_state().await;
        insert_vault_with_email(&state, "v-verify-1", "owner@example.com").await;
        send_contact_verification(&state, "v-verify-1", "owner@example.com")
            .await
            .expect("enqueue verification");

        // The raw token only lives in the email body; fish it out of
        // the sealed notification the way the owner's inbox would.
        let (body_ct, body_nonce): (String, String) = sqlx::query_as(
            "SELECT body_ciphertext, body_nonce FROM notifications WHERE vault_id = ?",
        )
        .bind("v-verify-1")
        .fetch_one(&state.db)
        .await
        .expect("one notification row");
        let body = String::from_utf8(
            open_for_vault(
                "v-verify-1",
                &SealedContact {
                    ciphertext_b64: body_ct,
                    nonce_b64: body_nonce,
                },
            )
            .expect("open body"),
        )
        .expect("utf8 body");
        let token = body
            .split("/#/verify-email/v-verify-1/")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .expect("link with token in body")
            .to_string();

        let status = verify_contact(
            State(state.clone()),
            Path(("v-verify-1".to_string(), token.clone())),
        )
        .await
        .expect("verify ok");
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(verified_at(&state, "v-verify-1").await.is_some());

        // Second tap of the same link: still 204, not an error.
        let again = verify_contact(
            State(state.clone()),
            Path(("v-verify-1".to_string(), token)),
        )
        .await
        .expect("idempotent re-verify");
        assert_eq!(again, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn verify_contact_rejects_wrong_token() {
        let state = fresh_state().await;
        insert_vault_with_email(&state, "v-verify-2", "owner@example.com").await;
        send_contact_verification(&state, "v-verify-2", "owner@example.com")
            .await
            .expect("enqueue verification");

        let err = verify_contact(
            State(state.clone()),
            Path(("v-verify-2".to_string(), "not-the-token".to_string())),
        )
        .await
        .expect_err("wrong token must 404");
        assert!(matches!(err, ApiError::NotFound));
        assert!(verified_at(&state, "v-verify-2").await.is_none());
    }

    #[tokio::test]
    async fn verify_contact_rejects_unknown_vault() {
        let state = fresh_state().await;
        let err = verify_contact(
            State(state.clone()),
            Path(("no-such-vault".to_string(), "whatever".to_string())),
        )
        .await
        .expect_err("unknown vault must 404");
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn resend_overwrites_token_and_old_link_dies() {
        let state = fresh_state().await;
        insert_vault_with_email(&state, "v-verify-3", "owner@example.com").await;
        send_contact_verification(&state, "v-verify-3", "owner@example.com")
            .await
            .expect("first send");
        let first_hash: Option<String> =
            sqlx::query_scalar("SELECT owner_contact_verify_token_hash FROM vaults WHERE id = ?")
                .bind("v-verify-3")
                .fetch_one(&state.db)
                .await
                .expect("read hash");

        send_contact_verification(&state, "v-verify-3", "owner@example.com")
            .await
            .expect("second send");
        let second_hash: Option<String> =
            sqlx::query_scalar("SELECT owner_contact_verify_token_hash FROM vaults WHERE id = ?")
                .bind("v-verify-3")
                .fetch_one(&state.db)
                .await
                .expect("read hash");

        assert!(first_hash.is_some() && second_hash.is_some());
        assert_ne!(first_hash, second_hash, "resend must mint a fresh token");

        // Two notification rows queued (one per send).
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE vault_id = ?")
            .bind("v-verify-3")
            .fetch_one(&state.db)
            .await
            .expect("count");
        assert_eq!(n, 2);
    }

    /* ---------------- Door B: heir holds their own key ---------------- */

    /// `create_vault_from_xpub` touches `seal_for_vault`, which needs a
    /// master key. Tests share one process-wide key (the `OnceLock` in
    /// crypto only initialises once); 32 zero bytes is fine for sealing.
    fn ensure_test_master_key() {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            // 32 zero bytes, base64 (no pad) = 43 'A's.
            let b64 = "A".repeat(43);
            // SAFETY: tests run before any handler; we only set, never unset.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", b64);
            }
        }
    }

    /// A minimal, shape-valid `SealedSetup`. Heir-side material and the
    /// claim token are left to the caller so each test can pick Door A
    /// (all present) or Door B (all absent).
    fn sealed_setup(
        owner_email_hash: &str,
        heir_xprv_ct_b64: Option<String>,
        heir_xprv_nonce_b64: Option<String>,
        claim_token_b64: Option<String>,
    ) -> SealedSetup {
        SealedSetup {
            password_salt_b64: "c2FsdA".into(),
            password_kdf_mem_kib: 19_456,
            password_kdf_iters: 2,
            owner_xprv_ct_b64: "b3duZXJjdA".into(),
            owner_xprv_nonce_b64: "b3duZXJubg".into(),
            owner_token_ct_b64: "dG9rY3Q".into(),
            owner_token_nonce_b64: "dG9rbm4".into(),
            heir_xprv_ct_b64,
            heir_xprv_nonce_b64,
            owner_email_hash: owner_email_hash.into(),
            claim_token_b64,
        }
    }

    fn door_b_request(sealed: SealedSetup) -> CreateVaultFromXpubRequest {
        let (owner_xpub, owner_fp) = xpub_for(0x77);
        let (heir_xpub, heir_fp) = xpub_for(0x88);
        CreateVaultFromXpubRequest {
            label: Some("door-b".into()),
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            timelock_blocks: 144,
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            // No owner email → skip the verification-email side effect.
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed: Some(sealed),
            heir_derivation: None,
            trusted_contact: None,
            trusted_contact_channel: None,
            from_name: None,
            heir_note: None,
        }
    }

    /// The whole point of Door B: the server stores a real, spendable-by-
    /// the-heir descriptor but holds NOTHING that can produce the heir's
    /// key or claim token. The scheduler mints a fresh token at trigger
    /// time, exactly like a legacy vault.
    #[tokio::test]
    async fn door_b_stores_no_heir_secret_or_claim_token() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let req = door_b_request(sealed_setup(&"d".repeat(64), None, None, None));

        let (code, created) = create_vault_from_xpub(State(state.clone()), Json(req))
            .await
            .expect("Door B create should succeed");
        assert_eq!(code, StatusCode::CREATED);
        let id = created.vault.id.clone();
        // Door B owners hold their own key already; no derivation secret
        // is ever returned.
        assert!(
            created.vault_secret_hex.is_none(),
            "Door B must not emit a vault secret"
        );

        // The descriptor must be a real, parseable timelock vault.
        let (ext, heir_ct, heir_nn, at_rest, token_hash, derived): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        ) = sqlx::query_as(
            "SELECT descriptor_external, heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce, \
                    claim_token_at_rest_b64, claim_token_hash, heir_derived \
               FROM vaults WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .expect("vault row");

        assert!(ext.starts_with("tr("), "real descriptor stored: {ext}");
        parse_descriptor(&ext).expect("stored descriptor must parse");
        // The crux: nothing spendable, no token, at rest.
        assert!(heir_ct.is_none(), "Door B must seal no heir xprv");
        assert!(heir_nn.is_none(), "Door B must seal no heir nonce");
        assert!(
            at_rest.is_none(),
            "Door B must store no at-rest claim token"
        );
        assert!(
            token_hash.is_none(),
            "Door B must store no claim-token hash"
        );
        assert_eq!(derived, 0, "Door B is not a server-derived heir");
    }

    /// The one-tap-link Lightning route must verify the link token (a bad
    /// token is NotFound, never reaching the provider) and then defer to
    /// the Lightning provider (NoopProvider in tests reports "not
    /// configured"). This proves the token gate without a real backend.
    #[tokio::test]
    async fn lightning_from_link_verifies_token_then_defers_to_provider() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let req = door_b_request(sealed_setup(&"e".repeat(64), None, None, None));
        let (_, created) = create_vault_from_xpub(State(state.clone()), Json(req))
            .await
            .expect("Door B create should succeed");
        let id = created.vault.id.clone();

        // Attach a one-tap check-in link token to the vault.
        let token = "a".repeat(64);
        let hash = hash_claim_token(&token);
        sqlx::query("UPDATE vaults SET checkin_link_token_hash = ? WHERE id = ?")
            .bind(&hash)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("set link token");

        // Wrong token: rejected as NotFound, never reaching the provider.
        let err = lightning_create_invoice_from_link(
            State(state.clone()),
            Path((id.clone(), "b".repeat(64))),
        )
        .await
        .expect_err("wrong token must be rejected");
        assert!(matches!(err, ApiError::NotFound));

        // Right token: passes the gate, then fails on the absent provider.
        let err =
            lightning_create_invoice_from_link(State(state.clone()), Path((id.clone(), token)))
                .await
                .expect_err("no provider in tests");
        assert!(
            matches!(&err, ApiError::Validation(m) if m.contains("lightning provider not configured"))
        );
    }

    #[tokio::test]
    async fn health_reports_notifier_queue_health() {
        ensure_test_master_key();
        let state = fresh_state().await;

        // Empty queue: healthy, nothing due or failed.
        let h = health(State(state.clone())).await.0;
        assert!(h.notifier_healthy);
        assert_eq!(h.notifications_due, 0);
        assert_eq!(h.notifications_failed, 0);
        assert!(h.notifications_oldest_due_secs.is_none());

        // A vault to satisfy the notifications foreign key.
        sqlx::query(
            r#"INSERT INTO vaults (id, network, descriptor_external, descriptor_internal,
                 timelock_blocks, checkin_period_secs, grace_period_secs,
                 created_at, next_deadline_at, status, claim_eligible_at)
               VALUES ('v-health','regtest','tr(fake/0/*)','tr(fake/1/*)',144,86400,3600,
                 '2026-01-01T00:00:00Z','2099-01-01T00:00:00Z','ok','2099-01-02T00:00:00Z')"#,
        )
        .execute(&state.db)
        .await
        .unwrap();

        // A long-overdue pending notification: the notifier looks stuck.
        let overdue = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query(
            r#"INSERT INTO notifications (vault_id, kind, channel, recipient_ciphertext,
                 recipient_nonce, body_ciphertext, body_nonce, status, created_at, scheduled_at)
               VALUES ('v-health','reminder','email','x','x','x','x','pending', ?1, ?1)"#,
        )
        .bind(&overdue)
        .execute(&state.db)
        .await
        .unwrap();

        let h = health(State(state.clone())).await.0;
        assert_eq!(h.notifications_due, 1);
        assert!(
            !h.notifier_healthy,
            "an hour-overdue notification is past the stuck threshold"
        );
        assert!(h.notifications_oldest_due_secs.unwrap() >= 3000);
    }

    /// The heir xprv is sealed under the claim token, so the two are
    /// coupled: all-present (Door A) or all-absent (Door B). A half-
    /// populated payload is a client bug and must be rejected, not
    /// silently persisted into an unclaimable vault.
    #[tokio::test]
    async fn sealed_heir_and_claim_token_must_be_coupled() {
        ensure_test_master_key();
        let state = fresh_state().await;

        // Heir secret present, but no claim token to unseal it with.
        let orphan_heir = door_b_request(sealed_setup(
            &"e".repeat(64),
            Some("aGVpcmN0".into()),
            Some("aGVpcm5u".into()),
            None,
        ));
        let err = create_vault_from_xpub(State(state.clone()), Json(orphan_heir))
            .await
            .expect_err("heir-without-token must be rejected");
        assert!(
            matches!(&err, ApiError::Validation(m) if m.contains("both present or both absent")),
            "got {err:?}"
        );

        // Claim token present, but no heir secret it could be sealing.
        let orphan_token = door_b_request(sealed_setup(
            &"f".repeat(64),
            None,
            None,
            Some("dG9rZW4".into()),
        ));
        let err = create_vault_from_xpub(State(state.clone()), Json(orphan_token))
            .await
            .expect_err("token-without-heir must be rejected");
        assert!(
            matches!(&err, ApiError::Validation(m) if m.contains("both present or both absent")),
            "got {err:?}"
        );
    }

    fn guardian_party(seed: u8, token: &str) -> GuardianParty {
        let (xpub, fp) = xpub_for(seed);
        GuardianParty {
            xpub,
            fingerprint: Some(fp),
            xprv_ct_b64: "Z3VhcmRjdA".into(),
            xprv_nonce_b64: "Z3VhcmRubg".into(),
            claim_token_b64: token.into(),
            contact: Some(format!("guardian{seed}@example.com")),
            contact_channel: Some("email".into()),
        }
    }

    /// A guardian vault (#81 P2) persists the heir inline plus two guardian
    /// rows, marks the vault `guardian`, and stores a real `heir AND
    /// (g1 OR g2)` descriptor. Each party's claim token is stored only as a
    /// hash + sealed-at-rest, never verbatim.
    #[tokio::test]
    async fn guardian_vault_persists_heir_inline_and_two_guardian_rows() {
        ensure_test_master_key();
        let state = fresh_state().await;

        let (owner_xpub, owner_fp) = xpub_for(0x21);
        let (heir_xpub, heir_fp) = xpub_for(0x22);
        let sealed = sealed_setup(
            &"e".repeat(64),
            Some("aGVpcmN0".into()),
            Some("aGVpcm5u".into()),
            Some("heir-token".into()),
        );
        let req = CreateGuardianVaultRequest {
            label: Some("guardian".into()),
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            guardian1: guardian_party(0x23, "g1-token"),
            guardian2: guardian_party(0x24, "g2-token"),
            timelock_blocks: 144,
            unlock_height: None,
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed,
            from_name: None,
            heir_note: None,
        };

        let (code, created) = create_vault_guardian(State(state.clone()), Json(req))
            .await
            .expect("guardian create should succeed");
        assert_eq!(code, StatusCode::CREATED);
        let id = created.vault.id.clone();

        // Vault row: marked guardian, heir sealed inline, real descriptor.
        let (kind, ext, heir_ct, token_hash): (String, String, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT vault_kind, descriptor_external, heir_xprv_sealed_ct_b64, claim_token_hash \
                   FROM vaults WHERE id = ?",
            )
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .expect("vault row");
        assert_eq!(kind, "guardian");
        assert!(ext.contains("or_b(pk("), "guardian descriptor: {ext}");
        parse_descriptor(&ext).expect("descriptor parses");
        assert!(heir_ct.is_some(), "heir xprv sealed inline");
        let heir_hash = token_hash.expect("heir claim-token hash stored");
        assert_ne!(heir_hash, "heir-token", "token stored hashed, not verbatim");

        // Two guardian rows, each with its own hashed token + sealed key.
        let rows: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT slot, claim_token_hash, xprv_sealed_ct_b64 \
               FROM vault_guardian_keys WHERE vault_id = ? ORDER BY slot",
        )
        .bind(&id)
        .fetch_all(&state.db)
        .await
        .expect("guardian rows");
        assert_eq!(rows.len(), 2, "two guardian rows");
        assert_eq!(rows[0].0, 1);
        assert_eq!(rows[1].0, 2);
        assert_eq!(rows[0].1, crate::crypto::hash_claim_token("g1-token"));
        assert_eq!(rows[1].1, crate::crypto::hash_claim_token("g2-token"));
        assert_ne!(rows[0].1, rows[1].1, "guardians have distinct tokens");
    }

    /// All four keys must differ — a shared key would collapse the policy.
    #[tokio::test]
    async fn guardian_vault_rejects_duplicate_keys() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let (owner_xpub, owner_fp) = xpub_for(0x31);
        let (heir_xpub, heir_fp) = xpub_for(0x32);
        let req = CreateGuardianVaultRequest {
            label: None,
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            // guardian2 reuses guardian1's key → must be rejected.
            guardian1: guardian_party(0x33, "g1-token"),
            guardian2: guardian_party(0x33, "g2-token"),
            timelock_blocks: 144,
            unlock_height: None,
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed: sealed_setup(
                &"f".repeat(64),
                Some("aGVpcmN0".into()),
                Some("aGVpcm5u".into()),
                Some("heir-token".into()),
            ),
            from_name: None,
            heir_note: None,
        };
        let err = create_vault_guardian(State(state.clone()), Json(req))
            .await
            .expect_err("duplicate guardian keys must be rejected");
        assert!(
            matches!(&err, ApiError::Validation(m) if m.contains("must all differ")),
            "got {err:?}"
        );
    }

    /// #81 P5: an `unlock_height` on the create request embeds an absolute
    /// `after(H)` CLTV in the stored guardian descriptor.
    #[tokio::test]
    async fn guardian_vault_unlock_height_embeds_cltv() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let (owner_xpub, owner_fp) = xpub_for(0x61);
        let (heir_xpub, heir_fp) = xpub_for(0x62);
        let req = CreateGuardianVaultRequest {
            label: Some("guardian".into()),
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            guardian1: guardian_party(0x63, "g1-token"),
            guardian2: guardian_party(0x64, "g2-token"),
            timelock_blocks: 144,
            unlock_height: Some(900_000),
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed: sealed_setup(
                &"c".repeat(64),
                Some("aGVpcmN0".into()),
                Some("aGVpcm5u".into()),
                Some("heir-token".into()),
            ),
            from_name: None,
            heir_note: None,
        };
        let (_, created) = create_vault_guardian(State(state.clone()), Json(req))
            .await
            .expect("guardian create with unlock");
        let ext: String = sqlx::query_scalar("SELECT descriptor_external FROM vaults WHERE id = ?")
            .bind(&created.vault.id)
            .fetch_one(&state.db)
            .await
            .expect("descriptor");
        assert!(ext.contains("after(900000)"), "unlock CLTV embedded: {ext}");
        assert!(ext.contains("older(144)"), "inactivity CSV still present");
    }

    /// A guardian's claim token (#81 P4) resolves through the
    /// sealed-guardian endpoint to that guardian's sealed xprv and slot,
    /// is refused once the vault's claim is consumed, and 404s for an
    /// unknown token. The browser unwraps the returned ciphertext locally
    /// with the token, exactly like the heir's sealed-heir blob.
    #[tokio::test]
    async fn guardian_token_resolves_to_sealed_key_then_locks_after_claim() {
        ensure_test_master_key();
        let state = fresh_state().await;

        let (owner_xpub, owner_fp) = xpub_for(0x41);
        let (heir_xpub, heir_fp) = xpub_for(0x42);
        let req = CreateGuardianVaultRequest {
            label: Some("guardian".into()),
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            guardian1: guardian_party(0x43, "g1-token"),
            guardian2: guardian_party(0x44, "g2-token"),
            timelock_blocks: 144,
            unlock_height: None,
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed: sealed_setup(
                &"a".repeat(64),
                Some("aGVpcmN0".into()),
                Some("aGVpcm5u".into()),
                Some("heir-token".into()),
            ),
            from_name: None,
            heir_note: None,
        };
        let (_, created) = create_vault_guardian(State(state.clone()), Json(req))
            .await
            .expect("guardian create");
        let id = created.vault.id.clone();

        // Elapse the claim-challenge window so the sealed-key endpoints
        // don't withhold on the safety wait (same gate the heir hits).
        let long_ago = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        sqlx::query("UPDATE vaults SET claim_opened_at = ? WHERE id = ?")
            .bind(&long_ago)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("stamp claim_opened_at");

        // Guardian 1's token resolves to slot 1 + that guardian's sealed key.
        let view = crate::psbt_routes::get_sealed_guardian_xprv(
            State(state.clone()),
            axum::extract::Path("g1-token".to_string()),
        )
        .await
        .expect("g1 token resolves")
        .0;
        assert_eq!(view.vault_id, id);
        assert_eq!(view.slot, 1);
        assert_eq!(view.guardian_xprv_ct_b64, "Z3VhcmRjdA");
        assert!(view.descriptor_external.contains("or_b(pk("));

        // Guardian 2's token resolves to slot 2.
        let view2 = crate::psbt_routes::get_sealed_guardian_xprv(
            State(state.clone()),
            axum::extract::Path("g2-token".to_string()),
        )
        .await
        .expect("g2 token resolves")
        .0;
        assert_eq!(view2.slot, 2);

        // Unknown token → 404.
        let nf = crate::psbt_routes::get_sealed_guardian_xprv(
            State(state.clone()),
            axum::extract::Path("not-a-token".to_string()),
        )
        .await
        .expect_err("unknown guardian token");
        assert!(matches!(nf, ApiError::NotFound), "got {nf:?}");

        // Once the vault claim is consumed, no guardian key is handed out.
        sqlx::query("UPDATE vaults SET claim_token_used_at = ? WHERE id = ?")
            .bind(&long_ago)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("mark claim used");
        let locked = crate::psbt_routes::get_sealed_guardian_xprv(
            State(state.clone()),
            axum::extract::Path("g1-token".to_string()),
        )
        .await
        .expect_err("claim already completed");
        assert!(matches!(locked, ApiError::Conflict(_)), "got {locked:?}");
    }

    /// `GET /claim/:token` resolves both the heir's inline token and a
    /// guardian's token for a guardian vault (#81 P4b), reporting the
    /// vault kind, which party opened the link, and the guardian slot so
    /// the claim page can ask for the other party's link.
    #[tokio::test]
    async fn resolve_claim_distinguishes_heir_and_guardian_tokens() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let (owner_xpub, owner_fp) = xpub_for(0x51);
        let (heir_xpub, heir_fp) = xpub_for(0x52);
        let req = CreateGuardianVaultRequest {
            label: Some("guardian".into()),
            network: "regtest".into(),
            owner: PartyXpub {
                xpub: owner_xpub,
                fingerprint: Some(owner_fp),
            },
            heir: PartyXpub {
                xpub: heir_xpub,
                fingerprint: Some(heir_fp),
            },
            guardian1: guardian_party(0x53, "g1-token"),
            guardian2: guardian_party(0x54, "g2-token"),
            timelock_blocks: 144,
            unlock_height: None,
            checkin_period_secs: 86_400,
            grace_period_secs: 3_600,
            owner_contact: None,
            owner_contact_channel: None,
            heir_contact: Some("heir@example.com".into()),
            heir_contact_channel: Some("email".into()),
            sealed: sealed_setup(
                &"b".repeat(64),
                Some("aGVpcmN0".into()),
                Some("aGVpcm5u".into()),
                Some("heir-token".into()),
            ),
            from_name: None,
            heir_note: None,
        };
        let _ = create_vault_guardian(State(state.clone()), Json(req))
            .await
            .expect("guardian create");

        let heir = resolve_claim(
            State(state.clone()),
            axum::extract::Path("heir-token".to_string()),
        )
        .await
        .expect("heir token resolves")
        .0;
        assert_eq!(heir.vault_kind, "guardian");
        assert_eq!(heir.token_role, "heir");
        assert_eq!(heir.guardian_slot, None);

        let g2 = resolve_claim(
            State(state.clone()),
            axum::extract::Path("g2-token".to_string()),
        )
        .await
        .expect("guardian token resolves")
        .0;
        assert_eq!(g2.vault_kind, "guardian");
        assert_eq!(g2.token_role, "guardian");
        assert_eq!(g2.guardian_slot, Some(2));

        let nf = resolve_claim(
            State(state.clone()),
            axum::extract::Path("nope".to_string()),
        )
        .await
        .expect_err("unknown token");
        assert!(matches!(nf, ApiError::NotFound), "got {nf:?}");
    }

    /// The owner-only heir endpoint decrypts the sealed heir contact and
    /// intro into a profile (name, contact, channel, note).
    #[tokio::test]
    async fn get_vault_heir_returns_decrypted_profile() {
        ensure_test_master_key();
        let state = fresh_state().await;
        let id = "heir-profile-vault";
        let contact = seal_for_vault(
            id,
            br#"{"name":"Ada","contact":"ada@example.com","channel":"email"}"#,
        )
        .expect("seal contact");
        let intro = seal_for_vault(id, br#"{"from_name":"Mum","note":"For your school fees."}"#)
            .expect("seal intro");
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                heir_contact_ciphertext, heir_contact_nonce, heir_contact_channel,
                heir_intro_ciphertext, heir_intro_nonce
            ) VALUES (?, 'regtest', 'tr(a)', 'tr(b)', 144, 86400, 3600,
                      '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z', 'ok',
                      ?, ?, 'email', ?, ?)"#,
        )
        .bind(id)
        .bind(&contact.ciphertext_b64)
        .bind(&contact.nonce_b64)
        .bind(&intro.ciphertext_b64)
        .bind(&intro.nonce_b64)
        .execute(&state.db)
        .await
        .expect("insert vault");

        let view = get_vault_heir(
            OwnerAuth {
                vault_id: id.to_string(),
            },
            State(state.clone()),
        )
        .await
        .expect("heir profile")
        .0;
        assert_eq!(view.name.as_deref(), Some("Ada"));
        assert_eq!(view.contact.as_deref(), Some("ada@example.com"));
        assert_eq!(view.channel.as_deref(), Some("email"));
        assert_eq!(view.note.as_deref(), Some("For your school fees."));

        // Unknown vault → 404.
        let nf = get_vault_heir(
            OwnerAuth {
                vault_id: "nope".to_string(),
            },
            State(state.clone()),
        )
        .await
        .expect_err("unknown vault");
        assert!(matches!(nf, ApiError::NotFound), "got {nf:?}");
    }
}
