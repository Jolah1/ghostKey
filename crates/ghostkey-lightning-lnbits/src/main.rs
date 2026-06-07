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
    #[arg(long, env = "GHOSTKEY_LN_LNBITS_BIND", default_value = "127.0.0.1:8788")]
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
    #[arg(long, env = "GHOSTKEY_LN_SIDECAR_SHARED_SECRET", hide_env_values = true)]
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
    if presented
        .as_bytes()
        .ct_eq(shared_secret.as_bytes())
        .into()
    {
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

/// LNbits `POST /api/v1/payments` response. Older LNbits names
/// `payment_request`; newer instances ship `bolt11` alongside. We
/// accept both via `serde(alias)`.
#[derive(Debug, Deserialize)]
struct LnbitsCreateInvoiceResp {
    payment_hash: String,
    #[serde(alias = "bolt11")]
    payment_request: String,
}

/// LNbits `GET /api/v1/payments/:hash` is shaped slightly differently
/// across versions. We deserialise the union of fields we care about
/// and decide `paid` by precedence:
///   1. `status == "success"` (newest)
///   2. `paid == true`        (legacy boolean fallback)
/// Anything else is `pending` (or `failed` on explicit failure).
#[derive(Debug, Deserialize)]
struct LnbitsStatusResp {
    #[serde(default)]
    paid: Option<bool>,
    #[serde(default)]
    status: Option<String>,
    /// Time the invoice was paid, in *seconds* (some versions) or
    /// *milliseconds* (newer). We coerce defensively in `interpret`.
    #[serde(default)]
    time: Option<i64>,
}

async fn lnbits_probe(state: &AppState) -> Result<(), reqwest::Error> {
    let url = format!("{}/api/v1/wallet", state.lnbits_url);
    state
        .http
        .get(&url)
        .header("X-Api-Key", &state.invoice_key)
        .send()
        .await?
        .error_for_status()
        .map(|_| ())
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
/// returns timestamps as seconds *or* milliseconds depending on the
/// version; we treat anything above ~year-2200-in-seconds as already-ms
/// and divide. Anything below stays as seconds.
fn interpret(r: &LnbitsStatusResp) -> StatusResponse {
    let paid = matches!(r.status.as_deref(), Some("success"))
        || matches!(r.paid, Some(true));
    let failed = matches!(r.status.as_deref(), Some("failed"));

    let status = if paid {
        "paid"
    } else if failed {
        "failed"
    } else {
        "pending"
    };

    let paid_at = if paid {
        r.time.map(|t| {
            let secs = if t > 7_258_118_400 { t / 1000 } else { t };
            DateTime::from_timestamp(secs, 0).unwrap_or_else(Utc::now)
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

    Ok(Json(InvoiceResponse {
        bolt11: resp.payment_request,
        payment_hash: resp.payment_hash,
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
            time,
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
