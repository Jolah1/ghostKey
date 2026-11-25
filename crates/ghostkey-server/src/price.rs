//! BTC/USD and BTC/NGN spot prices for fiat display.
//!
//! `GET /price` → `{ usd_per_btc, ngn_per_btc, fetched_at, stale }`.
//!
//! Naira comes from Quidax, a Nigerian exchange, because what bitcoin
//! trades for in Nigeria is what a saver there would actually get; it ran
//! about 6% above the official-rate figure when this was added. CoinGecko's
//! official-rate naira price is the backup. Naira is optional: if both
//! fail, `ngn_per_btc` is null and dollars still work.
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

/// Price sources, tried in order until one returns a sane value. Several
/// upstreams (CoinGecko in particular) block or rate-limit datacenter IPs,
/// so a single source is not reliable from a host like Fly. Coinbase and
/// mempool.space answer datacenter requests without a key; CoinGecko stays
/// last as a fallback. Each entry is (url, parser).
type PriceSource = (&'static str, fn(&serde_json::Value) -> Option<f64>);
const SOURCES: &[PriceSource] = &[
    (
        "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        parse_coinbase,
    ),
    ("https://mempool.space/api/v1/prices", parse_mempool),
    (
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        parse_coingecko,
    ),
];
/// Naira sources, in order: the Nigerian market rate first, then the
/// official-rate figure.
const NGN_SOURCES: &[PriceSource] = &[
    (
        "https://app.quidax.io/api/v1/markets/tickers/btcngn",
        parse_quidax,
    ),
    (
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn",
        parse_coingecko_ngn,
    ),
];
const TTL: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Coinbase: `{"data":{"amount":"62000.00","base":"BTC","currency":"USD"}}`
/// (amount is a string).
fn parse_coinbase(v: &serde_json::Value) -> Option<f64> {
    v.get("data")?.get("amount")?.as_str()?.parse().ok()
}

/// mempool.space: `{"time":..,"USD":62000,"EUR":..,..}`.
fn parse_mempool(v: &serde_json::Value) -> Option<f64> {
    v.get("USD")?.as_f64()
}

/// CoinGecko: `{"bitcoin":{"usd":62326}}`.
fn parse_coingecko(v: &serde_json::Value) -> Option<f64> {
    v.get("bitcoin")?.get("usd")?.as_f64()
}

/// Quidax: `{"status":"success","data":{"ticker":{"last":"85238089.0",..}}}`
/// (prices are strings).
fn parse_quidax(v: &serde_json::Value) -> Option<f64> {
    if v.get("status")?.as_str()? != "success" {
        return None;
    }
    v.get("data")?
        .get("ticker")?
        .get("last")?
        .as_str()?
        .parse()
        .ok()
}

/// CoinGecko: `{"bitcoin":{"ngn":80162947}}`.
fn parse_coingecko_ngn(v: &serde_json::Value) -> Option<f64> {
    v.get("bitcoin")?.get("ngn")?.as_f64()
}

struct Cached {
    usd_per_btc: f64,
    at: Instant,
    at_iso: String,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static C: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// The naira rate, cached on its own: (naira per BTC, when fetched).
fn ngn_cache() -> &'static Mutex<Option<(f64, Instant)>> {
    static C: OnceLock<Mutex<Option<(f64, Instant)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Naira per BTC: fresh from the cache, else fetched, else the last good
/// value, else None. Never fails the request: naira is a nice-to-have.
async fn ngn_per_btc() -> Option<f64> {
    let mut guard = ngn_cache().lock().await;
    if let Some((v, at)) = *guard {
        if at.elapsed() < TTL {
            return Some(v);
        }
    }
    match fetch_from(NGN_SOURCES).await {
        Ok(v) => {
            *guard = Some((v, Instant::now()));
            Some(v)
        }
        Err(e) => {
            tracing::warn!(error = %e, "naira price fetch failed");
            guard.map(|(v, _)| v)
        }
    }
}

#[derive(Serialize)]
pub struct PriceView {
    /// US dollars per 1 BTC.
    pub usd_per_btc: f64,
    /// Naira per 1 BTC at the Nigerian market rate (Quidax), or the
    /// official-rate figure if Quidax is down. Null when neither answered.
    pub ngn_per_btc: Option<f64>,
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
                ngn_per_btc: ngn_per_btc().await,
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
                ngn_per_btc: ngn_per_btc().await,
                fetched_at: at_iso,
                stale: false,
            }))
        }
        Err(e) => {
            if let Some(c) = guard.as_ref() {
                tracing::warn!(error = %e, "price fetch failed; serving stale cached value");
                Ok(Json(PriceView {
                    usd_per_btc: c.usd_per_btc,
                    ngn_per_btc: ngn_per_btc().await,
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
    fetch_from(SOURCES).await
}

/// Try each source in order until one gives a sane price.
async fn fetch_from(sources: &[PriceSource]) -> Result<f64, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        // Some upstreams reject requests without a browser-ish UA.
        .user_agent("ghostkey/0.1 (+https://www.ghostkeyapp.com)")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut errors = Vec::new();
    for (url, parse) in sources {
        match fetch_one(&client, url, *parse).await {
            Ok(usd) => return Ok(usd),
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Err(format!("all price sources failed [{}]", errors.join("; ")))
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    parse: fn(&serde_json::Value) -> Option<f64>,
) -> Result<f64, String> {
    let resp = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("upstream HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let usd = parse(&v).ok_or_else(|| "unexpected price response shape".to_string())?;
    if !usd.is_finite() || usd <= 0.0 {
        return Err(format!("nonsensical price {usd}"));
    }
    Ok(usd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quidax_last_trade_is_read() {
        // The shape Quidax answered with on 2026-11-25.
        let v = serde_json::json!({
            "status": "success",
            "message": "Successful",
            "data": {
                "at": 1795588756,
                "ticker": {"buy": "85238089.0", "sell": "85622622.0", "last": "85238089.0", "vol": "1.68798548"},
                "market": "btcngn"
            }
        });
        assert_eq!(parse_quidax(&v), Some(85_238_089.0));
        // Anything but success is no answer, so the backup is asked.
        let bad = serde_json::json!({"status": "error", "data": {"ticker": {"last": "1"}}});
        assert_eq!(parse_quidax(&bad), None);
        assert_eq!(
            parse_quidax(&serde_json::json!({"status": "success"})),
            None
        );
    }

    #[test]
    fn coingecko_naira_is_read() {
        let v = serde_json::json!({"bitcoin": {"ngn": 80162947}});
        assert_eq!(parse_coingecko_ngn(&v), Some(80_162_947.0));
        assert_eq!(
            parse_coingecko_ngn(&serde_json::json!({"bitcoin": {"usd": 1}})),
            None
        );
    }

    #[test]
    fn the_nigerian_market_rate_comes_first() {
        assert!(NGN_SOURCES[0].0.contains("quidax"));
        assert!(NGN_SOURCES[1].0.contains("vs_currencies=ngn"));
    }
}
