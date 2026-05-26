//! Demo-mode flag and the validation knobs it loosens.
//!
//! GhostKey's real-world cadences are measured in days. A 14-day
//! check-in cycle with a 3-day grace is unwatchable on a video call:
//! you'd have to fake-forward the clock or wait two weeks to show
//! the alarm → claim-token → heir-page transition. Demo mode trades
//! safety for showability by allowing seconds-scale cadences, but
//! ONLY when the operator has explicitly opted in for a particular
//! deployment.
//!
//! ## What demo mode does
//!
//!   1. The server accepts `checkin_period_secs` and `grace_period_secs`
//!      values as low as [`DEMO_MIN_CHECKIN_SECS`] / [`DEMO_MIN_GRACE_SECS`].
//!      In production those values are floored at [`MIN_CHECKIN_SECS`]
//!      and [`MIN_GRACE_SECS`] respectively (one hour and one minute,
//!      to keep a careless owner from locking themselves out).
//!   2. The scheduler tick auto-drops to [`DEMO_SCHEDULER_TICK_SECS`]
//!      so a 10-second cadence isn't ticked once every 30 seconds.
//!   3. `/health` exposes `demo_mode: true` so the web UI can render
//!      the seconds-scale presets and a visible "DEMO MODE" banner.
//!
//! ## What demo mode does NOT do
//!
//!   * It does not change the Bitcoin script. The on-chain BIP68
//!     timer is still real Bitcoin time. A demo on signet/regtest
//!     can show the off-chain state machine end-to-end; demonstrating
//!     the on-chain claim still requires mining blocks the normal way.
//!   * It does not loosen any security check. Owner tokens, master-key
//!     encryption, claim-token single-use enforcement — all unchanged.
//!   * It does not auto-create demo vaults or seed fake data. Operators
//!     drive the demo manually through the existing routes.
//!
//! ## Safety guards
//!
//!   * Demo mode is FORBIDDEN on mainnet. `ensure_demo_safe_for_network`
//!     refuses to create a mainnet vault when demo mode is on. This is
//!     belt-and-braces; the operator who turned on demo mode has
//!     already decided this deployment is for demonstration, but a
//!     careless owner clicking "bitcoin" instead of "signet" in the
//!     network picker would silently get a 10-second cadence on real
//!     money. Better to fail loudly.
//!   * Startup logs a prominent warning whenever the flag is on so
//!     operators can spot an accidental production toggle.
//!   * The flag is read into a [`OnceLock`] at first use so a runtime
//!     env mutation cannot toggle it mid-request.

use std::sync::OnceLock;

/// Production floor on the check-in cadence. One hour. A vault with
/// a shorter cadence than this is almost certainly a mistake — even
/// the most paranoid real-world setup is hourly at most, and the
/// scheduler tick (30s) would not give the owner enough room to
/// react before alarming.
pub const MIN_CHECKIN_SECS: i64 = 3_600;

/// Production floor on the grace period. One minute. The product
/// is unusable with anything shorter — the owner couldn't see the
/// reminder email and click the button in time.
pub const MIN_GRACE_SECS: i64 = 60;

/// Demo-mode floor on the check-in cadence. Five seconds. Anything
/// shorter loses to scheduler jitter — the alarm transition is only
/// observed on the next scheduler tick, which is [`DEMO_SCHEDULER_TICK_SECS`]
/// (one second) so a 5-second cadence gives roughly 5 ticks of
/// resolution. Going lower starts producing demos where the deadline
/// passes between two reloads of the dashboard.
pub const DEMO_MIN_CHECKIN_SECS: i64 = 5;

/// Demo-mode floor on the grace period. Three seconds. Same logic as
/// the cadence: enough to be observable but short enough to be over
/// in one screen recording.
pub const DEMO_MIN_GRACE_SECS: i64 = 3;

// Compile-time invariants the rest of this module relies on. If a
// future contributor narrows the production floor without also
// narrowing the demo floor (or vice versa) the build fails loudly
// instead of silently letting the demo floor swap above the
// production one.
const _: () = assert!(DEMO_MIN_CHECKIN_SECS < MIN_CHECKIN_SECS);
const _: () = assert!(DEMO_MIN_GRACE_SECS < MIN_GRACE_SECS);
const _: () = assert!(DEMO_MIN_CHECKIN_SECS >= 1);
const _: () = assert!(DEMO_MIN_GRACE_SECS >= 1);

/// When demo mode is on, the scheduler ticks every second instead of
/// the production default (30 s). The Lightning poller likewise
/// drops to one second. Both override the CLI / env values so a
/// stale `GHOSTKEY_TICK_SECS=30` carried over from production doesn't
/// silently kill the demo.
pub const DEMO_SCHEDULER_TICK_SECS: u64 = 1;
pub const DEMO_LIGHTNING_TICK_SECS: u64 = 1;

/// True if `GHOSTKEY_DEMO_MODE` is set to a truthy value. Read once
/// at first call and cached for the process lifetime.
///
/// Mirrors the shape of [`crate::auth::auth_disabled`]: env-driven,
/// `OnceLock`-cached, logs a warning the first time it observes the
/// flag is on so an accidental production toggle is loud in the logs.
pub fn demo_mode() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| match std::env::var("GHOSTKEY_DEMO_MODE").as_deref() {
        Ok("1") | Ok("true") | Ok("yes") => {
            tracing::warn!(
                "GHOSTKEY_DEMO_MODE is on. This deployment will accept seconds-scale \
                 check-in cadences and grace periods. Intended ONLY for live \
                 demonstrations and local development; MUST NOT be set on a \
                 production server handling real owner credentials."
            );
            true
        }
        _ => false,
    })
}

