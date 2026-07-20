//! Per-IP token-bucket rate limiting for the unauthenticated routes.
//!
//! The audit (2026-05-31) flagged three routes that are reachable
//! without a bearer token and either cost real money per call
//! (`/assist/chat` proxies to Anthropic) or could be abused for
//! resource exhaustion (`/vaults/from-xpub` creates DB rows and
//! recovery requests can generate email). The legacy
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
//! - Forwarding headers are accepted only when the immediate TCP peer
//!   matches `GHOSTKEY_TRUSTED_PROXY_CIDRS`. `Fly-Client-IP` must parse
//!   as an IP. XFF is walked right-to-left, stripping trusted proxy
//!   hops. Otherwise the TCP peer IP is the key.
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
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use ipnet::IpNet;
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
    trusted_proxies: TrustedProxies,
    buckets: Mutex<HashMap<String, Bucket>>,
}

#[derive(Clone, Default)]
struct TrustedProxies {
    networks: Arc<Vec<IpNet>>,
}

static TRUSTED_PROXIES: OnceLock<TrustedProxies> = OnceLock::new();

impl TrustedProxies {
    fn from_env() -> Self {
        let Ok(raw) = std::env::var("GHOSTKEY_TRUSTED_PROXY_CIDRS") else {
            tracing::warn!(
                "GHOSTKEY_TRUSTED_PROXY_CIDRS is unset; forwarding headers will be ignored"
            );
            return Self::default();
        };
        if raw.trim().is_empty() {
            tracing::warn!(
                "GHOSTKEY_TRUSTED_PROXY_CIDRS is empty; forwarding headers will be ignored"
            );
            return Self::default();
        }
        let mut networks = Vec::new();
        for item in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match item.parse::<IpNet>() {
                Ok(network) => networks.push(network),
                Err(error) => {
                    tracing::error!(
                        value = item,
                        %error,
                        "invalid GHOSTKEY_TRUSTED_PROXY_CIDRS entry; ignoring all forwarding headers"
                    );
                    return Self::default();
                }
            }
        }
        tracing::info!(
            count = networks.len(),
            "trusted proxy CIDRs loaded for client-IP resolution"
        );
        Self {
            networks: Arc::new(networks),
        }
    }

    fn contains(&self, ip: IpAddr) -> bool {
        self.networks.iter().any(|network| network.contains(&ip))
    }
}

