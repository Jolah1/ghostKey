//! PSBT flows for vault operations.
//!
//! Two flows are supported:
//!
//! 1. [`build_check_in`] — owner sweeps all vault UTXOs to a fresh vault
//!    address. This resets the heir's relative timelock for every output
//!    and is the periodic proof-of-life action.
//! 2. [`build_heir_claim`] — heir sweeps all vault UTXOs to an address they
//!    control, after the timelock has elapsed. This selects the timelocked
//!    script-path branch and sets `nSequence = timelock_blocks` on every
//!    input.
//!
//! Both functions take an already-synced [`bdk_wallet::Wallet`]; the caller
//! is responsible for chain access.

use std::collections::BTreeMap;

use bdk_wallet::{KeychainKind, SignOptions, Wallet};
use bitcoin::{Address, FeeRate, Psbt};

use crate::descriptor::parse_descriptor;
use crate::error::{Error, Result};
use crate::vault::Vault;

/// Result of building a PSBT.
#[derive(Debug, Clone)]
pub struct BuiltPsbt {
    pub psbt: Psbt,
    /// Whether the wallet was able to *fully* sign the PSBT.
    pub finalized: bool,
}

/// Build (and optionally sign) a check-in transaction.
///
/// The transaction drains the entire vault balance to a freshly-revealed
/// vault external address, which the owner controls via the keypath of the
/// new UTXO. This satisfies the spec: each check-in moves coins to a fresh
/// output whose CSV countdown restarts at the new confirmation height.
///
/// `wallet` must be either watch-only (in which case the resulting PSBT is
/// unsigned and must be signed by an offline owner) or owner-signing (in
/// which case BDK will sign immediately).
pub fn build_check_in(wallet: &mut Wallet, fee_rate: FeeRate) -> Result<BuiltPsbt> {
    // Reveal a fresh receive address. We pass `String::new()` as a marker so
    // that the resulting tx output uses our own script_pubkey. We could
    // instead use `drain_to(addr.script_pubkey())`.
    let addr = wallet.reveal_next_address(KeychainKind::External).address;

    // The vault descriptor's policy is ambiguous (owner OR heir+timelock),
    // so we must explicitly tell BDK to satisfy the OWNER branch — the
    // arm of the `or_d` that contains no relative timelock. This also
    // guarantees we don't accidentally set an `nSequence` that delays
    // the check-in's spendability.
    let ext_path = resolve_owner_policy_path(wallet, KeychainKind::External)?;
    let int_path = resolve_owner_policy_path(wallet, KeychainKind::Internal)?;

    let mut psbt = {
        let mut b = wallet.build_tx();
        b.drain_wallet()
            .drain_to(addr.script_pubkey())
            .fee_rate(fee_rate)
            .policy_path(ext_path, KeychainKind::External)
            .policy_path(int_path, KeychainKind::Internal);
        b.finish().map_err(|e| Error::Psbt(e.to_string()))?
    };

    let finalized = wallet
        .sign(&mut psbt, SignOptions::default())
        .map_err(|e| Error::Psbt(e.to_string()))?;

    Ok(BuiltPsbt { psbt, finalized })
}

/// Build (and optionally sign) an owner spend to an external address.
///
/// Unlike [`build_check_in`] (which always drains back into the vault),
/// this pays `recipient` either a specific `amount_sat` or — when
/// `amount_sat` is `None` — the entire balance. For partial sends BDK
/// routes change to the vault's internal keychain, so the leftover
/// coins stay under the same inheritance descriptor; their CSV
/// countdown restarts at the new confirmation height, exactly like a
/// check-in.
///
/// Uses the owner (signature-only, no CSV) tapscript branch on both
/// keychains, so the transaction is spendable immediately.
pub fn build_owner_send(
    wallet: &mut Wallet,
    vault: &Vault,
    recipient: &Address,
    amount_sat: Option<u64>,
    fee_rate: FeeRate,
) -> Result<BuiltPsbt> {
    if !recipient
        .as_unchecked()
        .is_valid_for_network(vault.network())
    {
        return Err(Error::Psbt(format!(
            "recipient address is not valid for vault network {:?}",
            vault.network()
        )));
    }

    let ext_path = resolve_owner_policy_path(wallet, KeychainKind::External)?;
    let int_path = resolve_owner_policy_path(wallet, KeychainKind::Internal)?;

    let mut psbt = {
        let mut b = wallet.build_tx();
        match amount_sat {
            Some(sats) => {
                b.add_recipient(recipient.script_pubkey(), bitcoin::Amount::from_sat(sats));
            }
            None => {
                b.drain_wallet().drain_to(recipient.script_pubkey());
            }
        }
        b.fee_rate(fee_rate)
            .policy_path(ext_path, KeychainKind::External)
            .policy_path(int_path, KeychainKind::Internal);
        b.finish().map_err(|e| Error::Psbt(e.to_string()))?
    };

    let finalized = wallet
        .sign(&mut psbt, SignOptions::default())
        .map_err(|e| Error::Psbt(e.to_string()))?;

    Ok(BuiltPsbt { psbt, finalized })
}

