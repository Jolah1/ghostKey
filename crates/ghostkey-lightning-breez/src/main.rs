//! Breez SDK Liquid sidecar for GhostKey.
//!
//! A standalone process the main `ghostkey-server` calls over
//! localhost HTTP to mint and observe Lightning invoices for owner
//! check-ins. Lives in its own crate (excluded from the GhostKey
//! workspace) because Breez SDK Liquid pins reqwest =0.12.18 and
//! cannot coexist with the rest of the project's deps.
//!
//! ## Surface
//!
//!   GET  /v1/health             → liveness + readiness
//!   POST /v1/invoice            → mint a BOLT11 for amount_sat
//!   GET  /v1/status/:hash       → query payment status by hash
//!
//! All routes (except /v1/health) require `Authorization: Bearer
//! <SHARED_SECRET>` matching the env var configured on both sides.
//!
//! ## Operational notes
//!
//! * The sidecar holds a single `LiquidSdk` instance for the lifetime
//!   of the process. Reconnecting on every request would be wasteful
//!   and would lose the in-flight payment subscription.
//! * Readiness flips to `true` after the SDK's initial sync completes.
//!   The main server should poll `/v1/health` and refuse to surface
//!   the Lightning UI to users until `ready === true`.
//! * On shutdown (SIGINT/SIGTERM) we run `sdk.disconnect()` so the
//!   Liquid wallet state is flushed to disk cleanly. Cold restarts
//!   are safe but slower (the SDK has to re-sync from chain).
//!
//! ## What this is NOT
//!
//! Not a general-purpose Lightning gateway. It only knows about
//! receiving small invoices for the GhostKey check-in flow. Sending
//! payments, on-chain operations, LNURL, BOLT12 — all available on
//! the underlying SDK, none exposed here. If you want a more general
//! sidecar, run Lexe's `lexe-sidecar` or Breez's own `breez-sdk-cli`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
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

use breez_sdk_liquid::model::{
    ConnectRequest, LiquidNetwork, ListPaymentsRequest, PaymentDetails, PaymentMethod,
    PaymentState, PaymentType, PrepareReceiveRequest, ReceiveAmount, ReceivePaymentRequest,
};
use breez_sdk_liquid::sdk::LiquidSdk;

/* -------------------------------------------------------------------------- *
 *  CLI                                                                       *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Parser)]
#[command(name = "ghostkey-lightning-breez", version, about)]
struct Args {
    /// Bind address. Default 127.0.0.1:8788 — localhost only. We
    /// strongly recommend keeping the sidecar unreachable from the
    /// public internet; the bearer auth is defence in depth.
    #[arg(long, env = "GHOSTKEY_LN_BREEZ_BIND", default_value = "127.0.0.1:8788")]
    bind: SocketAddr,

    /// Free API key from breez.technology. Required.
    #[arg(long, env = "BREEZ_API_KEY", hide_env_values = true)]
    breez_api_key: String,

    /// 12-word BIP39 seed for the Liquid wallet this sidecar
    /// operates. Required. The owner's check-in sats land in this
    /// wallet; back it up like any other Bitcoin seed.
    #[arg(long, env = "BREEZ_MNEMONIC", hide_env_values = true)]
    breez_mnemonic: String,

    /// `mainnet` or `testnet`. Defaults to testnet to match the rest
    /// of GhostKey's alpha posture.
    #[arg(long, env = "BREEZ_NETWORK", default_value = "testnet")]
    breez_network: String,

    /// Where the SDK persists its state. Must exist or be creatable
    /// by the running user. Defaults to ./breez-data.
    #[arg(long, env = "BREEZ_WORKING_DIR", default_value = "./breez-data")]
    breez_working_dir: String,

    /// Shared secret the main ghostkey-server presents on every
    /// request. We compare constant-time. Required and must be
    /// non-empty — there is no anonymous mode.
    ///
    /// Read from `GHOSTKEY_LN_SIDECAR_SHARED_SECRET`. The legacy
    /// `GHOSTKEY_LN_BREEZ_SHARED_SECRET` name is also honoured for
    /// operators upgrading from before the rename — see `main()` for
    /// the fallback. The same value goes on the main app's matching
    /// secret so the two ends agree.
    #[arg(long, env = "GHOSTKEY_LN_SIDECAR_SHARED_SECRET", hide_env_values = true)]
    shared_secret: String,
}

/* -------------------------------------------------------------------------- *
 *  State                                                                     *
 * -------------------------------------------------------------------------- */

