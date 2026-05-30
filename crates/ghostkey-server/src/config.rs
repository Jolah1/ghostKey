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

use std::sync::OnceLock;

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
}