/// Build (and optionally sign) a heir-claim transaction.
///
/// Drains the entire vault balance to `recipient`. The transaction uses the
/// tapscript path that includes `older(timelock_blocks)`, so:
///
/// - It is **only valid** once every input UTXO has accumulated
///   `timelock_blocks` confirmations.
/// - Every input is given `nSequence = timelock_blocks` to satisfy CSV.
///
/// If `wallet` is heir-signing, BDK will sign immediately; otherwise the
/// caller receives a heir-signable PSBT.
pub fn build_heir_claim(
    wallet: &mut Wallet,
    vault: &Vault,
    recipient: &Address,
    fee_rate: FeeRate,
) -> Result<BuiltPsbt> {
    // Address must match the vault's network. `as_unchecked` is a cheap
    // type punning that lets us reuse the NetworkUnchecked check API.
    if !recipient
        .as_unchecked()
        .is_valid_for_network(vault.network())
    {
        return Err(Error::Psbt(format!(
            "recipient address is not valid for vault network {:?}",
            vault.network()
        )));
    }

    let csv = vault.timelock_blocks();
    let nseq = bitcoin::Sequence::from_consensus(csv);

    // Resolve the policy path that selects the heir+timelock branch.
    let ext_path = resolve_timelock_policy_path(wallet, KeychainKind::External)?;
    let int_path = resolve_timelock_policy_path(wallet, KeychainKind::Internal)?;

    let mut psbt = {
        let mut b = wallet.build_tx();
        b.drain_wallet()
            .drain_to(recipient.script_pubkey())
            .fee_rate(fee_rate)
            .nlocktime(bitcoin::absolute::LockTime::ZERO)
            .policy_path(ext_path, KeychainKind::External)
            .policy_path(int_path, KeychainKind::Internal)
            // Force every input's nSequence to satisfy CSV. `set_exact_sequence`
            // is BDK's explicit knob; it will conflict with the CSV branch
            // only if the value we pass is *lower* than the required CSV,
            // which we guarantee here by passing `csv` itself.
            .set_exact_sequence(nseq);
        b.finish().map_err(|e| Error::Psbt(e.to_string()))?
    };

    let finalized = wallet
        .sign(&mut psbt, SignOptions::default())
        .map_err(|e| Error::Psbt(e.to_string()))?;

    // Defensive: parse the vault descriptor to ensure our state is sane.
    let _ = parse_descriptor(vault.descriptor_for(crate::keys::Chain::External))?;

    Ok(BuiltPsbt { psbt, finalized })
}

/// Build (and optionally sign) a **guardian-vault** claim (issue #81).
///
/// Identical to [`build_heir_claim`] in shape — drains the whole balance to
/// `recipient`, sets `nSequence = timelock_blocks` on every input — but the
/// claim branch is `heir AND (g1 OR g2) AND older(N)`. The supplied `wallet`
/// must carry **two** private keys (heir + one guardian); see
/// [`crate::wallet::build_signing_guardian`]. BDK signs immediately when both
/// keys are present, producing the heir signature plus one guardian signature.
pub fn build_guardian_claim(
    wallet: &mut Wallet,
    vault: &Vault,
    recipient: &Address,
    fee_rate: FeeRate,
) -> Result<BuiltPsbt> {
    if !recipient
        .as_unchecked()
        .is_valid_for_network(vault.network())
    {
        return Err(Error::Psbt(format!(
            "recipient address is not valid for vault network {:?}",
            vault.network()
        )));
    }

    let csv = vault.timelock_blocks();
    let nseq = bitcoin::Sequence::from_consensus(csv);

    // An optional unlock CLTV (#81 P5) is satisfied by the tx nLockTime.
    // We set it to the wallet's current tip height: standard anti-fee-sniping
    // for vaults without an unlock, and exactly what satisfies `after(H)`
    // once the tip has reached `H`. If the unlock has not matured (tip < H),
    // BDK cannot finalize the absolute-timelock leaf and the claim fails with
    // the usual "timelock may not have matured" error — correct behaviour.
    let tip_height = wallet.latest_checkpoint().height();
    let nlocktime = bitcoin::absolute::LockTime::from_height(tip_height)
        .unwrap_or(bitcoin::absolute::LockTime::ZERO);

    let ext_path = resolve_guardian_policy_path(wallet, KeychainKind::External)?;
    let int_path = resolve_guardian_policy_path(wallet, KeychainKind::Internal)?;

    let mut psbt = {
        let mut b = wallet.build_tx();
        b.drain_wallet()
            .drain_to(recipient.script_pubkey())
            .fee_rate(fee_rate)
            .nlocktime(nlocktime)
            .policy_path(ext_path, KeychainKind::External)
            .policy_path(int_path, KeychainKind::Internal)
            .set_exact_sequence(nseq);
        b.finish().map_err(|e| Error::Psbt(e.to_string()))?
    };

    let finalized = wallet
        .sign(&mut psbt, SignOptions::default())
        .map_err(|e| Error::Psbt(e.to_string()))?;

    Ok(BuiltPsbt { psbt, finalized })
}