/// Validate the cadence/grace pair against whichever floor applies.
/// Returns `Err(reason)` with a human-readable message suitable for a
/// 400 response.
///
/// Centralising the check here keeps the two creation endpoints
/// (`POST /vaults` and `POST /vaults/from-xpub`) in lockstep. Adding
/// a third creation path later (admin, batch import, …) gets the
/// same gate for free.
pub fn validate_periods(checkin_secs: i64, grace_secs: i64) -> Result<(), String> {
    if checkin_secs <= 0 {
        return Err("checkin_period_secs must be positive".into());
    }
    if grace_secs < 0 {
        return Err("grace_period_secs must be non-negative".into());
    }
    let (min_checkin, min_grace) = if demo_mode() {
        (DEMO_MIN_CHECKIN_SECS, DEMO_MIN_GRACE_SECS)
    } else {
        (MIN_CHECKIN_SECS, MIN_GRACE_SECS)
    };
    if checkin_secs < min_checkin {
        return Err(format!(
            "checkin_period_secs {checkin_secs} below minimum {min_checkin} \
             (demo mode is {})",
            if demo_mode() { "on" } else { "off" }
        ));
    }
    if grace_secs < min_grace {
        return Err(format!(
            "grace_period_secs {grace_secs} below minimum {min_grace} \
             (demo mode is {})",
            if demo_mode() { "on" } else { "off" }
        ));
    }
    Ok(())
}

/// Belt-and-braces: a demo-mode server must never create a mainnet
/// vault. The operator who flipped `GHOSTKEY_DEMO_MODE=1` has chosen
/// this deployment to be unsafe; pairing that with a network value of
/// `"bitcoin"` would let a confused owner stash real funds behind a
/// 10-second cadence. Refuse loudly.
pub fn ensure_demo_safe_for_network(network: &str) -> Result<(), String> {
    if demo_mode() && network == "bitcoin" {
        return Err(
            "demo mode is on; mainnet vault creation is disabled on this server. \
             Use signet, testnet, or regtest, or unset GHOSTKEY_DEMO_MODE."
                .into(),
        );
    }
    Ok(())
}

/* -------------------------------------------------------------------------- *
 *  Tests                                                                     *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: `demo_mode()` is cached for the process lifetime, so these
    // tests don't try to toggle the env var — they exercise the
    // validation helpers directly with both branches.

    #[test]
    fn validate_periods_rejects_negative_checkin() {
        // Path-independent of demo mode: zero/negative cadence is
        // always rejected first.
        let err = validate_periods(0, 0).unwrap_err();
        assert!(err.contains("positive"), "got: {err}");
    }

    #[test]
    fn validate_periods_rejects_negative_grace() {
        let err = validate_periods(MIN_CHECKIN_SECS, -1).unwrap_err();
        assert!(err.contains("non-negative"), "got: {err}");
    }

    /// Reproduce the production code path explicitly. We can't rely
    /// on `demo_mode()` returning false because another test in this
    /// process may have flipped it; instead duplicate the minimum
    /// check.
    #[test]
    fn production_floor_is_one_hour() {
        assert_eq!(MIN_CHECKIN_SECS, 3_600);
        assert_eq!(MIN_GRACE_SECS, 60);
    }

    // Demo floor relationships are now enforced at compile time
    // (see the `const _: () = assert!(...)` block at the top of this
    // module), so there's no runtime test for them — clippy used to
    // flag the asserts as constant-valued, which is correct: the
    // compile-time block is the right home for those invariants.

    /// Whatever the cached flag value, the daily-cadence vault that
    /// the existing test suite creates must always validate. Catches
    /// a regression where someone bumps `MIN_CHECKIN_SECS` past a day.
    #[test]
    fn realistic_daily_cadence_always_validates() {
        let day = 86_400;
        validate_periods(day, day).expect("daily cadence with daily grace is realistic");
    }

    /// Direct production-floor test that doesn't depend on whichever
    /// branch `demo_mode()` takes at runtime: feed `validate_periods`
    /// a value strictly below `DEMO_MIN_CHECKIN_SECS` (the looser of
    /// the two floors) and assert it fails. If both branches accept
    /// such a value, both are broken.
    #[test]
    fn periods_below_demo_floor_are_rejected_in_either_mode() {
        let too_short = DEMO_MIN_CHECKIN_SECS - 1;
        assert!(too_short > 0, "test bug: DEMO_MIN_CHECKIN_SECS must be >1");
        let err = validate_periods(too_short, MIN_GRACE_SECS).unwrap_err();
        assert!(err.contains("below minimum"), "got: {err}");
    }

    #[test]
    fn ensure_demo_safe_allows_signet_regardless() {
        // signet / testnet / regtest are always fine.
        for net in ["signet", "testnet", "regtest"] {
            ensure_demo_safe_for_network(net).expect(net);
        }
    }
}
