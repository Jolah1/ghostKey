//! High-level vault primitives.
//!
//! A [`Vault`] is the public, persistable view of an inheritance setup:
//! - the parsed external/internal descriptor pair
//! - the configured timelock
//! - which role (owner/heir/watch-only) this instance can act as
//!
//! Vaults are stateless w.r.t. the chain — wallets built on top (in
//! `ghostkey-cli` / `ghostkey-server`) handle UTXO tracking.

use serde::{Deserialize, Serialize};

use crate::descriptor::{build_descriptor_pair, parse_descriptor, DescriptorPair};
use crate::error::Result;
use crate::keys::Chain;

/// What this process can do with the vault.
///
/// The descriptor itself doesn't change with the role — but only an owner or
/// heir process should have the corresponding private key material loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultRole {
    /// Holds the owner's private key. Can spend at any time.
    Owner,
    /// Holds the heir's private key. Can spend only after the timelock.
    Heir,
    /// Holds no keys. Used by the notifier server.
    Watchonly,
}

/// Persistable configuration of a vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultConfig {
    /// External (receive) descriptor, `.../0/*`.
    pub descriptor_external: String,
    /// Internal (change) descriptor, `.../1/*`.
    pub descriptor_internal: String,
    pub timelock_blocks: u32,
    pub network: bitcoin::Network,
    pub role: VaultRole,
    #[serde(default)]
    pub label: Option<String>,
}

/// A constructed vault ready to derive addresses / build PSBTs.
#[derive(Debug, Clone)]
pub struct Vault {
    pub config: VaultConfig,
}

impl Vault {
    /// Construct a vault from per-chain owner/heir key fragments.
    //
    // The eight args are inherent to the vault's identity (four key
    // fragments + timelock + network + role + label). Collapsing them
    // into a builder would not improve call sites materially. Allowing
    // the lint locally with this note is preferable to either churn
    // or a blanket project-wide allow.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_external: &str,
        owner_internal: &str,
        heir_external: &str,
        heir_internal: &str,
        timelock_blocks: u32,
        network: bitcoin::Network,
        role: VaultRole,
        label: Option<String>,
    ) -> Result<Self> {
        let pair = build_descriptor_pair(
            owner_external,
            owner_internal,
            heir_external,
            heir_internal,
            timelock_blocks,
        )?;
        Ok(Self {
            config: VaultConfig {
                descriptor_external: pair.external,
                descriptor_internal: pair.internal,
                timelock_blocks,
                network,
                role,
                label,
            },
        })
    }

    /// Reconstruct a vault from a previously stored configuration.
    pub fn from_config(config: VaultConfig) -> Result<Self> {
        // Validate both descriptors parse.
        let _ = parse_descriptor(&config.descriptor_external)?;
        let _ = parse_descriptor(&config.descriptor_internal)?;
        Ok(Self { config })
    }

    pub fn descriptor_pair(&self) -> DescriptorPair {
        DescriptorPair {
            external: self.config.descriptor_external.clone(),
            internal: self.config.descriptor_internal.clone(),
        }
    }

    pub fn descriptor_for(&self, chain: Chain) -> &str {
        match chain {
            Chain::External => &self.config.descriptor_external,
            Chain::Internal => &self.config.descriptor_internal,
        }
    }

    pub fn timelock_blocks(&self) -> u32 {
        self.config.timelock_blocks
    }

    pub fn network(&self) -> bitcoin::Network {
        self.config.network
    }

    pub fn role(&self) -> VaultRole {
        self.config.role
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{account_xpub, descriptor_key_fragment, Chain};
    use bitcoin::bip32::Xpriv;
    use bitcoin::Network;

    fn make_vault(net: Network, lock: u32) -> Vault {
        let owner_m = Xpriv::new_master(net, &[0x11; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x22; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&owner_m, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&heir_m, net).unwrap();
        Vault::new(
            &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            lock,
            net,
            VaultRole::Owner,
            Some("test".into()),
        )
        .unwrap()
    }

    #[test]
    fn round_trip_via_config() {
        let v = make_vault(Network::Regtest, 144);
        let json = serde_json::to_string(&v.config).unwrap();
        let cfg: VaultConfig = serde_json::from_str(&json).unwrap();
        let v2 = Vault::from_config(cfg).unwrap();
        assert_eq!(v.descriptor_pair(), v2.descriptor_pair());
        assert_eq!(v2.timelock_blocks(), 144);
        assert_eq!(v2.role(), VaultRole::Owner);
        assert!(v2.descriptor_for(Chain::External).contains("/0/*"));
        assert!(v2.descriptor_for(Chain::Internal).contains("/1/*"));
    }
}
