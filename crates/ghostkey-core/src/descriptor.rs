//! Vault descriptor construction.
//!
//! We use Taproot with a single tapscript leaf. The internal key is an
//! unspendable NUMS point so that the only spending paths are the explicit
//! script paths we encode.
//!
//! The leaf miniscript is:
//!
//! ```text
//! or_d(pk(OWNER), and_v(v:pk(HEIR), older(N)))
//! ```
//!
//! Witness layouts (control block + script omitted):
//! - Owner path:   `[owner_sig]`
//! - Heir path:    `[heir_sig, <empty>]`  (requires nSequence >= N)
//!
//! The relative timelock is enforced by `OP_CHECKSEQUENCEVERIFY` against the
//! input's `nSequence`, so the heir must broadcast a transaction whose input
//! sets `nSequence >= N`.
//!
//! ## Multipath note
//!
//! The legacy format emits a **pair** of descriptors: one for the external
//! (receive) chain and one for the internal (change) chain. Callers should
//! track both. (An earlier note here said miniscript 12 rejects multipath
//! `<0;1>/*` inside tapscript leaves. The 12.3 release we use accepts it,
//! and the standard format in [`build_standard_descriptor`] relies on that;
//! its tests parse and split such a descriptor.)

use miniscript::descriptor::Descriptor;
use std::str::FromStr;

use crate::error::{Error, Result};
use crate::keys::Chain;

/// BIP-341 recommended unspendable NUMS point ("nothing up my sleeve").
/// Hex of the x-only pubkey lifted from the generator with a transparent
/// nonce so that no one is expected to know the corresponding secret.
///
/// Source: BIP-341 §"Constructing and spending Taproot outputs".
pub const UNSPENDABLE_NUMS_XONLY: &str =
    "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

/// Maximum allowed CSV value when interpreted as a block-count relative
/// timelock (BIP-68: 16-bit value with disable + type flags clear).
pub const MAX_CSV_BLOCKS: u32 = 0xFFFF;

/// Inputs for building a vault descriptor.
///
/// Each key is a *single-chain* fragment (e.g. produced by
/// [`crate::keys::descriptor_key_fragment`] with [`Chain::External`] or
/// [`Chain::Internal`]).
#[derive(Debug, Clone)]
pub struct DescriptorParams {
    /// Owner key fragment ending in `/0/*` (external) or `/1/*` (internal).
    pub owner_key: String,
    /// Heir key fragment, same chain as `owner_key`.
    pub heir_key: String,
    /// Inactivity timelock in blocks. Must be in `1..=MAX_CSV_BLOCKS`.
    pub timelock_blocks: u32,
}

impl DescriptorParams {
    pub fn validate(&self) -> Result<()> {
        if self.timelock_blocks == 0 || self.timelock_blocks > MAX_CSV_BLOCKS {
            return Err(Error::InvalidTimelock(self.timelock_blocks));
        }
        Ok(())
    }
}

/// A receive/change descriptor pair for a vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorPair {
    /// External (receive) descriptor, `.../0/*`.
    pub external: String,
    /// Internal (change) descriptor, `.../1/*`.
    pub internal: String,
}

impl DescriptorPair {
    pub fn for_chain(&self, chain: Chain) -> &str {
        match chain {
            Chain::External => &self.external,
            Chain::Internal => &self.internal,
        }
    }
}

/// Render a single descriptor string from already-chain-specialized key
/// fragments.
///
/// Single-leaf trees are written without surrounding `{}`: rust-miniscript
/// only uses `{a,b}` for branching nodes.
pub fn build_descriptor_string(params: &DescriptorParams) -> Result<String> {
    params.validate()?;
    Ok(format!(
        "tr({nums},or_d(pk({owner}),and_v(v:pk({heir}),older({n}))))",
        nums = UNSPENDABLE_NUMS_XONLY,
        owner = params.owner_key,
        heir = params.heir_key,
        n = params.timelock_blocks,
    ))
}

/// Build a receive+change descriptor pair from per-chain key fragments.
///
/// `owner_external`, `heir_external` end in `/0/*`; the `_internal` variants
/// end in `/1/*`.
pub fn build_descriptor_pair(
    owner_external: &str,
    owner_internal: &str,
    heir_external: &str,
    heir_internal: &str,
    timelock_blocks: u32,
) -> Result<DescriptorPair> {
    let ext = build_descriptor_string(&DescriptorParams {
        owner_key: owner_external.to_string(),
        heir_key: heir_external.to_string(),
        timelock_blocks,
    })?;
    let int_ = build_descriptor_string(&DescriptorParams {
        owner_key: owner_internal.to_string(),
        heir_key: heir_internal.to_string(),
        timelock_blocks,
    })?;
    // Validate both parse.
    let _ = parse_descriptor(&ext)?;
    let _ = parse_descriptor(&int_)?;
    Ok(DescriptorPair {
        external: ext,
        internal: int_,
    })
}