fn trusted_proxies_from_env() -> TrustedProxies {
    TRUSTED_PROXIES
        .get_or_init(TrustedProxies::from_env)
        .clone()
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
                trusted_proxies: trusted_proxies_from_env(),
                buckets: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Build a limiter whose `(capacity, refill_per_sec)` come from
    /// environment variables, falling back to the supplied defaults
    /// when unset, unparseable, or out of range.
    ///
    /// Reads `<env_prefix>_BURST` (parsed as `u32`) and
    /// `<env_prefix>_PER_SEC` (parsed as `f64`). For example,
    /// `from_env("assist", "GHOSTKEY_RL_ASSIST", 3, 0.2)` looks at
    /// `GHOSTKEY_RL_ASSIST_BURST` and `GHOSTKEY_RL_ASSIST_PER_SEC`.
    ///
    /// A bad value logs a warning and uses the default rather than
    /// panicking. A fat-fingered env var should not take the server
    /// offline; the default is always safe.
    pub fn from_env(
        name: &'static str,
        env_prefix: &str,
        default_capacity: u32,
        default_refill_per_sec: f64,
    ) -> Self {
        let burst_var = format!("{env_prefix}_BURST");
        let per_sec_var = format!("{env_prefix}_PER_SEC");

        let capacity = parse_env_or(&burst_var, default_capacity, |v| *v >= 1);
        let refill_per_sec = parse_env_or(&per_sec_var, default_refill_per_sec, |v| *v > 0.0);

        tracing::info!(
            limiter = name,
            capacity,
            refill_per_sec,
            burst_env = %burst_var,
            per_sec_env = %per_sec_var,
            "rate-limit config"
        );
        Self::new(name, capacity, refill_per_sec)
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

/// Parse `name` from the environment with a default fallback and a
/// validity predicate. Used by `Limiter::from_env` so a bad
/// `GHOSTKEY_RL_*` value logs a warning and uses the default rather
/// than panicking. `T: Display` so the warning prints the bad value.
fn parse_env_or<T>(name: &str, default: T, valid: impl Fn(&T) -> bool) -> T
where
    T: std::str::FromStr + std::fmt::Display + Copy,
{
    let Ok(raw) = std::env::var(name) else {
        return default;
    };
    match raw.parse::<T>() {
        Ok(v) if valid(&v) => v,
        Ok(v) => {
            tracing::warn!(
                env_var = name,
                value = %v,
                default = %default,
                "rate-limit env var out of range; using default"
            );
            default
        }
        Err(_) => {
            tracing::warn!(
                env_var = name,
                raw = %raw,
                default = %default,
                "rate-limit env var unparseable; using default"
            );
            default
        }
    }
}

/// Best-effort extraction of the remote client's IP for rate-limiting
/// purposes.
///
/// Forwarding headers are considered only when the immediate TCP peer
/// belongs to `GHOSTKEY_TRUSTED_PROXY_CIDRS`. For a trusted peer,
/// `Fly-Client-IP` is preferred when it is a valid IP; otherwise XFF
/// is walked right-to-left and trusted proxy hops are removed. For an
/// untrusted peer, or when no usable header remains, the TCP peer is
/// the key.
///
/// Returns a string key so callers can use it directly in the
/// bucket map. We don't normalise IPv4-mapped IPv6 addresses
/// (`::ffff:a.b.c.d`) because the same client over the same proxy
/// will always render identically; clients behind different
/// stacks will key separately, which is fine.
fn client_key(
    headers: &HeaderMap,
    peer: Option<&SocketAddr>,
    trusted_proxies: &TrustedProxies,
) -> String {
    let peer_ip = peer.map(|addr| addr.ip());
    if peer_ip.is_some_and(|ip| trusted_proxies.contains(ip)) {
        if let Some(ip) = headers
            .get("fly-client-ip")
            .and_then(|h| h.to_str().ok())
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
        {
            return ip.to_string();
        }
        if let Some(value) = headers.get("x-forwarded-for").and_then(|h| h.to_str().ok()) {
            // Walk from the trusted edge back toward the client. Trusted
            // proxy hops are stripped; the first untrusted address is the
            // effective client. This resists a client prepending spoofed
            // leftmost values when a proxy appends the real address.
            for ip in value
                .split(',')
                .rev()
                .filter_map(|part| part.trim().parse::<IpAddr>().ok())
            {
                if !trusted_proxies.contains(ip) {
                    return ip.to_string();
                }
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
    let key = client_key(
        req.headers(),
        connect_info.as_ref().map(|c| &c.0),
        &limiter.inner.trusted_proxies,
    );
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

    fn trusted(cidr: &str) -> TrustedProxies {
        TrustedProxies {
            networks: Arc::new(vec![cidr.parse().unwrap()]),
        }
    }

    #[test]
    fn trusted_peer_prefers_valid_fly_header() {
        let mut h = HeaderMap::new();
        h.insert("fly-client-ip", "1.2.3.4".parse().unwrap());
        h.insert("x-forwarded-for", "5.6.7.8".parse().unwrap());
        let peer: SocketAddr = "10.1.2.3:443".parse().unwrap();
        assert_eq!(
            client_key(&h, Some(&peer), &trusted("10.0.0.0/8")),
            "1.2.3.4"
        );
    }

    #[test]
    fn xff_walks_from_right_and_ignores_spoofed_leftmost_value() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "6.6.6.6, 203.0.113.9, 10.2.3.4".parse().unwrap(),
        );
        let peer: SocketAddr = "10.1.2.3:443".parse().unwrap();
        assert_eq!(
            client_key(&h, Some(&peer), &trusted("10.0.0.0/8")),
            "203.0.113.9"
        );
    }

    #[test]
    fn untrusted_peer_cannot_spoof_forwarding_headers() {
        let mut h = HeaderMap::new();
        h.insert("fly-client-ip", "1.2.3.4".parse().unwrap());
        h.insert("x-forwarded-for", "5.6.7.8".parse().unwrap());
        let peer: SocketAddr = "198.51.100.7:51234".parse().unwrap();
        assert_eq!(
            client_key(&h, Some(&peer), &trusted("10.0.0.0/8")),
            "198.51.100.7"
        );
    }

    #[test]
    fn malformed_forwarding_headers_fall_back_to_peer() {
        let mut h = HeaderMap::new();
        h.insert("fly-client-ip", "not-an-ip".parse().unwrap());
        h.insert("x-forwarded-for", "also-bad".parse().unwrap());
        let peer: SocketAddr = "10.1.2.3:443".parse().unwrap();
        assert_eq!(
            client_key(&h, Some(&peer), &trusted("10.0.0.0/8")),
            "10.1.2.3"
        );
    }

    #[test]
    fn client_key_falls_back_to_peer_when_no_headers() {
        let peer: SocketAddr = "203.0.113.5:51234".parse().unwrap();
        let h = HeaderMap::new();
        assert_eq!(
            client_key(&h, Some(&peer), &TrustedProxies::default()),
            "203.0.113.5"
        );
    }

    // These tests touch `std::env`, which is process-global. We use
    // uniquely-named env vars per test so concurrent execution under
    // `cargo test` doesn't race.

    #[test]
    fn parse_env_or_uses_default_when_unset() {
        std::env::remove_var("GK_RL_TEST_UNSET");
        let v: u32 = parse_env_or("GK_RL_TEST_UNSET", 7, |x| *x >= 1);
        assert_eq!(v, 7);
    }

    #[test]
    fn parse_env_or_parses_valid_value() {
        std::env::set_var("GK_RL_TEST_VALID", "42");
        let v: u32 = parse_env_or("GK_RL_TEST_VALID", 7, |x| *x >= 1);
        std::env::remove_var("GK_RL_TEST_VALID");
        assert_eq!(v, 42);
    }

    #[test]
    fn parse_env_or_rejects_unparseable_value() {
        std::env::set_var("GK_RL_TEST_BAD", "not-a-number");
        let v: u32 = parse_env_or("GK_RL_TEST_BAD", 9, |x| *x >= 1);
        std::env::remove_var("GK_RL_TEST_BAD");
        assert_eq!(v, 9);
    }

    #[test]
    fn parse_env_or_rejects_out_of_range_value() {
        std::env::set_var("GK_RL_TEST_ZERO", "0");
        let v: u32 = parse_env_or("GK_RL_TEST_ZERO", 5, |x| *x >= 1);
        std::env::remove_var("GK_RL_TEST_ZERO");
        assert_eq!(v, 5);
    }
}
