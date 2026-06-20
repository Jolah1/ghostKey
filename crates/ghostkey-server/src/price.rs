//! BTC/USD spot price for fiat display.
//!
//! `GET /price` → `{ usd_per_btc, fetched_at, stale }`.
//!
//! Fetched from a public price API and cached in-memory (5 min TTL).
//! Doing the fetch server-side, rather than from each visitor's browser,
//! keeps our users from being exposed to the upstream and stops us from
//! hammering it. USD only; the web renders sats, BTC, and the USD
//! estimate. The estimate is best-effort: if a refresh fails we serve
//! the last good value flagged `stale`, and if we have nothing cached we
//! answer 503 so the UI just hides the fiat line rather than showing a
//! wrong number.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use tokio::sync::Mutex;

const SOURCE: &str = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
const TTL: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

struct Cached {
    usd_per_btc: f64,
    at: Instant,
    at_iso: String,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static C: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize)]
pub struct PriceView {
    /// US dollars per 1 BTC.
    pub usd_per_btc: f64,
    /// RFC3339 time the rate was fetched upstream.
    pub fetched_at: String,
    /// True when we're serving a cached value past its TTL because a
    /// fresh fetch failed. The UI can show the estimate more cautiously.
    pub stale: bool,
}

pub async fn get_price() -> Result<Json<PriceView>, (StatusCode, String)> {
    // Hold the lock across the fetch so concurrent callers on a cold/expired
    // cache don't all hit the upstream at once.
    let mut guard = cache().lock().await;

    if let Some(c) = guard.as_ref() {
        if c.at.elapsed() < TTL {
            return Ok(Json(PriceView {
                usd_per_btc: c.usd_per_btc,
                fetched_at: c.at_iso.clone(),
                stale: false,
            }));
        }
    }

    match fetch().await {
        Ok(usd) => {
            let at_iso = chrono::Utc::now().to_rfc3339();
            *guard = Some(Cached {
                usd_per_btc: usd,
                at: Instant::now(),
                at_iso: at_iso.clone(),
            });
            Ok(Json(PriceView {
                usd_per_btc: usd,
                fetched_at: at_iso,
                stale: false,
            }))
        }
        Err(e) => {
            if let Some(c) = guard.as_ref() {
                tracing::warn!(error = %e, "price fetch failed; serving stale cached value");
                Ok(Json(PriceView {
                    usd_per_btc: c.usd_per_btc,
                    fetched_at: c.at_iso.clone(),
                    stale: true,
                }))
            } else {
                tracing::warn!(error = %e, "price fetch failed and no cached value");
                Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "price temporarily unavailable".into(),
                ))
            }
        }
    }
}

async fn fetch() -> Result<f64, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(SOURCE)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("upstream HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let usd = v
        .get("bitcoin")
        .and_then(|b| b.get("usd"))
        .and_then(|u| u.as_f64())
        .ok_or_else(|| "unexpected price response shape".to_string())?;
    if !usd.is_finite() || usd <= 0.0 {
        return Err(format!("nonsensical price {usd}"));
    }
    Ok(usd)
}
