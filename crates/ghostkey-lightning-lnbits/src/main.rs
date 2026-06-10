//! LNbits-backed sidecar for the GhostKey Lightning check-in flow.
//!
//! A drop-in alternative to `ghostkey-lightning-breez` that implements
//! the exact same three-route HTTP wire protocol the main
//! `ghostkey-server` calls:
//!
//!   GET  /v1/health             → liveness + readiness
//!   POST /v1/invoice            → mint a BOLT11 for amount_sat
//!   GET  /v1/status/:hash       → query payment status by hash
//!
//! The wire protocol is documented in
//! `crates/ghostkey-lightning-breez/README.md` ("API" section); this
//! crate implements the same surface against any LNbits instance.
//!
//! ## Why this exists
//!
//! As of 2026-05-26 the Breez SDK Liquid sidecar does not compile
//! from a clean checkout (transitive `boltz-client` vs.
//! `secp256k1_zkp` skew — see the breez crate's README). Until
//! upstream is fixed, this LNbits-backed sidecar lets an operator
//! get Lightning check-ins working in production today. The main
//! `ghostkey-server` is provider-agnostic: point its
//! `GHOSTKEY_LN_BREEZ_URL` env var at either sidecar and the
//! dashboard renders the check-in button.
//!
//! ## Operational notes
//!
//! * No on-disk state. The LNbits instance owns the wallet; this
//!   sidecar is a thin translator. Restarts are cheap and idempotent.
//! * Readiness is `true` once the first successful probe of the
//!   LNbits `/api/v1/wallet` endpoint completes. Until then `/v1/health`
//!   returns `ok:true, ready:false` and `/v1/invoice` returns 503.
//! * All routes (except `/v1/health`) require
//!   `Authorization: Bearer <SHARED_SECRET>` matching the env var
//!   configured on the main server. Constant-time compare.
//!
//! ## What this is NOT
//!
//! Not a general-purpose LNbits gateway. We only call:
//!   - POST /api/v1/payments    (mint invoice)
//!   - GET  /api/v1/payments/:hash  (query status)
//!   - GET  /api/v1/wallet      (readiness probe)
//!
//! and only with the LNbits *invoice key* (read+receive scoped),
//! never the admin key.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use clap::Parser;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;

/* -------------------------------------------------------------------------- *
 *  CLI                                                                       *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Parser)]
#[command(name = "ghostkey-lightning-lnbits", version, about)]
struct Args {
    /// Bind address. Default 127.0.0.1:8788 — localhost only. Keep
    /// the sidecar unreachable from the public internet; the bearer
    /// auth is defence in depth.
    #[arg(
        long,
        env = "GHOSTKEY_LN_LNBITS_BIND",
        default_value = "127.0.0.1:8788"
    )]
    bind: SocketAddr,

    /// Base URL of the LNbits instance, e.g.
    /// `https://legend.lnbits.com` or `https://lnbits.example.com`.
    /// We append `/api/v1/...` paths to this. No trailing slash.
    #[arg(long, env = "LNBITS_URL")]
    lnbits_url: String,

    /// LNbits invoice key (receive-only). Found in the LNbits wallet
    /// page under "Node URL, API keys and API docs → API info →
    /// Invoice/read key". Do NOT pass the admin key — this sidecar
    /// only needs to mint inbound invoices and query their status,
    /// never to send.
    #[arg(long, env = "LNBITS_INVOICE_KEY", hide_env_values = true)]
    lnbits_invoice_key: String,

    /// Shared secret the main ghostkey-server presents on every
    /// request. We compare constant-time. Required, non-empty.
    ///
    /// Read from `GHOSTKEY_LN_SIDECAR_SHARED_SECRET`. The legacy
    /// `GHOSTKEY_LN_BREEZ_SHARED_SECRET` name is also honoured for
    /// operators upgrading from before the rename — see `main()` for
    /// the fallback. The same value goes on the main app's matching
    /// secret so the two ends agree.
    #[arg(
        long,
        env = "GHOSTKEY_LN_SIDECAR_SHARED_SECRET",
        hide_env_values = true
    )]
    shared_secret: String,

    /// HTTP timeout for LNbits requests, seconds.
    #[arg(long, env = "LNBITS_TIMEOUT_SECS", default_value = "15")]
    lnbits_timeout_secs: u64,
}

/* -------------------------------------------------------------------------- *
 *  State                                                                     *
 * -------------------------------------------------------------------------- */

struct AppState {
    http: reqwest::Client,
    lnbits_url: String,
    invoice_key: String,
    shared_secret: String,
    ready: RwLock<bool>,
}

