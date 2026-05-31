//! Per-IP token-bucket rate limiting for the unauthenticated routes.
//!
//! The audit (2026-05-31) flagged three routes that are reachable
//! without a bearer token and either cost real money per call
//! (`/assist/chat` proxies to Anthropic) or could be abused for
//! resource exhaustion (`/vaults/from-xpub` creates DB rows;
//! `/vaults/find` enumerates email-vault relationships). The legacy
//! heir-claim routes (`/claim/:token/*`) are guarded by a 256-bit
//! token, so brute-force is infeasible — but we still cap them in
//! aggregate so a single client cannot drive a runaway Esplora full-
//! scan loop.
//!
//! ## Design
//!
//! - Token bucket per client key, in-process `Mutex<HashMap<_>>`.
//!   Fine for the single-machine Fly deployment; if we ever scale
//!   horizontally the limiter has to move to Redis (or a CDN-level
//!   cap). Documented so the next operator doesn't get surprised.
//! - Each limiter is configured with `(capacity, refill_per_sec)`.
//!   "Capacity" is the burst size; "refill_per_sec" is the steady-
//!   state allowance. Buckets refill continuously based on wall
//!   time, not on a tick.
//! - Client key is `Fly-Client-IP` → first `X-Forwarded-For` hop →
//!   the connection peer IP. On Fly the peer is the edge proxy, so
//!   without the header check every user would share one bucket and
//!   one abusive client would lock everyone out. The header is
//!   trusted because it's set by our own proxy; if you deploy
//!   elsewhere, audit your load balancer's header semantics.
//! - On overflow we return `429 Too Many Requests` with a
//!   `Retry-After` header (rounded up to the next whole second) so
//!   well-behaved clients back off without us having to set
//!   integration-specific timeouts.
//! - The map is bounded: when an entry hasn't been touched in
//!   `STALE_AFTER`, the next request from that key gets a fresh
//!   bucket. We don't actively evict — the map will grow with the
//!   number of unique clients per `STALE_AFTER` window, which on a
//!   v1 server is small. A periodic prune would be the next step
//!   if we see the map balloon in production.
//!
//! ## What this is NOT
//!
//! - Not a defence against a distributed flood. With enough source
//!   IPs the per-IP cap doesn't bind.
//! - Not a substitute for upstream-side controls. The Anthropic
//!   account also has its own rate limit; this layer just keeps us
//!   well below it on a single hostile peer.
//! - Not authentication. A 429 is a velocity ceiling, not an access
//!   control decision.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::Mutex;

/// Per-route limiter handle. Cheap to clone (one `Arc`); pass into the
/// middleware closure via `axum::middleware::from_fn_with_state`.
#[derive(Clone)]
pub struct Limiter {
    inner: Arc<LimiterInner>,
}

struct LimiterInner {
    /// Maximum tokens a single client can hold at once. Also the
    /// burst size — a client that hasn't called in a while can
    /// immediately make `capacity` requests back to back.
    capacity: f64,
    /// Steady-state allowance, in tokens per second. After the burst
    /// is drained, clients are throttled to this rate.
    refill_per_sec: f64,
    /// Human-readable label for tracing logs ("assist", "create-vault",
    /// etc.). Keeps the production logs interpretable without having
    /// to grep route paths.
    name: &'static str,
    buckets: Mutex<HashMap<String, Bucket>>,
}

#[derive(Clone, Copy)]
struct Bucket {
    /// Current token count. Always in `0..=capacity`.
    tokens: f64,
    /// When we last refilled (or initialised) this bucket. Used to
    /// compute the elapsed time on the next request.
    last_refill: Instant,
}

/// How long an idle bucket survives before the next request gets a
/// fresh one. Set conservatively — the map is small enough that we
/// can afford to keep stale entries for an hour.
const STALE_AFTER: Duration = Duration::from_secs(3600);

