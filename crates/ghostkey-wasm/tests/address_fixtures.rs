//! Golden file shared with the web app (#378).
//!
//! The browser derives a vault's deposit address itself, in TypeScript,
//! to check the address the server shows (ghostkey-web/src/vaultAddress.ts).
//! That code must agree with the Rust that builds vaults, byte for byte.
//! This test builds every vault shape GhostKey makes, from fixed keys, and
//! records the first addresses in `ghostkey-web/src/fixtures/vault-addresses.json`.
//! The TypeScript tests check against the same file, so if either side
//! drifts, a test fails.
//!
//! Regenerate after an intentional change:
//!   GHOSTKEY_REGEN_FIXTURES=1 cargo test -p ghostkey-wasm --test address_fixtures
#![cfg(not(target_arch = "wasm32"))]

use bitcoin::bip32::Xpriv;
use bitcoin::Network;
use ghostkey_core::descriptor::{build_descriptor_pair, build_standard_descriptor_from_fragments};
use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
use ghostkey_wasm::derive_addresses_json;
use serde_json::{json, Value};

/// External and internal key fragments for a fixed test seed.
fn key(seed: u8, network: Network) -> (String, String) {
    let master = Xpriv::new_master(network, &[seed; 32]).unwrap();
    let (fp, path, xpub) = account_xpub(&master, network).unwrap();
    (
        descriptor_key_fragment(fp, &path, &xpub, Chain::External),
        descriptor_key_fragment(fp, &path, &xpub, Chain::Internal),
    )
}

fn case(name: &str, network: &str, ext: &str, int: &str) -> Value {
    let derived: Value =
        serde_json::from_str(&derive_addresses_json(ext, int, network, 3).unwrap()).unwrap();
    json!({
        "name": name,
        "network": network,
        "descriptor_external": ext,
        "descriptor_internal": int,
        "external": derived["external"],
        "internal": derived["internal"],
    })
}

fn build() -> Value {
    let mut cases = Vec::new();
    for (net, net_s) in [(Network::Bitcoin, "bitcoin"), (Network::Signet, "signet")] {
        let owner = key(0x11, net);
        let heir = key(0x12, net);

        let std_pair = build_descriptor_pair(&owner.0, &owner.1, &heir.0, &heir.1, 4320).unwrap();
        cases.push(case(
            "standard",
            net_s,
            &std_pair.external,
            &std_pair.internal,
        ));

        // A one-block timelock pushes a single small number, a different
        // script-number encoding from 4320.
        let short = build_descriptor_pair(&owner.0, &owner.1, &heir.0, &heir.1, 1).unwrap();
        cases.push(case(
            "standard-1-block",
            net_s,
            &short.external,
            &short.internal,
        ));

        // The Liana-compatible format new vaults use (#386): the owner is
        // the Taproot internal key, not the NUMS point.
        let liana =
            build_standard_descriptor_from_fragments(&owner.0, &owner.1, &heir.0, &heir.1, 4320)
                .unwrap()
                .pair;
        cases.push(case("liana", net_s, &liana.external, &liana.internal));
        let liana_short =
            build_standard_descriptor_from_fragments(&owner.0, &owner.1, &heir.0, &heir.1, 1)
                .unwrap()
                .pair;
        cases.push(case(
            "liana-1-block",
            net_s,
            &liana_short.external,
            &liana_short.internal,
        ));
    }
    Value::Array(cases)
}

#[test]
fn vault_address_fixtures_match_rust() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../ghostkey-web/src/fixtures/vault-addresses.json");
    let built = build();
    if std::env::var("GHOSTKEY_REGEN_FIXTURES").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&built).unwrap() + "\n").unwrap();
        return;
    }
    let on_disk: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("fixture missing; regenerate (see the module doc)"),
    )
    .unwrap();
    assert_eq!(
        on_disk, built,
        "Rust address derivation no longer matches the web fixture; regenerate it and \
         check the TypeScript tests still pass"
    );
}
