//! Profile state: mnemonics, vault config, and BDK wallet checkpoint
//! snapshot. All persisted as JSON on disk for simplicity.

use anyhow::{anyhow, bail, Context, Result};
use bitcoin::Network;
use ghostkey_core::vault::VaultConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// File name for the (sensitive) mnemonic.
pub const MNEMONIC_FILE: &str = "mnemonic.txt";
/// File name for the vault configuration.
pub const VAULT_FILE: &str = "vault.json";
/// File name for cached wallet state (so we don't resync from genesis).
pub const WALLET_STATE_FILE: &str = "wallet_state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletState {
    /// Last synced block height (best effort; we resync from this height-1).
    pub last_synced_height: u32,
    /// Best block hash known to the wallet at last sync.
    pub best_block_hash: bitcoin::BlockHash,
    /// Network for sanity checks.
    pub network: Network,
}

pub fn mnemonic_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(MNEMONIC_FILE)
}

pub fn vault_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(VAULT_FILE)
}

pub fn wallet_state_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(WALLET_STATE_FILE)
}

/// Write a mnemonic with 0600 perms, refusing to overwrite an existing file.
pub fn write_mnemonic(profile_dir: &Path, words: &str) -> Result<()> {
    let p = mnemonic_path(profile_dir);
    if p.exists() {
        bail!("mnemonic already exists at {:?}; refusing to overwrite", p);
    }
    fs::write(&p, format!("{}\n", words.trim()))
        .with_context(|| format!("writing mnemonic to {:?}", p))?;
    // Best-effort 0600. We're unix-only for this scaffolding.
    let mut perms = fs::metadata(&p)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(&p, perms)?;
    Ok(())
}

pub fn read_mnemonic(profile_dir: &Path) -> Result<String> {
    let p = mnemonic_path(profile_dir);
    let s = fs::read_to_string(&p)
        .with_context(|| format!("reading mnemonic at {:?} (run `init-keys` first?)", p))?;
    Ok(s.trim().to_string())
}

pub fn write_vault(profile_dir: &Path, cfg: &VaultConfig) -> Result<()> {
    let p = vault_path(profile_dir);
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&p, json).with_context(|| format!("writing vault to {:?}", p))?;
    Ok(())
}

pub fn read_vault(profile_dir: &Path) -> Result<VaultConfig> {
    let p = vault_path(profile_dir);
    let s = fs::read_to_string(&p)
        .with_context(|| format!("reading vault at {:?} (run `make-vault` first?)", p))?;
    serde_json::from_str(&s).map_err(|e| anyhow!("parsing vault JSON: {e}"))
}

pub fn write_wallet_state(profile_dir: &Path, st: &WalletState) -> Result<()> {
    let p = wallet_state_path(profile_dir);
    fs::write(&p, serde_json::to_string_pretty(st)?)?;
    Ok(())
}

pub fn read_wallet_state(profile_dir: &Path) -> Result<Option<WalletState>> {
    let p = wallet_state_path(profile_dir);
    if !p.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&p)?;
    Ok(Some(serde_json::from_str(&s)?))
}