struct AppState {
    sdk: Arc<RwLock<Option<Arc<LiquidSdk>>>>,
    shared_secret: String,
}

impl AppState {
    fn new(shared_secret: String) -> Self {
        Self {
            sdk: Arc::new(RwLock::new(None)),
            shared_secret,
        }
    }

    async fn set_sdk(&self, sdk: Arc<LiquidSdk>) {
        *self.sdk.write().await = Some(sdk);
    }

    async fn sdk(&self) -> Result<Arc<LiquidSdk>, ApiError> {
        self.sdk
            .read()
            .await
            .clone()
            .ok_or(ApiError::NotReady)
    }
}

/* -------------------------------------------------------------------------- *
 *  HTTP layer                                                                *
 * -------------------------------------------------------------------------- */

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("sdk not ready (still syncing)")]
    NotReady,
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("provider error: {0}")]
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

#[derive(Debug, Serialize)]
struct HealthBody {
    ok: bool,
    ready: bool,
    version: &'static str,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthBody> {
    let ready = state.sdk.read().await.is_some();
    Json(HealthBody {
        ok: true,
        ready,
        version: env!("CARGO_PKG_VERSION"),
    })
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

async fn create_invoice(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<InvoiceRequest>,
) -> Result<Json<InvoiceResponse>, ApiError> {
    check_auth(&headers, &state.shared_secret)?;

    if req.amount_sat == 0 {
        return Err(ApiError::BadRequest("amount_sat must be > 0".into()));
    }
    if req.description.len() > 256 {
        return Err(ApiError::BadRequest(
            "description must be 256 chars or fewer".into(),
        ));
    }

    let sdk = state.sdk().await?;

    let prep = sdk
        .prepare_receive_payment(&PrepareReceiveRequest {
            payment_method: PaymentMethod::Lightning,
            amount: Some(ReceiveAmount::Bitcoin {
                payer_amount_sat: req.amount_sat,
            }),
        })
        .await
        .map_err(|e| ApiError::Provider(format!("prepare_receive: {e}")))?;

    let resp = sdk
        .receive_payment(&ReceivePaymentRequest {
            prepare_response: prep,
            description: Some(req.description),
            use_description_hash: None,
            payer_note: None,
        })
        .await
        .map_err(|e| ApiError::Provider(format!("receive_payment: {e}")))?;

    // `destination` is the BOLT11 string for a Lightning method.
    let bolt11 = resp.destination;
    let parsed = breez_sdk_liquid::parse_invoice(&bolt11)
        .map_err(|e| ApiError::Provider(format!("parse_invoice: {e}")))?;

    let expires_at = chrono::DateTime::from_timestamp(
        parsed.timestamp.saturating_add(parsed.expiry) as i64,
        0,
    )
    .unwrap_or_else(|| Utc::now() + chrono::Duration::hours(1));

    Ok(Json(InvoiceResponse {
        bolt11,
        payment_hash: parsed.payment_hash,
        amount_sat: req.amount_sat,
        expires_at,
    }))
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    status: String,
    paid_at: Option<DateTime<Utc>>,
}

async fn invoice_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(payment_hash): Path<String>,
) -> Result<Json<StatusResponse>, ApiError> {
    check_auth(&headers, &state.shared_secret)?;

    if payment_hash.len() != 64 || !payment_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "payment_hash must be 64 hex characters".into(),
        ));
    }

    let sdk = state.sdk().await?;

    // Breez SDK 0.12 does not expose a single-payment lookup by
    // hash on its public surface, so we list and filter. The list
    // is bounded by `limit` and only contains our own receives.
    // For a server that mints ~one invoice per user per fortnight,
    // 500 is plenty of headroom; bump when actual volume warrants.
    let payments = sdk
        .list_payments(&ListPaymentsRequest {
            filters: Some(vec![PaymentType::Receive]),
            states: None,
            from_timestamp: None,
            to_timestamp: None,
            offset: None,
            limit: Some(500),
            details: None,
            sort_ascending: Some(false),
        })
        .await
        .map_err(|e| ApiError::Provider(format!("list_payments: {e}")))?;

    for p in payments {
        let matches = matches!(
            &p.details,
            PaymentDetails::Lightning { payment_hash: Some(ph), .. } if ph == &payment_hash
        );
        if !matches {
            continue;
        }
        let (status, paid_at) = match p.status {
            PaymentState::Complete => (
                "paid",
                chrono::DateTime::from_timestamp(p.timestamp as i64, 0),
            ),
            PaymentState::Failed | PaymentState::TimedOut => ("failed", None),
            _ => ("pending", None),
        };
        return Ok(Json(StatusResponse {
            status: status.into(),
            paid_at,
        }));
    }

    // Not in the recent list → still pending. The main server's own
    // expiry handling kicks in if the user never pays.
    Ok(Json(StatusResponse {
        status: "pending".into(),
        paid_at: None,
    }))
}

