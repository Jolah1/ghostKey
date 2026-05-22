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

mod crypto;
mod db;
mod routes;
mod scheduler;

#[derive(Debug, Parser)]
#[command(name = "ghostkey-server", version, about)]
struct Args {
    /// Bind address.
    #[arg(long, env = "GHOSTKEY_BIND", default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// SQLite database URL (e.g. `sqlite://ghostkey.sqlite?mode=rwc`).
    #[arg(long, env = "DATABASE_URL", default_value = "sqlite://ghostkey.sqlite?mode=rwc")]
    database_url: String,

    /// How often the scheduler wakes up and checks for missed deadlines.
    #[arg(long, env = "GHOSTKEY_TICK_SECS", default_value_t = 30)]
    tick_secs: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(
                    "ghostkey_server=info,tower_http=info,info",
                )),
        )
        .compact()
        .init();

    let args = Args::parse();

    // Fail loudly if encryption-at-rest is misconfigured. We'd rather
    // refuse to start than write plaintext heir contacts to the DB.
    crypto::ensure_master_key_loaded()
        .map_err(|e| anyhow::anyhow!("crypto setup: {e}"))?;

    let pool = db::connect(&args.database_url).await?;
    let state = Arc::new(AppState { db: pool.clone() });

    // Background scheduler.
    let sched_state = state.clone();
    tokio::spawn(async move {
        scheduler::run(sched_state, std::time::Duration::from_secs(args.tick_secs)).await;
    });

    let app = routes::router(state);

    tracing::info!(addr = %args.bind, "ghostkey-server listening");
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