/// The earliest absolute lock that is a date, not a block height
/// (Bitcoin reads values below 500,000,000 as heights).
pub const LOCKTIME_THRESHOLD: u32 = 500_000_000;

/// A locked goal's descriptor for one chain: the owner can spend from
/// `owner_after`, the heir from `heir_after`, both Unix times, and nobody
/// before. Two Taproot leaves under the unspendable NUMS key:
///
/// ```text
/// tr(NUMS, { and_v(v:pk(OWNER), after(owner_after)),
///            and_v(v:pk(HEIR),  after(heir_after)) })
/// ```
///
/// Proved on regtest and in Bitcoin Core by `tests/locked_spike.rs`.
pub fn build_locked_descriptor_string(
    owner_key: &str,
    heir_key: &str,
    owner_after: u32,
    heir_after: u32,
) -> Result<String> {
    if owner_after < LOCKTIME_THRESHOLD {
        return Err(Error::InvalidDescriptor(
            "a locked goal's unlock must be a date (Unix time), not a block height".into(),
        ));
    }
    if heir_after <= owner_after {
        return Err(Error::InvalidDescriptor(
            "the heir's date must come after the owner's unlock date".into(),
        ));
    }
    Ok(format!(
        "tr({UNSPENDABLE_NUMS_XONLY},{{and_v(v:pk({owner_key}),after({owner_after})),and_v(v:pk({heir_key}),after({heir_after}))}})"
    ))
}

/// The receive and change descriptors of a locked goal.
pub fn build_locked_descriptor_pair(
    owner_external: &str,
    owner_internal: &str,
    heir_external: &str,
    heir_internal: &str,
    owner_after: u32,
    heir_after: u32,
) -> Result<DescriptorPair> {
    let ext =
        build_locked_descriptor_string(owner_external, heir_external, owner_after, heir_after)?;
    let int_ =
        build_locked_descriptor_string(owner_internal, heir_internal, owner_after, heir_after)?;
    let _ = parse_descriptor(&ext)?;
    let _ = parse_descriptor(&int_)?;
    Ok(DescriptorPair {
        external: ext,
        internal: int_,
    })
}

/// A locked goal's two dates, read back from its descriptor:
/// `(owner_after, heir_after)`. `None` for any other kind of vault.
pub fn locked_dates(descriptor: &str) -> Option<(u32, u32)> {
    let mut dates = descriptor.match_indices("after(").filter_map(|(i, m)| {
        let rest = &descriptor[i + m.len()..];
        rest.split(')').next()?.parse::<u32>().ok()
    });
    let owner = dates.next()?;
    let heir = dates.next()?;
    if dates.next().is_some() || owner < LOCKTIME_THRESHOLD || heir <= owner {
        return None;
    }
    Some((owner, heir))
}

/// A vault in the standard format (#386), as one multipath descriptor and
/// the receive/change pair derived from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandardDescriptor {
    /// `tr(OWNER/<0;1>/*,and_v(v:pk(HEIR/<0;1>/*),older(N)))#checksum`:
    /// the form Liana and other Miniscript wallets import.
    pub multipath: String,
    /// The same descriptor split into its `/0/*` and `/1/*` halves, for
    /// code that tracks the two chains separately. No checksum, matching
    /// the legacy pair.
    pub pair: DescriptorPair,
}