/// Walk the guardian-vault policy and select the claim path:
/// `heir AND (g1 OR g2) AND older(N)`.
///
/// Rules at each `Thresh`:
/// - `threshold > 1` (an `and`): take **all** children (heir sig, the
///   timelock, and the guardian disjunction must all be satisfied).
/// - `threshold == 1` (an `or`): if a child contains the relative timelock,
///   take that one (the top `or_d` claim arm); otherwise — the inner
///   `(g1 OR g2)` — take the child the wallet can actually sign (the one
///   guardian whose key is loaded, marked `Complete` by BDK).
fn resolve_guardian_policy_path(
    wallet: &Wallet,
    keychain: KeychainKind,
) -> Result<BTreeMap<String, Vec<usize>>> {
    use bdk_wallet::descriptor::policy::{Policy, Satisfaction, SatisfiableItem};

    let policy = wallet
        .policies(keychain)
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))?
        .ok_or_else(|| Error::InvalidDescriptor("wallet has no policy".into()))?;

    let mut out = BTreeMap::new();
    if !walk(&policy, &mut out) {
        return Err(Error::Psbt(
            "could not resolve the guardian claim path (needs the heir + one guardian)".into(),
        ));
    }
    return Ok(out);

    /// Returns true if the wallet's loaded keys can satisfy this subtree
    /// (allowing the relative timelock, which we satisfy via nSequence).
    /// Records each `Thresh`'s chosen children along the way. A signature
    /// leaf counts only when the wallet actually contributes it, so a claim
    /// missing the heir — or missing every guardian — fails to resolve.
    fn walk(node: &Policy, out: &mut BTreeMap<String, Vec<usize>>) -> bool {
        match &node.item {
            // Satisfied by setting nSequence; no key needed.
            SatisfiableItem::RelativeTimelock { .. } => true,
            // Optional unlock CLTV (#81 P5): satisfied by the tx nLockTime
            // (set to the tip height in `build_guardian_claim`), no key
            // needed. Part of the claim path when an unlock is configured.
            SatisfiableItem::AbsoluteTimelock { .. } => true,

            // A signature is usable only if the wallet can complete it.
            SatisfiableItem::SchnorrSignature(_)
            | SatisfiableItem::EcdsaSignature(_)
            | SatisfiableItem::Multisig { .. } => is_satisfiable(node),

            // Hash preimages are not part of the guardian claim path.
            SatisfiableItem::Sha256Preimage { .. }
            | SatisfiableItem::Hash256Preimage { .. }
            | SatisfiableItem::Ripemd160Preimage { .. }
            | SatisfiableItem::Hash160Preimage { .. } => false,

            SatisfiableItem::Thresh { items, threshold } => {
                if *threshold > 1 {
                    // Conjunction (heir AND timelock AND guardian-or): every
                    // child must be satisfiable.
                    for child in items {
                        if !walk(child, out) {
                            return false;
                        }
                    }
                    out.insert(node.id.clone(), (0..items.len()).collect());
                    true
                } else {
                    // Disjunction (owner-or-claim; g1-or-g2): any one
                    // satisfiable child suffices. Try each speculatively and
                    // commit the first that resolves.
                    for (i, child) in items.iter().enumerate() {
                        let mut scratch = out.clone();
                        if walk(child, &mut scratch) {
                            *out = scratch;
                            out.insert(node.id.clone(), vec![i]);
                            return true;
                        }
                    }
                    false
                }
            }
        }
    }

    /// True if the wallet can fully contribute this leaf (its key is loaded).
    fn is_satisfiable(node: &Policy) -> bool {
        matches!(&node.contribution, Satisfaction::Complete { .. })
    }
}

