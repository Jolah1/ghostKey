//! GhostKey watch-only notifier server.
//!
//! Responsibilities (v1):
//! - Accept vault registrations (descriptors only — never keys).
//! - Track check-in deadlines.
//! - Send notifications when an owner misses a check-in and again when
//!   the on-chain timelock would expire.
//! - Expose status to heirs so they know when they can claim.
//!
//! Explicit non-responsibilities:
//! - Holding keys.
//! - Co-signing.
//! - Moving funds.

use anyhow::Result;
use clap::Parser;
use std::net::SocketAddr;
use std::sync::Arc;

mod admin;
mod analytics;
mod assist;
mod auth;
mod config;
mod crypto;
mod db;
mod demo;
mod lightning;
mod lnurl;
mod newsletter;
mod notifier;
mod price;
mod psbt_routes;
mod push;
mod rate_limit;
mod routes;
mod scheduler;
mod video_routes;

#[derive(Debug, Parser)]
#[command(name = "ghostkey-server", version, about)]
struct Args {
    /// Bind address.
    #[arg(long, env = "GHOSTKEY_BIND", default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// SQLite database URL (e.g. `sqlite://ghostkey.sqlite?mode=rwc`).
    #[arg(
        long,
        env = "DATABASE_URL",
        default_value = "sqlite://ghostkey.sqlite?mode=rwc"
    )]
    database_url: String,

    /// How often the scheduler wakes up and checks for missed deadlines.
    #[arg(long, env = "GHOSTKEY_TICK_SECS", default_value_t = 30)]
    tick_secs: u64,

    /// How often the notification worker polls for pending sends.
    /// Independent of the scheduler tick because retries / SMTP
    /// timeouts have their own cadence. Reasonable default: 15s.
    #[arg(long, env = "GHOSTKEY_NOTIF_TICK_SECS", default_value_t = 15)]
    notif_tick_secs: u64,

    /// How often the Lightning poller checks pending invoices.
    /// Only used when a Lightning provider is configured. Faster than
    /// the scheduler tick because users wait on this synchronously
    /// (they're staring at a QR code).
    #[arg(long, env = "GHOSTKEY_LN_TICK_SECS", default_value_t = 3)]
    ln_tick_secs: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    /// Lightning provider. Always present (Noop when not configured)
    /// so handlers can call it without an Option check; the provider
    /// itself reports `is_enabled()`.
    pub lightning: std::sync::Arc<dyn lightning::LightningProvider>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("ghostkey_server=info,tower_http=info,info")
            }),
        )
        .compact()
        .init();

    let args = Args::parse();

    // Fail loudly if encryption-at-rest is misconfigured. We'd rather
    // refuse to start than write plaintext heir contacts to the DB.
    crypto::ensure_master_key_loaded().map_err(|e| anyhow::anyhow!("crypto setup: {e}"))?;

    // Surface the auth-disabled escape hatch at startup so it's
    // impossible to miss in the logs. The function itself logs a
    // warning; calling it here pins the OnceLock before any request
    // can race on it.
    //
    // Belt and braces: forbid the combination of auth-disabled AND a
    // production deploy. We treat any deploy where the operator has
    // not explicitly waved the safety check (`GHOSTKEY_ALLOW_INSECURE=1`)
    // as production. The escape hatch is intended for local tests on
    // a developer's laptop and CI integration runs.
    if auth::auth_disabled()
        && std::env::var("GHOSTKEY_ALLOW_INSECURE").ok().as_deref() != Some("1")
    {
        anyhow::bail!(
            "GHOSTKEY_AUTH_DISABLED is set but GHOSTKEY_ALLOW_INSECURE is not. \
             Refusing to start: this combination disables owner authentication on \
             every vault. Unset GHOSTKEY_AUTH_DISABLED for production, or set \
             GHOSTKEY_ALLOW_INSECURE=1 if you really know what you are doing on a \
             test machine."
        );
    }

    // Probe the demo-mode flag at startup so the warning (if any)
    // appears in the boot log rather than on the first vault
    // creation. The function caches the result in a OnceLock; this
    // call pins it before any handler can race.
    let _ = demo::demo_mode();
    // Same shape for the default-network flag: pin at boot so the
    // log line lands in the startup output.
    tracing::info!(default_network = %config::default_network(), "config loaded");

    let pool = db::connect(&args.database_url).await?;

    // Lightning provider: HttpProvider talking to a sidecar (either
    // Breez or LNbits — same wire protocol) when
    // GHOSTKEY_LN_SIDECAR_URL + GHOSTKEY_LN_SIDECAR_SHARED_SECRET
    // are set, otherwise NoopProvider. build_provider() never panics.
    let lightning = lightning::build_provider().await;
    let state = Arc::new(AppState {
        db: pool.clone(),
        lightning: lightning.clone(),
    });

    // Background scheduler.
    //
    // Demo mode forces the scheduler tick down to 1 s (regardless of
    // what the operator passed on the CLI / env) so a seconds-scale
    // cadence is actually observable. We log the override so the
    // operator can see why their `GHOSTKEY_TICK_SECS=30` is being
    // ignored. The same overide is applied to the Lightning poller
    // below for the same reason.
    let sched_tick = if demo::demo_mode() {
        if args.tick_secs != demo::DEMO_SCHEDULER_TICK_SECS {
            tracing::info!(
                requested = args.tick_secs,
                effective = demo::DEMO_SCHEDULER_TICK_SECS,
                "demo mode: overriding scheduler tick"
            );
        }
        demo::DEMO_SCHEDULER_TICK_SECS
    } else {
        args.tick_secs
    };
    let sched_state = state.clone();
    tokio::spawn(async move {
        scheduler::run(sched_state, std::time::Duration::from_secs(sched_tick)).await;
    });

    // Background Lightning poller. Cheap when disabled (the first
    // check in tick_once early-returns), so we always spawn it.
    let ln_tick = if demo::demo_mode() {
        demo::DEMO_LIGHTNING_TICK_SECS
    } else {
        args.ln_tick_secs
    };
    let ln_state = state.clone();
    tokio::spawn(async move {
        lightning::run_poller(ln_state, std::time::Duration::from_secs(ln_tick)).await;
    });

    // Background notification worker. Runs on the same DB pool as
    // the scheduler. Polls every `notif_tick_secs`. Configure SMTP
    // via SMTP_HOST / SMTP_PORT / SMTP_FROM (and SMTP_USER / SMTP_PASS
    // if auth is required). When SMTP_HOST is unset the worker logs
    // a warning at startup and leaves email rows in `pending`.
    let notif_pool = pool.clone();
    tokio::spawn(async move {
        notifier::run(
            notif_pool,
            std::time::Duration::from_secs(args.notif_tick_secs),
        )
        .await;
    });

    let app = routes::router(state);

    tracing::info!(addr = %args.bind, "ghostkey-server listening");
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    // `into_make_service_with_connect_info` makes the TCP peer
    // address available via `ConnectInfo<SocketAddr>` extractors.
    // The rate-limit middleware uses it as the last-resort key when
    // neither `Fly-Client-IP` nor `X-Forwarded-For` is set.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