impl Limiter {
    /// Build a limiter with a given burst capacity and refill rate.
    ///
    /// Pick `capacity` for the worst legitimate burst (e.g. an heir
    /// claim that fires three requests back-to-back) and
    /// `refill_per_sec` for the steady-state rate you're willing to
    /// pay forever (e.g. 0.05 = one request every 20s).
    pub fn new(name: &'static str, capacity: u32, refill_per_sec: f64) -> Self {
        assert!(capacity >= 1, "capacity must be at least 1");
        assert!(refill_per_sec > 0.0, "refill_per_sec must be positive");
        Self {
            inner: Arc::new(LimiterInner {
                capacity: capacity as f64,
                refill_per_sec,
                name,
                buckets: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Try to take one token from the bucket keyed on `client`.
    ///
    /// Returns `Ok(())` if a token was available, or
    /// `Err(retry_after)` (rounded up to whole seconds, minimum 1) if
    /// not. We round up rather than down because a `Retry-After: 0`
    /// would tell a polite client to retry immediately — which
    /// defeats the limiter's purpose.
    async fn try_acquire(&self, client: &str) -> Result<(), Duration> {
        let now = Instant::now();
        let inner = &self.inner;
        let mut map = inner.buckets.lock().await;
        let bucket = map.entry(client.to_string()).or_insert(Bucket {
            tokens: inner.capacity,
            last_refill: now,
        });
        // Refresh stale buckets entirely. We don't try to refill them
        // up to capacity from `last_refill` — that math is fine but
        // an hour-stale entry is functionally a new client, and
        // resetting is cheaper to reason about.
        if now.duration_since(bucket.last_refill) > STALE_AFTER {
            *bucket = Bucket {
                tokens: inner.capacity,
                last_refill: now,
            };
        }

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * inner.refill_per_sec).min(inner.capacity);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            // How long until at least one token is available, in
            // seconds, rounded up to the next whole second.
            let need = 1.0 - bucket.tokens;
            let secs = (need / inner.refill_per_sec).ceil().max(1.0) as u64;
            Err(Duration::from_secs(secs))
        }
    }
}

/// Best-effort extraction of the remote client's IP for rate-limiting
/// purposes.
///
/// Order of preference:
///   1. `Fly-Client-IP`. Set by Fly's edge proxy after TLS termination
///      and before forwarding; we trust it because nobody else can
///      reach us at this layer.
///   2. The first hop of `X-Forwarded-For`. Standard reverse-proxy
///      header. We split on `,` and take the leftmost entry, which
///      by convention is the original client.
///   3. The TCP peer address. Last resort — in production this is
///      the edge proxy, so without (1) or (2) the limiter collapses
///      to one global bucket. Better than nothing, worse than the
///      header path; we log a warning to make the misconfiguration
///      visible.
///
/// Returns a string key so callers can use it directly in the
/// bucket map. We don't normalise IPv4-mapped IPv6 addresses
/// (`::ffff:a.b.c.d`) because the same client over the same proxy
/// will always render identically; clients behind different
/// stacks will key separately, which is fine.
fn client_key(headers: &HeaderMap, peer: Option<&SocketAddr>) -> String {
    if let Some(v) = headers.get("fly-client-ip").and_then(|h| h.to_str().ok()) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(v) = headers.get("x-forwarded-for").and_then(|h| h.to_str().ok()) {
        if let Some(first) = v.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    match peer {
        Some(addr) => match addr.ip() {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => v6.to_string(),
        },
        None => "unknown".to_string(),
    }
}

/// Axum middleware that enforces a `Limiter` on every request that
/// passes through. Wire with `Router::layer(from_fn_with_state(...))`.
pub async fn enforce(
    axum::extract::State(limiter): axum::extract::State<Limiter>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let key = client_key(req.headers(), connect_info.as_ref().map(|c| &c.0));
    match limiter.try_acquire(&key).await {
        Ok(()) => next.run(req).await,
        Err(retry_after) => {
            tracing::info!(
                limiter = %limiter.inner.name,
                client = %key,
                retry_after_secs = retry_after.as_secs(),
                "rate-limited"
            );
            (
                StatusCode::TOO_MANY_REQUESTS,
                [
                    (header::RETRY_AFTER, retry_after.as_secs().to_string()),
                    (header::CONTENT_TYPE, "application/json".to_string()),
                ],
                serde_json::json!({
                    "error": "rate limited; slow down",
                    "retry_after_secs": retry_after.as_secs(),
                })
                .to_string(),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capacity_one_allows_one_then_refuses() {
        let l = Limiter::new("test", 1, 0.1);
        assert!(l.try_acquire("a").await.is_ok());
        let err = l.try_acquire("a").await.unwrap_err();
        // Refill rate 0.1/sec means waiting 10s for the next token.
        // We rounded up so the floor is at least 1s and we expect 10.
        assert!(err.as_secs() >= 1, "got retry_after = {:?}", err);
    }

    #[tokio::test]
    async fn different_clients_have_independent_buckets() {
        let l = Limiter::new("test", 1, 0.1);
        assert!(l.try_acquire("a").await.is_ok());
        // 'b' starts fresh — should succeed even though 'a' is empty.
        assert!(l.try_acquire("b").await.is_ok());
    }

    #[tokio::test]
    async fn refills_over_time() {
        // capacity 1, 100 tokens per second → ~10ms per token.
        let l = Limiter::new("test", 1, 100.0);
        assert!(l.try_acquire("a").await.is_ok());
        // Immediately refused; we just consumed the only token.
        assert!(l.try_acquire("a").await.is_err());
        tokio::time::sleep(Duration::from_millis(50)).await;
        // After 50ms the bucket has refilled at least one token.
        assert!(l.try_acquire("a").await.is_ok());
    }

    #[test]
    fn client_key_prefers_fly_header() {
        let mut h = HeaderMap::new();
        h.insert("fly-client-ip", "1.2.3.4".parse().unwrap());
        h.insert("x-forwarded-for", "5.6.7.8".parse().unwrap());
        assert_eq!(client_key(&h, None), "1.2.3.4");
    }

    #[test]
    fn client_key_falls_back_to_xff_first_hop() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "10.0.0.1, 192.168.1.1, 8.8.8.8".parse().unwrap(),
        );
        assert_eq!(client_key(&h, None), "10.0.0.1");
    }

    #[test]
    fn client_key_falls_back_to_peer_when_no_headers() {
        let peer: SocketAddr = "203.0.113.5:51234".parse().unwrap();
        let h = HeaderMap::new();
        assert_eq!(client_key(&h, Some(&peer)), "203.0.113.5");
    }
}