/* -------------------------------------------------------------------------- *
 *  Main                                                                      *
 * -------------------------------------------------------------------------- */

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new(
                    "ghostkey_lightning_breez=info,tower_http=info,info",
                )
            }),
        )
        .compact()
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

    if args.shared_secret.len() < 32 {
        anyhow::bail!(
            "GHOSTKEY_LN_SIDECAR_SHARED_SECRET must be at least 32 bytes long. \
             Generate one with: openssl rand -hex 32"
        );
    }

    let network = match args.breez_network.as_str() {
        "mainnet" => LiquidNetwork::Mainnet,
        "testnet" => LiquidNetwork::Testnet,
        other => anyhow::bail!("unknown BREEZ_NETWORK {other} (expected mainnet|testnet)"),
    };

    std::fs::create_dir_all(&args.breez_working_dir)
        .with_context(|| format!("create BREEZ_WORKING_DIR {}", args.breez_working_dir))?;

    let state = Arc::new(AppState::new(args.shared_secret.clone()));

    // Boot the SDK in a background task so the HTTP listener can come
    // up immediately and report `ready: false` on /v1/health while
    // the initial Liquid sync runs. Without this, callers see a long
    // unexplained TCP refused window after starting the binary.
    let boot_state = state.clone();
    let api_key = args.breez_api_key.clone();
    let mnemonic = args.breez_mnemonic.clone();
    let working_dir = args.breez_working_dir.clone();
    tokio::spawn(async move {
        match boot_sdk(network, api_key, mnemonic, working_dir).await {
            Ok(sdk) => {
                boot_state.set_sdk(sdk).await;
                tracing::info!("breez sdk ready");
            }
            Err(e) => {
                tracing::error!(error = ?e, "breez sdk failed to start; sidecar will keep reporting ready=false");
            }
        }
    });

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/invoice", post(create_invoice))
        .route("/v1/status/:payment_hash", get(invoice_status))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());

    tracing::info!(addr = %args.bind, "ghostkey-lightning-breez listening");
    let listener = tokio::net::TcpListener::bind(args.bind).await?;

    // Graceful shutdown so the SDK gets a chance to flush state.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state))
        .await?;

    Ok(())
}

async fn boot_sdk(
    network: LiquidNetwork,
    api_key: String,
    mnemonic: String,
    working_dir: String,
) -> Result<Arc<LiquidSdk>> {
    let mut config = LiquidSdk::default_config(network, Some(api_key))
        .map_err(|e| anyhow!("default_config: {e}"))?;
    config.working_dir = working_dir;

    let req = ConnectRequest {
        mnemonic: Some(mnemonic),
        config,
        passphrase: None,
        seed: None,
    };
    let sdk = LiquidSdk::connect(req)
        .await
        .map_err(|e| anyhow!("connect: {e}"))?;
    Ok(sdk)
}

async fn shutdown_signal(state: Arc<AppState>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received; disconnecting sdk");
    if let Some(sdk) = state.sdk.read().await.clone() {
        // Best-effort. Give it 5s then bail.
        let _ = tokio::time::timeout(Duration::from_secs(5), sdk.disconnect()).await;
    }
}
