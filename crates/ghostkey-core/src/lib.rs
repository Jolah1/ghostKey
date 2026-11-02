//! # ghostkey-core
//!
//! Cryptographic core of the GhostKey inheritance protocol.
//!
//! This crate is intentionally **I/O-free**: it builds descriptors, derives
//! addresses, and produces PSBTs. It never speaks to a node, a database, or
//! the network. Higher layers (`ghostkey-cli`, `ghostkey-server`) are
//! responsible for chain access and persistence.
//!
//! ## Vault semantics
//!
//! A GhostKey vault is a Taproot output with two spending paths. New vaults
//! use the standard format (#386), which Liana can open: the owner is the
//! internal key, and the heir is a timelocked leaf.
//!
//! ```text
//! tr(OWNER, and_v(v:pk(HEIR), older(N)))
//! ```
//!
//! Older vaults use the legacy format, with a NUMS internal key and one
//! leaf, `or_d(pk(OWNER), and_v(v:pk(HEIR), older(N)))`. Same rule.
//!
//! - **Owner** can spend at any time (the hot path).
//! - **Heir** can spend only after `N` blocks have elapsed since the UTXO
//!   was confirmed (relative timelock via `OP_CSV`).
//!
//! "Checking in" is just the owner moving the UTXO to a freshly derived
//! vault address, which resets the heir's CSV countdown.
//!
//! See [`descriptor::build_standard_descriptor`] for why the owner moved
//! to the key path.

pub mod descriptor;
pub mod error;
pub mod keys;
pub mod psbt;
pub mod sweep;
pub mod vault;
pub mod wallet;

pub use error::{Error, Result};
pub use vault::{Vault, VaultConfig, VaultRole};
