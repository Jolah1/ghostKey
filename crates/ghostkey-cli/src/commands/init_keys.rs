use anyhow::{bail, Result};
use bip39::{Language, Mnemonic};
use clap::Args as ClapArgs;
use rand::RngCore;
use std::path::Path;

use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {
    /// Word count (12 or 24). 24 is recommended.
    #[arg(long, default_value_t = 24)]
    pub words: u8,
}

pub fn run(profile_dir: &Path, args: Args) -> Result<()> {
    let bytes = match args.words {
        12 => 16,
        24 => 32,
        n => bail!("unsupported mnemonic word count: {n} (use 12 or 24)"),
    };

    let mut entropy = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut entropy);
    let mn = Mnemonic::from_entropy_in(Language::English, &entropy)?;

    state::write_mnemonic(profile_dir, &mn.to_string())?;
    println!("mnemonic written to {:?}", state::mnemonic_path(profile_dir));
    println!("WARNING: anyone with this file can spend your funds. Back it up offline.");
    println!();
    println!("Words ({}-word):", args.words);
    println!("{}", mn);
    Ok(())
}
