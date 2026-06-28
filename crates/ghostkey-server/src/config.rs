//! Process-wide configuration knobs that don't belong to any one
//! subsystem.
//!
//! Lives next to [`crate::demo`] (which holds the demo-mode flag)
//! and [`crate::auth`] (which holds the auth-disabled flag). The
//! same shape: a single env var, read once via `OnceLock`, cached
//! for the process lifetime, logged on first access so an operator
//! mistake is unmissable in the boot log.
//!
//! ## What lives here
//!
//! - [`default_network`]: which Bitcoin network the web UI should
//!   default new vaults to. Lets a single web bundle work against a
//!   testnet server, a signet server, or a regtest server without
//!   any rebuild — the server tells the browser which network it's
//!   on via `/health.default_network`.

use bitcoin::Network;
use chrono::{DateTime, Utc};
use std::sync::OnceLock;

/// Parse an RFC3339 timestamp string, falling back to `Utc::now()` on
/// malformed input.
///
/// We deliberately don't surface the parse error: every caller is
/// shaping rows for a JSON response, and the rows in question are
/// either ones we wrote ourselves (so the value is guaranteed valid),
/// or they came from a migration whose worst case is a column that's
/// been blanked. In both cases the right behaviour is "render
/// something sensible" rather than 500. The downside is that a
/// systemic write bug would silently turn into a wave of `now()`
/// timestamps; given the writes are concentrated in a few helpers,
/// that's a trade we accept.
pub fn parse_rfc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// Parse one of the four wire-string network names into a `bitcoin::Network`.
///
/// The wire vocabulary (`"bitcoin"` / `"testnet"` / `"signet"` / `"regtest"`)
/// is shared by every request body and every stored row. Callers pick which
/// error message they want by mapping the `Err(&str)` arm — typically into
/// `ApiError::Validation` with a context-specific prefix:
///
/// ```ignore
/// let net = parse_network(&req.network)
///     .map_err(|name| ApiError::Validation(format!("unknown network {name}")))?;
/// ```
///
/// The error carries the offending string back so the caller can include it
/// verbatim in the user-facing message.
pub fn parse_network(s: &str) -> Result<Network, &str> {
    match s {
        "bitcoin" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        other => Err(other),
    }
}

/// The Bitcoin network the web UI should pre-select for new-vault
/// creation. Returned to the browser on `/health.default_network`.
///
/// Default is `"testnet"`, matching the historical hard-coded value
/// in the wizards. To stand up a signet test deployment, set
/// `GHOSTKEY_DEFAULT_NETWORK=signet` on that Fly app — the same web
/// frontend will then pre-select signet for every new vault on
/// that server, and the alpha banner will name it correctly.
///
/// Rejects any value not in the four-network allow-list the
/// `POST /vaults/from-xpub` route already enforces (`bitcoin`,
/// `testnet`, `signet`, `regtest`). On an invalid value we fall
/// back to `testnet` AND log an error — refusing to start would be
/// too aggressive (the server is otherwise fine; only the UI default
/// is wrong), but the error makes the misconfiguration loud.
pub fn default_network() -> &'static str {
    static CACHED: OnceLock<&'static str> = OnceLock::new();
    CACHED.get_or_init(
        || match std::env::var("GHOSTKEY_DEFAULT_NETWORK").as_deref() {
            Ok("bitcoin") => {
                tracing::warn!(
                    "GHOSTKEY_DEFAULT_NETWORK=bitcoin: the web UI will pre-select \
                 MAINNET for new vaults on this server. Make sure your \
                 deployment is genuinely ready for real funds (security review \
                 complete, backups in place, key rotation rehearsed). To \
                 prevent accidental mainnet vaults, leave this unset (defaults \
                 to testnet) or set it explicitly to signet/regtest."
                );
                "bitcoin"
            }
            Ok("signet") => {
                tracing::info!("GHOSTKEY_DEFAULT_NETWORK=signet: web UI will pre-select signet.");
                "signet"
            }
            Ok("regtest") => {
                tracing::info!("GHOSTKEY_DEFAULT_NETWORK=regtest: web UI will pre-select regtest.");
                "regtest"
            }
            Ok("testnet") => "testnet",
            Ok(other) => {
                tracing::error!(
                    requested = %other,
                    "GHOSTKEY_DEFAULT_NETWORK has an unknown value; expected one of \
                     bitcoin/testnet/signet/regtest. Falling back to 'testnet'."
                );
                "testnet"
            }
            Err(_) => "testnet",
        },
    )
}

/// Public base URL of this server, e.g. `https://ghostkey.example`.
///
/// Used to mint absolute callback URLs for LNURL-pay (LUD-06 requires
/// the `callback` field to be a fully-qualified URL that wallets can
/// hit). Trailing slashes are stripped so concatenation with a path
/// is always safe (`format!("{base}/lnurlp/{id}")`).
///
/// Returns `None` if the env var is unset or empty — callers should
/// degrade gracefully (e.g. hide the LNURL QR in the dashboard) rather
/// than crash, because mis-rendering an LNURL with a bogus callback
/// would silently misroute payments.
pub fn api_base_url() -> Option<String> {
    std::env::var("GHOSTKEY_API_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
}

/// Assumed mainnet block spacing, seconds. Used only to translate a
/// remaining-block count into a rough wall-clock unlock estimate (and the
/// challenge window into an issue-lead). Real spacing drifts, so anything
/// user-facing built on this says "around".
pub const TARGET_BLOCK_SECS: i64 = 600;

/// How long the claim-challenge window holds a freshly-opened claim,
/// in seconds. During the window the heir's key material and the
/// claim endpoints stay locked while the owner (and trusted contact)
/// are alerted — a live owner cancels the whole claim with one
/// check-in; a dead one merely delays the heir.
///
/// `GHOSTKEY_CLAIM_CHALLENGE_SECS` overrides; `0` disables the window
/// entirely. Default is 48 hours, except in demo mode where it drops
/// to 15 seconds so the full open → alert → wait → claim arc fits in
/// a live demo.
pub fn claim_challenge_window_secs() -> i64 {
    if let Some(v) = std::env::var("GHOSTKEY_CLAIM_CHALLENGE_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
    {
        return v.max(0);
    }
    if crate::demo::demo_mode() {
        15
    } else {
        48 * 3600
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't test the env-var branches in isolation because
    // `default_network` caches in a OnceLock. The default branch is
    // exercised by `health_endpoint_is_open` in auth.rs's http_tests
    // (which never sets the env var). What we CAN check here is the
    // contract that the returned string is always a valid network
    // name the rest of the server will accept.
    #[test]
    fn default_is_a_known_network() {
        let n = default_network();
        assert!(
            matches!(n, "bitcoin" | "testnet" | "signet" | "regtest"),
            "default_network() returned {n:?}, not in the allow-list"
        );
    }

    #[test]
    fn parse_network_accepts_all_four() {
        assert_eq!(parse_network("bitcoin").unwrap(), Network::Bitcoin);
        assert_eq!(parse_network("testnet").unwrap(), Network::Testnet);
        assert_eq!(parse_network("signet").unwrap(), Network::Signet);
        assert_eq!(parse_network("regtest").unwrap(), Network::Regtest);
    }

    #[test]
    fn parse_network_rejects_unknown_and_echoes_input() {
        // The error arm carries the offending string back verbatim so
        // callers can include it in their context-specific error.
        let err = parse_network("liquid").unwrap_err();
        assert_eq!(err, "liquid");
    }
}