/// Build a vault in the standard format (#386).
///
/// The spending rule is the same as [`build_descriptor_string`]: the
/// owner can spend at any time, the heir only after `timelock_blocks`.
/// It is written the way Liana and other Miniscript wallets expect, so a
/// vault can be opened outside GhostKey:
///
/// ```text
/// tr(OWNER/<0;1>/*, and_v(v:pk(HEIR/<0;1>/*), older(N)))
/// ```
///
/// - The owner is the Taproot internal key, so owner spends use the key
///   path: cheaper, and indistinguishable from a single-key wallet.
/// - Keys are one multipath `<0;1>/*` key with an origin, not a pair of
///   single-chain fragments.
///
/// Liana rejects the legacy format for two reasons, both fixed here: a
/// bare NUMS internal key, and single-path keys
/// (`liana/src/descriptors/analysis.rs`, v15). Not wired into vault
/// creation yet.
///
/// `owner_account` and `heir_account` are account-level keys with an
/// origin and no derivation suffix, e.g. `[d34db33f/86'/0'/0']xpub...`.
pub fn build_standard_descriptor(
    owner_account: &str,
    heir_account: &str,
    timelock_blocks: u32,
) -> Result<StandardDescriptor> {
    if timelock_blocks == 0 || timelock_blocks > MAX_CSV_BLOCKS {
        return Err(Error::InvalidTimelock(timelock_blocks));
    }
    check_account_key(owner_account)?;
    check_account_key(heir_account)?;
    if owner_account == heir_account {
        return Err(Error::InvalidDescriptor(
            "owner and heir must be different keys".into(),
        ));
    }

    let desc = parse_descriptor(&format!(
        "tr({owner_account}/<0;1>/*,and_v(v:pk({heir_account}/<0;1>/*),older({timelock_blocks})))"
    ))?;
    let mut singles = desc
        .clone()
        .into_single_descriptors()
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))?
        .into_iter();
    let (Some(external), Some(internal), None) = (singles.next(), singles.next(), singles.next())
    else {
        return Err(Error::InvalidDescriptor(
            "expected exactly a receive and a change descriptor".into(),
        ));
    };
    // The pair is stored without a checksum, like the legacy pair: signing
    // splices an xprv into the string, which would invalidate one.
    let no_checksum = |d: &Descriptor<miniscript::DescriptorPublicKey>| {
        let s = d.to_string();
        s.split_once('#')
            .map_or(s.clone(), |(body, _)| body.to_string())
    };
    Ok(StandardDescriptor {
        multipath: desc.to_string(),
        pair: DescriptorPair {
            external: no_checksum(&external),
            internal: no_checksum(&internal),
        },
    })
}

/// [`build_standard_descriptor`] from the four per-chain key fragments the
/// legacy builders take (`[fp/path]xpub/0/*` and `.../1/*` for each
/// party), so callers that already render fragments can switch formats by
/// switching function. Each party's two fragments must share one account
/// key.
pub fn build_standard_descriptor_from_fragments(
    owner_external: &str,
    owner_internal: &str,
    heir_external: &str,
    heir_internal: &str,
    timelock_blocks: u32,
) -> Result<StandardDescriptor> {
    let owner = account_key_from_fragments("owner", owner_external, owner_internal)?;
    let heir = account_key_from_fragments("heir", heir_external, heir_internal)?;
    build_standard_descriptor(owner, heir, timelock_blocks)
}

/// `[fp/path]xpub/0/*` + `[fp/path]xpub/1/*` -> `[fp/path]xpub`.
fn account_key_from_fragments<'a>(who: &str, external: &'a str, internal: &str) -> Result<&'a str> {
    let ext = external.strip_suffix("/0/*");
    let int_ = internal.strip_suffix("/1/*");
    match (ext, int_) {
        (Some(e), Some(i)) if e == i => Ok(e),
        _ => Err(Error::InvalidDescriptor(format!(
            "{who}: expected the same key ending in /0/* and /1/*, got {external} and {internal}"
        ))),
    }
}

/// An account-level xpub with an origin: Liana needs the origin to know
/// which signer owns the key, and we add the `/<0;1>/*` suffix ourselves.
fn check_account_key(key: &str) -> Result<()> {
    use miniscript::descriptor::DescriptorPublicKey;
    let parsed = DescriptorPublicKey::from_str(key)
        .map_err(|e| Error::InvalidDescriptor(format!("{key}: {e}")))?;
    match parsed {
        DescriptorPublicKey::XPub(x)
            if x.origin.is_some()
                && x.derivation_path.is_empty()
                && x.wildcard == miniscript::descriptor::Wildcard::None =>
        {
            Ok(())
        }
        _ => Err(Error::InvalidDescriptor(format!(
            "{key}: need an account xpub with an origin and no derivation suffix, \
             like [fingerprint/86'/0'/0']xpub..."
        ))),
    }
}

/// Absolute locktimes below this value are interpreted as block heights;
/// at or above, as Unix timestamps (BIP65 / `LOCKTIME_THRESHOLD`). We only
/// support the block-height form for the unlock CLTV, so a valid unlock
/// height must stay under it.
pub const MAX_CLTV_HEIGHT: u32 = 500_000_000;