impl AppState {
    fn new(args: &Args) -> Result<Arc<Self>> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(args.lnbits_timeout_secs))
            .build()
            .context("build reqwest client")?;
        Ok(Arc::new(Self {
            http,
            lnbits_url: args.lnbits_url.trim_end_matches('/').to_string(),
            invoice_key: args.lnbits_invoice_key.clone(),
            shared_secret: args.shared_secret.clone(),
            ready: RwLock::new(false),
        }))
    }

    async fn set_ready(&self, ready: bool) {
        *self.ready.write().await = ready;
    }

    async fn is_ready(&self) -> bool {
        *self.ready.read().await
    }
}

/* -------------------------------------------------------------------------- *
 *  HTTP error layer                                                          *
 * -------------------------------------------------------------------------- */

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("sidecar not ready (lnbits unreachable on boot)")]
    NotReady,
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("lnbits error: {0}")]
    Provider(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (code, msg) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            ApiError::NotReady => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::Provider(_) => {
                tracing::error!(error = ?self, "provider error");
                (StatusCode::BAD_GATEWAY, self.to_string())
            }
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

fn check_auth(headers: &HeaderMap, shared_secret: &str) -> Result<(), ApiError> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let presented = raw
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    if presented.as_bytes().ct_eq(shared_secret.as_bytes()).into() {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

/* -------------------------------------------------------------------------- *
 *  Wire types (matching breez sidecar surface, byte-for-byte)                 *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
struct HealthBody {
    ok: bool,
    ready: bool,
    version: &'static str,
}

#[derive(Debug, Deserialize)]
struct InvoiceRequest {
    amount_sat: u64,
    description: String,
}

#[derive(Debug, Serialize)]
struct InvoiceResponse {
    bolt11: String,
    payment_hash: String,
    amount_sat: u64,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    status: String,
    paid_at: Option<DateTime<Utc>>,
}

/* -------------------------------------------------------------------------- *
 *  LNbits client                                                             *
 * -------------------------------------------------------------------------- */

/// LNbits `POST /api/v1/payments` request body for an inbound invoice.
#[derive(Debug, Serialize)]
struct LnbitsCreateInvoiceReq<'a> {
    out: bool,
    amount: u64,
    memo: &'a str,
    /// LNbits accepts an expiry in seconds; default is ~24h. We set
    /// 3600 (1h) to match the BOLT11 standard and the main server's
    /// polling assumption.
    expiry: u32,
}

/// LNbits `POST /api/v1/payments` response. Older LNbits names the
/// invoice `payment_request`; v1.x serialises the full Payment model,
/// which carries `bolt11` AND a `payment_request: null` side by side.
/// That dual presence is why this must be two independent optional
/// fields: the previous `#[serde(alias = "bolt11")]` approach made
/// serde treat them as the same field, and v1.5.4's `payment_request:
/// null` next to `bolt11: "lnbc…"` blew up as a duplicate — every
/// invoice failed to decode even though LNbits returned 201.
#[derive(Debug, Deserialize)]
struct LnbitsCreateInvoiceResp {
    payment_hash: String,
    #[serde(default)]
    bolt11: Option<String>,
    #[serde(default)]
    payment_request: Option<String>,
}

impl LnbitsCreateInvoiceResp {
    /// The BOLT11 invoice, wherever this LNbits version put it.
    fn invoice(self) -> Option<String> {
        self.bolt11
            .filter(|s| !s.is_empty())
            .or(self.payment_request.filter(|s| !s.is_empty()))
    }
}

/// LNbits `GET /api/v1/payments/:hash` is shaped slightly differently
/// across versions. We deserialise the union of fields we care about
/// and decide `paid` by precedence:
///   1. `status == "success"` (newest)
///   2. `paid == true`        (legacy boolean fallback)
///
/// Anything else is `pending` (or `failed` on explicit failure).
#[derive(Debug, Deserialize)]
struct LnbitsStatusResp {
    #[serde(default)]
    paid: Option<bool>,
    #[serde(default)]
    status: Option<String>,
    /// Time the invoice was paid. Depending on the LNbits version
    /// this arrives as epoch *seconds*, epoch *milliseconds*, or
    /// (v1.x Payment model) an ISO-8601 datetime string. We coerce
    /// defensively in `interpret`.
    #[serde(default)]
    time: Option<LnbitsTime>,
}

/// The three shapes LNbits has used for `Payment.time` across
/// versions. `untagged` tries each in order against the raw JSON.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LnbitsTime {
    Epoch(i64),
    Iso(String),
}

