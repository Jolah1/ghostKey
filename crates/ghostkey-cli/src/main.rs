use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod state;
mod chain;
mod commands;

/// GhostKey CLI — owner/heir operations against a Bitcoin node.
///
/// Stores state in a profile directory (default: `./.ghostkey/<name>`).
#[derive(Debug, Parser)]
#[command(name = "ghostkey", version, about, long_about = None)]
pub struct Cli {
    /// Profile name (subdirectory under --data-dir).
    #[arg(short, long, default_value = "default", global = true)]
    pub profile: String,

    /// Directory that holds all profiles.
    #[arg(long, env = "GHOSTKEY_DATA_DIR", default_value = ".ghostkey", global = true)]
    pub data_dir: PathBuf,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Generate a fresh BIP39 mnemonic and show its derived xpub.
    ///
    /// The mnemonic is written to the profile directory (chmod 600). Run as
    /// either the owner or the heir to bootstrap keys.
    InitKeys(commands::init_keys::Args),

    /// Show the BIP86 account xpub for the profile's mnemonic. Share this
    /// with your counterparty when constructing a vault.
    ShowXpub(commands::show_xpub::Args),

    /// Construct a vault from owner+heir xpubs and a timelock. Writes the
    /// vault config to the profile.
    MakeVault(commands::make_vault::Args),

    /// Print a fresh vault deposit address.
    Address(commands::address::Args),

    /// Sync the profile's watch-only wallet against a bitcoind node.
    Sync(commands::sync::Args),

    /// Show vault balance and last-known check-in state.
    Balance(commands::balance::Args),

    /// Build, sign, and broadcast an owner check-in transaction.
    CheckIn(commands::check_in::Args),

    /// Build, sign, and broadcast a heir-claim transaction (only valid
    /// after the timelock has elapsed for every input).
    Claim(commands::claim::Args),
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("ghostkey=info,info")),
        )
        .compact()
        .init();

    let cli = Cli::parse();
    let profile_dir = cli.data_dir.join(&cli.profile);
    std::fs::create_dir_all(&profile_dir)
        .with_context(|| format!("creating profile dir {:?}", profile_dir))?;

    match cli.command {
        Command::InitKeys(args) => commands::init_keys::run(&profile_dir, args),
        Command::ShowXpub(args) => commands::show_xpub::run(&profile_dir, args),
        Command::MakeVault(args) => commands::make_vault::run(&profile_dir, args),
        Command::Address(args) => commands::address::run(&profile_dir, args),
        Command::Sync(args) => commands::sync::run(&profile_dir, args),
        Command::Balance(args) => commands::balance::run(&profile_dir, args),
        Command::CheckIn(args) => commands::check_in::run(&profile_dir, args),
        Command::Claim(args) => commands::claim::run(&profile_dir, args),
    }
}

#[allow(dead_code)]
fn ensure(condition: bool, msg: &str) -> Result<()> {
    if !condition {
        bail!(msg.to_string());
    }
    Ok(())
}