/// Parse + validate a descriptor string.
pub fn parse_descriptor(s: &str) -> Result<Descriptor<miniscript::DescriptorPublicKey>> {
    Descriptor::<miniscript::DescriptorPublicKey>::from_str(s)
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{account_xpub, descriptor_key_fragment, Chain};
    use bitcoin::bip32::Xpriv;
    use bitcoin::Network;

    fn fragments(net: Network) -> (String, String, String, String) {
        let owner_m = Xpriv::new_master(net, &[0x11; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x22; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&owner_m, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&heir_m, net).unwrap();
        (
            descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
        )
    }

    #[test]
    fn rejects_zero_and_overlong_timelocks() {
        let (oe, _oi, he, _hi) = fragments(Network::Regtest);
        let mut p = DescriptorParams {
            owner_key: oe,
            heir_key: he,
            timelock_blocks: 0,
        };
        assert!(p.validate().is_err());
        p.timelock_blocks = MAX_CSV_BLOCKS + 1;
        assert!(p.validate().is_err());
        p.timelock_blocks = 144;
        assert!(p.validate().is_ok());
    }

    #[test]
    fn builds_and_parses_descriptor_pair() {
        let (oe, oi, he, hi) = fragments(Network::Regtest);
        let pair = build_descriptor_pair(&oe, &oi, &he, &hi, 52_560).unwrap();
        assert!(pair.external.starts_with("tr("));
        assert!(pair.external.contains("older(52560)"));
        assert!(pair.external.contains("/0/*"));
        assert!(pair.internal.contains("/1/*"));
        // both parse
        let ext = parse_descriptor(&pair.external).unwrap();
        let int_ = parse_descriptor(&pair.internal).unwrap();
        assert!(matches!(ext, Descriptor::Tr(_)));
        assert!(matches!(int_, Descriptor::Tr(_)));
    }

    /// Account-level `[fingerprint/path]xpub` keys for the standard format.
    fn account_keys(net: Network) -> (String, String) {
        let owner_m = Xpriv::new_master(net, &[0x11; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x22; 32]).unwrap();
        let fmt = |(fp, path, xpub): (
            bitcoin::bip32::Fingerprint,
            bitcoin::bip32::DerivationPath,
            bitcoin::bip32::Xpub,
        )| {
            let path = path.to_string();
            let path = path.strip_prefix("m/").unwrap_or(&path).to_string();
            format!("[{fp}/{path}]{xpub}")
        };
        (
            fmt(account_xpub(&owner_m, net).unwrap()),
            fmt(account_xpub(&heir_m, net).unwrap()),
        )
    }

    #[test]
    fn standard_descriptor_puts_the_owner_on_the_key_path() {
        let (owner, heir) = account_keys(Network::Regtest);
        let std = build_standard_descriptor(&owner, &heir, 12_960).unwrap();

        let expected = format!("tr({owner}/<0;1>/*,and_v(v:pk({heir}/<0;1>/*),older(12960)))");
        let (body, checksum) = std.multipath.split_once('#').expect("checksum");
        assert_eq!(body, expected);
        assert_eq!(checksum.len(), 8);

        let Descriptor::Tr(tr) = parse_descriptor(&std.multipath).unwrap() else {
            panic!("not taproot");
        };
        assert_eq!(
            tr.internal_key().to_string(),
            format!("{owner}/<0;1>/*"),
            "owner must be the internal key, not a NUMS point"
        );
        let leaves: Vec<_> = tr.iter_scripts().collect();
        assert_eq!(leaves.len(), 1, "one leaf: the heir's timelocked path");
        assert_eq!(
            leaves[0].1.to_string(),
            format!("and_v(v:pk({heir}/<0;1>/*),older(12960))")
        );
    }

    #[test]
    fn standard_descriptor_pair_matches_the_multipath_halves() {
        let (owner, heir) = account_keys(Network::Regtest);
        let std = build_standard_descriptor(&owner, &heir, 4_320).unwrap();
        assert_eq!(
            std.pair.external,
            format!("tr({owner}/0/*,and_v(v:pk({heir}/0/*),older(4320)))")
        );
        assert_eq!(
            std.pair.internal,
            format!("tr({owner}/1/*,and_v(v:pk({heir}/1/*),older(4320)))")
        );
        // The receive half derives the same address as the multipath
        // descriptor's first receive address.
        let ext = parse_descriptor(&std.pair.external).unwrap();
        let multi = parse_descriptor(&std.multipath).unwrap();
        let first_multi = multi.into_single_descriptors().unwrap().remove(0);
        assert_eq!(
            ext.at_derivation_index(0)
                .unwrap()
                .address(Network::Regtest)
                .unwrap(),
            first_multi
                .at_derivation_index(0)
                .unwrap()
                .address(Network::Regtest)
                .unwrap()
        );
    }

    #[test]
    fn standard_descriptor_has_the_same_spending_rule_as_legacy() {
        use miniscript::policy::{Liftable, Semantic};
        let (owner, heir) = account_keys(Network::Regtest);
        let std = build_standard_descriptor(&owner, &heir, 12_960).unwrap();
        let lifted = parse_descriptor(&std.multipath)
            .unwrap()
            .lift()
            .unwrap()
            .normalized();
        let expected = Semantic::<miniscript::DescriptorPublicKey>::from_str(&format!(
            "or(pk({owner}/<0;1>/*),and(pk({heir}/<0;1>/*),older(12960)))"
        ))
        .unwrap()
        .normalized();
        assert_eq!(lifted, expected, "owner any time, heir after the timelock");
    }

    #[test]
    fn standard_descriptor_rejects_keys_liana_would_reject() {
        let (owner, heir) = account_keys(Network::Regtest);
        // No origin.
        let bare = heir.split(']').nth(1).unwrap().to_string();
        assert!(build_standard_descriptor(&owner, &bare, 100).is_err());
        // Already has a derivation suffix.
        assert!(build_standard_descriptor(&owner, &format!("{heir}/0/*"), 100).is_err());
        // Same key twice.
        assert!(build_standard_descriptor(&owner, &owner, 100).is_err());
        // Timelock out of CSV range.
        assert!(build_standard_descriptor(&owner, &heir, 0).is_err());
        assert!(build_standard_descriptor(&owner, &heir, MAX_CSV_BLOCKS + 1).is_err());
    }

    #[test]
    fn standard_descriptor_from_fragments_matches_account_keys() {
        let (oe, oi, he, hi) = fragments(Network::Regtest);
        let (owner, heir) = account_keys(Network::Regtest);
        let from_frag = build_standard_descriptor_from_fragments(&oe, &oi, &he, &hi, 144).unwrap();
        let direct = build_standard_descriptor(&owner, &heir, 144).unwrap();
        assert_eq!(from_frag, direct);
        // Mismatched chains or keys are refused.
        assert!(build_standard_descriptor_from_fragments(&oi, &oe, &he, &hi, 144).is_err());
        assert!(build_standard_descriptor_from_fragments(&oe, &hi, &he, &hi, 144).is_err());
    }
}

#[cfg(test)]
mod locked_tests {
    use super::*;
    use crate::keys::{account_xpub, descriptor_key_fragment, Chain};
    use bitcoin::bip32::Xpriv;
    use bitcoin::Network;

    fn keys() -> (String, String) {
        let net = Network::Regtest;
        let o = Xpriv::new_master(net, &[0x31; 32]).unwrap();
        let h = Xpriv::new_master(net, &[0x32; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&o, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&h, net).unwrap();
        (
            descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
        )
    }

    #[test]
    fn a_locked_goal_builds_two_dated_leaves_and_reads_its_dates_back() {
        let (o, h) = keys();
        let d = build_locked_descriptor_string(&o, &h, 1_800_000_000, 1_808_000_000).unwrap();
        assert!(d.starts_with(&format!("tr({UNSPENDABLE_NUMS_XONLY},{{")));
        assert!(d.contains("after(1800000000)") && d.contains("after(1808000000)"));
        parse_descriptor(&d).expect("compiles");
        assert_eq!(locked_dates(&d), Some((1_800_000_000, 1_808_000_000)));
    }

    #[test]
    fn a_locked_goal_refuses_heights_and_an_heir_before_the_owner() {
        let (o, h) = keys();
        assert!(build_locked_descriptor_string(&o, &h, 900_000, 1_800_000_000).is_err());
        assert!(build_locked_descriptor_string(&o, &h, 1_800_000_000, 1_800_000_000).is_err());
        assert!(build_locked_descriptor_string(&o, &h, 1_800_000_000, 1_700_000_000).is_err());
    }

    #[test]
    fn other_vaults_have_no_locked_dates() {
        let (o, h) = keys();
        let legacy = build_descriptor_string(&DescriptorParams {
            owner_key: o,
            heir_key: h,
            timelock_blocks: 144,
        })
        .unwrap();
        assert_eq!(locked_dates(&legacy), None);
    }
}
