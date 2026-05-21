use anyhow::{bail, Context, Result};
use bitcoin::Network;
use clap::Args as ClapArgs;
use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
use ghostkey_core::vault::{Vault, VaultRole};
use std::path::Path;

use crate::commands::master_xpriv;
use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {
    /// What this profile's role is in the vault.
    #[arg(long, value_enum)]
    pub role: Role,

    /// Inactivity timelock in blocks (1..=65535).
    #[arg(long)]
    pub timelock_blocks: u32,

    /// Network the vault lives on.
    #[arg(long, default_value = "regtest")]
    pub network: Network,

    /// Counterparty's external key fragment, e.g. `[fp/86'/1'/0']tpub.../0/*`.
    /// Required when this profile is the owner (provides heir's key) or the
    /// heir (provides owner's key).
    #[arg(long)]
    pub counterparty_external: String,

    /// Counterparty's internal (change) key fragment, `.../1/*`.
    #[arg(long)]
    pub counterparty_internal: String,

    /// Optional label.
    #[arg(long)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Role {
    Owner,
    Heir,
}

pub fn run(profile_dir: &Path, args: Args) -> Result<()> {
    if state::vault_path(profile_dir).exists() {
        bail!(
            "vault already exists at {:?}; delete it to overwrite",
            state::vault_path(profile_dir)
        );
    }

    let mn = state::read_mnemonic(profile_dir)
        .context("vault construction requires this profile's mnemonic")?;
    let master = master_xpriv(&mn, args.network)?;
    let (fp, path, xpub) = account_xpub(&master, args.network)?;
    let our_ext = descriptor_key_fragment(fp, &path, &xpub, Chain::External);
    let our_int = descriptor_key_fragment(fp, &path, &xpub, Chain::Internal);

    let (owner_ext, owner_int, heir_ext, heir_int, role) = match args.role {
        Role::Owner => (
            our_ext,
            our_int,
            args.counterparty_external,
            args.counterparty_internal,
            VaultRole::Owner,
        ),
        Role::Heir => (
            args.counterparty_external,
            args.counterparty_internal,
            our_ext,
            our_int,
            VaultRole::Heir,
        ),
    };

    let vault = Vault::new(
        &owner_ext,
        &owner_int,
        &heir_ext,
        &heir_int,
        args.timelock_blocks,
        args.network,
        role,
        args.label,
    )?;

    state::write_vault(profile_dir, &vault.config)?;
    println!("vault written to {:?}", state::vault_path(profile_dir));
    println!("role      : {:?}", role);
    println!("network   : {:?}", args.network);
    println!("timelock  : {} blocks", args.timelock_blocks);
    println!("descriptor (external):");
    println!("  {}", vault.descriptor_for(Chain::External));
    println!("descriptor (internal):");
    println!("  {}", vault.descriptor_for(Chain::Internal));
    Ok(())
}