async fn lnbits_probe(state: &AppState) -> anyhow::Result<()> {
    let url = format!("{}/api/v1/wallet", state.lnbits_url);
    let resp = state
        .http
        .get(&url)
        .header("X-Api-Key", &state.invoice_key)
        .send()
        .await?
        .error_for_status()?;

    // LNbits's first-install wizard 307-redirects every API path to
    // GET /first_install (an HTML page that returns 200) until an
    // admin user has been created. reqwest follows the redirect by
    // default, so plain status-code checking would happily report
    // ready — a false positive that lets `POST /api/v1/payments`
    // through to the same redirect chain, which then 405s because
    // /first_install accepts only PUT. Detect the install page by
    // its content type or its final URL so we surface this case
    // instead of pretending the sidecar is healthy.
    let final_path = resp.url().path().to_string();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if final_path.contains("/first_install") || ct.starts_with("text/html") {
        anyhow::bail!(
            "lnbits is stuck on the first-install wizard; complete /first_install \
             (or set LNBITS_ADMIN_PASSWORD on the lnbits app so start.sh can do it) \
             before invoices will mint"
        );
    }
    Ok(())
}

async fn lnbits_create_invoice(
    state: &AppState,
    amount_sat: u64,
    memo: &str,
) -> Result<LnbitsCreateInvoiceResp, ApiError> {
    let url = format!("{}/api/v1/payments", state.lnbits_url);
    let body = LnbitsCreateInvoiceReq {
        out: false,
        amount: amount_sat,
        memo,
        expiry: 3600,
    };
    let resp = state
        .http
        .post(&url)
        .header("X-Api-Key", &state.invoice_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Provider(format!("lnbits POST /payments: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(ApiError::Provider(format!("lnbits {code}: {text}")));
    }
    resp.json::<LnbitsCreateInvoiceResp>()
        .await
        .map_err(|e| ApiError::Provider(format!("decode lnbits create-invoice: {e}")))
}

async fn lnbits_get_status(
    state: &AppState,
    payment_hash: &str,
) -> Result<LnbitsStatusResp, ApiError> {
    let url = format!("{}/api/v1/payments/{}", state.lnbits_url, payment_hash);
    let resp = state
        .http
        .get(&url)
        .header("X-Api-Key", &state.invoice_key)
        .send()
        .await
        .map_err(|e| ApiError::Provider(format!("lnbits GET /payments/:hash: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(ApiError::Provider(format!("lnbits {code}: {text}")));
    }
    resp.json::<LnbitsStatusResp>()
        .await
        .map_err(|e| ApiError::Provider(format!("decode lnbits status: {e}")))
}

/// Coerce LNbits' multi-version response into the wire status. LNbits
/// returns timestamps as seconds, milliseconds, or an ISO-8601 string
/// depending on the version; for the numeric forms we treat anything
/// above ~year-2200-in-seconds as already-ms and divide.
fn interpret(r: &LnbitsStatusResp) -> StatusResponse {
    let paid = matches!(r.status.as_deref(), Some("success")) || matches!(r.paid, Some(true));
    let failed = matches!(r.status.as_deref(), Some("failed"));

    let status = if paid {
        "paid"
    } else if failed {
        "failed"
    } else {
        "pending"
    };

    let paid_at = if paid {
        r.time.as_ref().map(|t| match t {
            LnbitsTime::Epoch(raw) => {
                let secs = if *raw > 7_258_118_400 {
                    raw / 1000
                } else {
                    *raw
                };
                DateTime::from_timestamp(secs, 0).unwrap_or_else(Utc::now)
            }
            LnbitsTime::Iso(s) => DateTime::parse_from_rfc3339(s)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
    } else {
        None
    };

    StatusResponse {
        status: status.to_string(),
        paid_at,
    }
}

/* -------------------------------------------------------------------------- *
 *  Handlers                                                                  *
 * -------------------------------------------------------------------------- */

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthBody> {
    Json(HealthBody {
        ok: true,
        ready: state.is_ready().await,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_invoice(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<InvoiceRequest>,
) -> Result<Json<InvoiceResponse>, ApiError> {
    check_auth(&headers, &state.shared_secret)?;

    if !state.is_ready().await {
        return Err(ApiError::NotReady);
    }
    if req.amount_sat == 0 {
        return Err(ApiError::BadRequest("amount_sat must be > 0".into()));
    }
    if req.description.len() > 256 {
        return Err(ApiError::BadRequest(
            "description must be 256 chars or fewer".into(),
        ));
    }

    let resp = lnbits_create_invoice(&state, req.amount_sat, &req.description).await?;

    // LNbits' create-invoice response does not include the BOLT11
    // expiry timestamp directly. We requested expiry=3600 above, so
    // expires_at = now + 1h is correct within a few seconds. The main
    // server treats expires_at as advisory; off-by-a-few-seconds is
    // fine.
    let expires_at = Utc::now() + chrono::Duration::hours(1);

    let payment_hash = resp.payment_hash.clone();
    let bolt11 = resp.invoice().ok_or_else(|| {
        ApiError::Provider(
            "lnbits create-invoice response carried neither bolt11 nor payment_request".into(),
        )
    })?;

    Ok(Json(InvoiceResponse {
        bolt11,
        payment_hash,
        amount_sat: req.amount_sat,
        expires_at,
    }))
}

async fn invoice_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(payment_hash): Path<String>,
) -> Result<Json<StatusResponse>, ApiError> {
    check_auth(&headers, &state.shared_secret)?;

    if !state.is_ready().await {
        return Err(ApiError::NotReady);
    }
    if payment_hash.len() != 64 || !payment_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "payment_hash must be 64 hex characters".into(),
        ));
    }

    let raw = lnbits_get_status(&state, &payment_hash).await?;
    Ok(Json(interpret(&raw)))
}

/* -------------------------------------------------------------------------- *
 *  main                                                                      *
 * -------------------------------------------------------------------------- */

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ghostkey_lightning_lnbits=info,info".into()),
        )
        .init();

    // Pre-clap shim: if the operator still has the legacy
    // GHOSTKEY_LN_BREEZ_SHARED_SECRET set but hasn't moved to the new
    // GHOSTKEY_LN_SIDECAR_SHARED_SECRET name yet, copy it across so
    // clap's `env =` lookup finds something. This runs before any
    // threads are spawned, so the unsafe set_var is sound.
    if std::env::var_os("GHOSTKEY_LN_SIDECAR_SHARED_SECRET").is_none() {
        if let Some(legacy) = std::env::var_os("GHOSTKEY_LN_BREEZ_SHARED_SECRET") {
            eprintln!(
                "warning: GHOSTKEY_LN_BREEZ_SHARED_SECRET is deprecated; \
                 rename it to GHOSTKEY_LN_SIDECAR_SHARED_SECRET"
            );
            // SAFETY: process startup, no other threads exist yet.
            unsafe { std::env::set_var("GHOSTKEY_LN_SIDECAR_SHARED_SECRET", legacy) };
        }
    }

    let args = Args::parse();
    if args.shared_secret.is_empty() {
        anyhow::bail!("GHOSTKEY_LN_SIDECAR_SHARED_SECRET must be non-empty");
    }
    if args.lnbits_invoice_key.is_empty() {
        anyhow::bail!("LNBITS_INVOICE_KEY must be non-empty");
    }

    let state = AppState::new(&args)?;

    // Readiness probe in a background task. The HTTP listener comes up
    // immediately so health checks don't time out during boot; the
    // probe flips `ready` once LNbits is reachable. If LNbits is down
    // at boot we keep retrying every 5s — the main server polls our
    // /v1/health, so it'll pick up the readiness flip without restart.
    let probe_state = state.clone();
    tokio::spawn(async move {
        loop {
            let backoff = match lnbits_probe(&probe_state).await {
                Ok(()) => {
                    if !probe_state.is_ready().await {
                        tracing::info!("lnbits reachable; flipping ready=true");
                    }
                    probe_state.set_ready(true).await;
                    Duration::from_secs(30)
                }
                Err(e) => {
                    if probe_state.is_ready().await {
                        tracing::warn!(error = %e, "lnbits probe failed; flipping ready=false");
                    } else {
                        tracing::debug!(error = %e, "lnbits probe failed");
                    }
                    probe_state.set_ready(false).await;
                    Duration::from_secs(5)
                }
            };
            tokio::time::sleep(backoff).await;
        }
    });

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/invoice", post(create_invoice))
        .route("/v1/status/:hash", get(invoice_status))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    tracing::info!(addr = %args.bind, lnbits = %args.lnbits_url, "ghostkey-lightning-lnbits listening");
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            s.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term   => {},
    }
    tracing::info!("shutdown signal received");
}

/* -------------------------------------------------------------------------- *
 *  tests                                                                     *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn mkresp(status: Option<&str>, paid: Option<bool>, time: Option<i64>) -> LnbitsStatusResp {
        LnbitsStatusResp {
            paid,
            status: status.map(|s| s.into()),
            time: time.map(LnbitsTime::Epoch),
        }
    }

    #[test]
    fn interpret_success_status_wins() {
        let r = mkresp(Some("success"), None, Some(1_700_000_000));
        let s = interpret(&r);
        assert_eq!(s.status, "paid");
        assert!(s.paid_at.is_some());
    }

    #[test]
    fn interpret_legacy_paid_true() {
        let r = mkresp(None, Some(true), Some(1_700_000_000));
        let s = interpret(&r);
        assert_eq!(s.status, "paid");
        assert!(s.paid_at.is_some());
    }

    #[test]
    fn interpret_failed() {
        let r = mkresp(Some("failed"), None, None);
        let s = interpret(&r);
        assert_eq!(s.status, "failed");
        assert!(s.paid_at.is_none());
    }

    #[test]
    fn interpret_pending() {
        let r = mkresp(Some("pending"), Some(false), None);
        let s = interpret(&r);
        assert_eq!(s.status, "pending");
        assert!(s.paid_at.is_none());
    }

    #[test]
    fn interpret_millisecond_time() {
        // anything above year 2200 in seconds is treated as ms.
        let r = mkresp(Some("success"), None, Some(1_700_000_000_000));
        let s = interpret(&r);
        assert_eq!(s.status, "paid");
        let ts = s.paid_at.unwrap().timestamp();
        // 1.7e12 ms == 1.7e9 s, give or take.
        assert_eq!(ts, 1_700_000_000);
    }

    /// LNbits v1.5.4 serialises the whole Payment model: `bolt11`
    /// holds the invoice while `payment_request` rides along as
    /// null. This exact shape is what broke production on
    /// 2026-06-09 — keep it byte-shaped like the real response.
    #[test]
    fn create_invoice_decodes_v1_payment_model() {
        let json = r#"{
            "checking_id": "abc",
            "payment_hash": "deadbeef",
            "wallet_id": "w1",
            "amount": 1000,
            "fee": 0,
            "bolt11": "lnbc10n1realinvoice",
            "payment_request": null,
            "status": "pending",
            "memo": "GhostKey check-in",
            "expiry": "2026-06-10T10:42:39.000000+00:00",
            "time": "2026-06-10T09:42:39.000000+00:00",
            "created_at": "2026-06-10T09:42:39.000000+00:00",
            "updated_at": "2026-06-10T09:42:39.000000+00:00",
            "extra": {}
        }"#;
        let resp: LnbitsCreateInvoiceResp = serde_json::from_str(json).expect("v1.5.4 decodes");
        assert_eq!(resp.payment_hash, "deadbeef");
        assert_eq!(resp.invoice().as_deref(), Some("lnbc10n1realinvoice"));
    }

    /// Pre-1.0 LNbits: `payment_request` only, no `bolt11` key.
    #[test]
    fn create_invoice_decodes_legacy_shape() {
        let json = r#"{
            "payment_hash": "deadbeef",
            "payment_request": "lnbc10n1legacyinvoice",
            "checking_id": "abc"
        }"#;
        let resp: LnbitsCreateInvoiceResp = serde_json::from_str(json).expect("legacy decodes");
        assert_eq!(resp.invoice().as_deref(), Some("lnbc10n1legacyinvoice"));
    }

    /// Neither field present (or both empty) must surface as None so
    /// the handler can 502 with a useful message instead of shipping
    /// an empty bolt11 to the wallet.
    #[test]
    fn create_invoice_without_any_invoice_is_none() {
        let json = r#"{"payment_hash": "deadbeef", "payment_request": ""}"#;
        let resp: LnbitsCreateInvoiceResp = serde_json::from_str(json).expect("shape decodes");
        assert!(resp.invoice().is_none());
    }

    /// v1.x status responses carry `time` as an ISO-8601 string; the
    /// paid timestamp must parse rather than fall back to now().
    #[test]
    fn interpret_iso_time() {
        let json = r#"{"status": "success", "time": "2026-06-10T09:42:39.000000+00:00"}"#;
        let r: LnbitsStatusResp = serde_json::from_str(json).expect("iso time decodes");
        let s = interpret(&r);
        assert_eq!(s.status, "paid");
        let ts = s.paid_at.expect("paid_at set").timestamp();
        assert_eq!(ts, 1_781_084_559);
    }

    #[test]
    fn auth_constant_time_rejects_wrong() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(check_auth(&h, "right").is_err());
    }

    #[test]
    fn auth_constant_time_accepts_right() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer right".parse().unwrap());
        assert!(check_auth(&h, "right").is_ok());
    }

    #[test]
    fn auth_rejects_empty_after_bearer() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer ".parse().unwrap());
        assert!(check_auth(&h, "right").is_err());
    }
}