/// Walk the policy for `keychain` and produce a `policy_path` map that
/// selects every branch leading to a `RelativeTimelock` item — i.e. the
/// heir's path through the tapscript.
///
/// At each `Thresh` ancestor of the timelock leaf:
///
/// - If `threshold == 1` (an `or`), pick only the child whose subtree
///   contains the timelock; we satisfy the `or` via that child alone.
/// - If `threshold > 1` (an `and`/multisig), we must satisfy every
///   child — so we pick all of them. This is critical for the
///   `and_v(v:pk(HEIR), older(N))` node: BDK rejects the policy path
///   if we omit the sibling signature requirement.
fn resolve_timelock_policy_path(
    wallet: &Wallet,
    keychain: KeychainKind,
) -> Result<BTreeMap<String, Vec<usize>>> {
    use bdk_wallet::descriptor::policy::{Policy, SatisfiableItem};

    let policy = wallet
        .policies(keychain)
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))?
        .ok_or_else(|| Error::InvalidDescriptor("wallet has no policy".into()))?;

    let mut out = BTreeMap::new();
    if !walk(&policy, &mut out) {
        return Err(Error::Psbt(
            "could not find a script-path branch with a relative timelock".into(),
        ));
    }
    return Ok(out);

    /// Returns true if `node` is — or contains — a `RelativeTimelock`. While
    /// walking, records the indices of children to take at each `Thresh`
    /// junction so that the resulting path reaches the timelock leaf and
    /// satisfies each `Thresh`'s threshold.
    fn walk(node: &Policy, out: &mut BTreeMap<String, Vec<usize>>) -> bool {
        match &node.item {
            SatisfiableItem::RelativeTimelock { .. } => true,
            SatisfiableItem::Thresh { items, threshold } => {
                // First locate which children reach a timelock.
                let timelock_children: Vec<usize> = (0..items.len())
                    .filter(|&i| contains_relative_timelock_node(&items[i]))
                    .collect();
                if timelock_children.is_empty() {
                    return false;
                }

                let chosen: Vec<usize> = if *threshold > 1 {
                    // Conjunction: must satisfy every child of this Thresh.
                    (0..items.len()).collect()
                } else {
                    // Disjunction: any one child suffices. Pick the one(s)
                    // containing the timelock.
                    timelock_children.clone()
                };

                // Recurse into the children we selected so their sub-Threshes
                // also have entries.
                for &i in &chosen {
                    let _ = walk(&items[i], out);
                }
                out.insert(node.id.clone(), chosen);
                true
            }
            // Other leaves (signatures, hashes, abs timelocks, etc.) are not
            // the timelock branch on their own.
            _ => false,
        }
    }

    fn contains_relative_timelock_node(node: &Policy) -> bool {
        match &node.item {
            SatisfiableItem::RelativeTimelock { .. } => true,
            SatisfiableItem::Thresh { items, .. } => {
                items.iter().any(contains_relative_timelock_node)
            }
            _ => false,
        }
    }
}

