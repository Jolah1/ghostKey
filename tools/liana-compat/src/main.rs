//! Does Liana accept GhostKey vaults? (#386)
//!
//! Runs GhostKey's descriptors through `LianaDescriptor::from_str`, the
//! parser Liana's installer uses when you import a wallet. Exits non-zero
//! if the standard format is rejected, or if the legacy format starts
//! being accepted (which would mean this check has stopped testing what
//! we think it tests).
use std::process::ExitCode;
use std::str::FromStr;

use bitcoin::bip32::Xpriv;
use bitcoin::Network;
use ghostkey_core::descriptor::{build_descriptor_pair, build_standard_descriptor};
use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
use liana::descriptors::LianaDescriptor;

fn main() -> ExitCode {
    let net = Network::Bitcoin;
    let owner_m = Xpriv::new_master(net, &[0x11; 32]).expect("owner master");
    let heir_m = Xpriv::new_master(net, &[0x22; 32]).expect("heir master");
    let (ofp, opath, oxpub) = account_xpub(&owner_m, net).expect("owner account");
    let (hfp, hpath, hxpub) = account_xpub(&heir_m, net).expect("heir account");

    let account = |fp: bitcoin::bip32::Fingerprint,
                   path: &bitcoin::bip32::DerivationPath,
                   xpub: bitcoin::bip32::Xpub| {
        let p = path.to_string();
        format!("[{fp}/{}]{xpub}", p.strip_prefix("m/").unwrap_or(&p))
    };
    let owner = account(ofp, &opath, oxpub);
    let heir = account(hfp, &hpath, hxpub);

    let mut ok = true;

    // The standard format, at GhostKey's shortest and longest waits.
    for (label, blocks) in [
        ("1 month", 4_320),
        ("3 months", 12_960),
        ("12 months", 51_840),
    ] {
        let std = build_standard_descriptor(&owner, &heir, blocks).expect("build standard");
        match LianaDescriptor::from_str(&std.multipath) {
            Ok(_) => println!("ACCEPTED  standard format, {label}"),
            Err(e) => {
                println!(
                    "REJECTED  standard format, {label}: {e}\n          {}",
                    std.multipath
                );
                ok = false;
            }
        }
    }

    // The legacy format must still be rejected. If Liana ever accepts it,
    // this check is no longer telling us what we think.
    let legacy = build_descriptor_pair(
        &descriptor_key_fragment(ofp, &opath, &oxpub, Chain::External),
        &descriptor_key_fragment(ofp, &opath, &oxpub, Chain::Internal),
        &descriptor_key_fragment(hfp, &hpath, &hxpub, Chain::External),
        &descriptor_key_fragment(hfp, &hpath, &hxpub, Chain::Internal),
        12_960,
    )
    .expect("build legacy");
    match LianaDescriptor::from_str(&legacy.external) {
        Ok(_) => {
            println!("UNEXPECTED legacy format accepted; revisit this check");
            ok = false;
        }
        Err(e) => println!("REJECTED  legacy format, as expected: {e}"),
    }

    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