/// Walk the policy for `keychain` and produce a `policy_path` map that
/// selects the OWNER branch — every `Thresh` is steered down a
/// satisfiable child whose `Condition` has no CSV requirement. This is
/// the "hot path" used by check-ins.
///
/// We rely on BDK's own `contribution` annotation rather than scanning
/// for `RelativeTimelock` ourselves: a child is "owner-satisfiable" iff
/// its `contribution` is `Complete { csv: None }` (or contains such a
/// path recursively). This correctly distinguishes between the
/// keypath (NUMS, not contributable) and the tapleaf path (owner-side
/// of the `or_d` is contributable with no CSV).
fn resolve_owner_policy_path(
    wallet: &Wallet,
    keychain: KeychainKind,
) -> Result<BTreeMap<String, Vec<usize>>> {
    use bdk_wallet::descriptor::policy::{Policy, SatisfiableItem};

    let policy = wallet
        .policies(keychain)
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))?
        .ok_or_else(|| Error::InvalidDescriptor("wallet has no policy".into()))?;

    let mut out = BTreeMap::new();
    if !walk(&policy, &mut out) {
        return Err(Error::Psbt(
            "no owner branch (signature-only, no CSV) is satisfiable in this policy".into(),
        ));
    }
    return Ok(out);

    /// Returns true if this subtree can be satisfied with just the
    /// owner's signature(s) — no CSV, no other timelock. Records each
    /// Thresh's chosen children along the way.
    fn walk(node: &Policy, out: &mut BTreeMap<String, Vec<usize>>) -> bool {
        match &node.item {
            // Signature leaves are owner-satisfiable iff the wallet
            // actually contributes a complete signature with no CSV.
            SatisfiableItem::SchnorrSignature(_)
            | SatisfiableItem::EcdsaSignature(_)
            | SatisfiableItem::Multisig { .. } => is_complete_no_csv(node),

            // Timelock / hash leaves are NOT in the owner path.
            SatisfiableItem::RelativeTimelock { .. }
            | SatisfiableItem::AbsoluteTimelock { .. }
            | SatisfiableItem::Sha256Preimage { .. }
            | SatisfiableItem::Hash256Preimage { .. }
            | SatisfiableItem::Ripemd160Preimage { .. }
            | SatisfiableItem::Hash160Preimage { .. } => false,

            SatisfiableItem::Thresh { items, threshold } => {
                if *threshold > 1 {
                    // Conjunction: every child must be owner-satisfiable.
                    for child in items {
                        if !walk(child, out) {
                            return false;
                        }
                    }
                    out.insert(node.id.clone(), (0..items.len()).collect());
                    true
                } else {
                    // Disjunction: any one suffices. Pick the first
                    // owner-satisfiable child.
                    for (i, child) in items.iter().enumerate() {
                        // Tentatively try this branch; speculatively
                        // record into a scratch map and commit on success.
                        let mut scratch = out.clone();
                        if walk(child, &mut scratch) {
                            *out = scratch;
                            out.insert(node.id.clone(), vec![i]);
                            return true;
                        }
                    }
                    false
                }
            }
        }
    }

    fn is_complete_no_csv(node: &Policy) -> bool {
        use bdk_wallet::descriptor::policy::Satisfaction;
        matches!(
            &node.contribution,
            Satisfaction::Complete { condition } if condition.csv.is_none()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{account_xpub, descriptor_key_fragment, Chain};
    use crate::vault::{Vault, VaultRole};
    use crate::wallet::{build_signing, build_watch_only};
    use bitcoin::bip32::Xpriv;
    use bitcoin::Network;

    fn mk() -> (Vault, Xpriv, Xpriv) {
        let net = Network::Regtest;
        let owner_m = Xpriv::new_master(net, &[0x11; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x22; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&owner_m, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&heir_m, net).unwrap();
        let v = Vault::new(
            &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            144,
            net,
            VaultRole::Owner,
            None,
        )
        .unwrap();
        (v, owner_m, heir_m)
    }

    #[test]
    fn timelock_policy_path_resolves() {
        let (v, _o, _h) = mk();
        let w = build_watch_only(&v).unwrap();
        let path =
            resolve_timelock_policy_path(&w, KeychainKind::External).expect("must resolve path");
        // At minimum, the root Thresh should be in the map (it must choose
        // the child that contains the relative timelock).
        assert!(!path.is_empty(), "policy path should not be empty");
    }

    #[test]
    fn owner_policy_path_resolves() {
        // Needs a signing wallet: the walker keys off BDK's
        // `Complete` contribution, which watch-only never produces.
        let (v, o, _h) = mk();
        let w = build_signing(&v, &o).unwrap();
        let path =
            resolve_owner_policy_path(&w, KeychainKind::External).expect("must resolve path");
        assert!(!path.is_empty(), "policy path should not be empty");
    }

    #[test]
    fn owner_send_rejects_wrong_network_address() {
        let (v, o, _h) = mk();
        let mut w = build_signing(&v, &o).unwrap();
        // Mainnet address against a regtest vault must fail fast,
        // before any coin selection happens.
        let addr = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
            .parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
            .unwrap()
            .assume_checked();
        let err = build_owner_send(&mut w, &v, &addr, Some(1_000), FeeRate::BROADCAST_MIN);
        assert!(err.is_err(), "wrong-network address must be rejected");
    }

    #[test]
    fn signing_wallet_construction_smoke() {
        // We don't have any UTXOs without a regtest node, so we cannot
        // actually call build_check_in / build_heir_claim end-to-end here.
        // This test only ensures construction works.
        let (v, o, h) = mk();
        let _ = build_signing(&v, &o).unwrap();
        let _ = build_signing(&v, &h).unwrap();
    }
}
