//! Native-host test of the sweep JSON layer, to isolate logic bugs from
//! wasm-runtime bugs. Uses the same fixture as the in-wasm test.
#![cfg(not(target_arch = "wasm32"))]

use ghostkey_wasm::sign_sweep_json;

const FIXTURE: &str = include_str!("fixture_owner.json");
/// A standard-format vault (#386): owner as the Taproot internal key.
const FIXTURE_STANDARD: &str = include_str!("fixture_owner_standard.json");

#[test]
fn owner_sweep_signs_native() {
    let resp = sign_sweep_json(FIXTURE).expect("sign should succeed");
    assert!(resp.contains("tx_hex"), "got: {resp}");
}

#[test]
fn owner_sweep_signs_native_standard_format() {
    let resp = sign_sweep_json(FIXTURE_STANDARD).expect("sign should succeed");
    assert!(resp.contains("tx_hex"), "got: {resp}");
}

/// A refresh (#94) is an owner sweep of one deposit into the vault's own
/// change address: the existing signer does it without changes. The coin
/// lands back in the vault, so its on-chain lock starts again.
#[test]
fn refresh_signs_back_into_the_vault_change_address() {
    let mut req: serde_json::Value = serde_json::from_str(FIXTURE_STANDARD).unwrap();
    let addrs: serde_json::Value = serde_json::from_str(
        &ghostkey_wasm::derive_addresses_json(
            req["descriptor_external"].as_str().unwrap(),
            req["descriptor_internal"].as_str().unwrap(),
            "regtest",
            1,
        )
        .unwrap(),
    )
    .unwrap();
    let change = addrs["internal"][0].as_str().unwrap().to_string();
    req["recipient"] = serde_json::Value::String(change.clone());
    req["amount_sat"] = serde_json::Value::Null;

    let resp: serde_json::Value =
        serde_json::from_str(&sign_sweep_json(&req.to_string()).expect("refresh signs")).unwrap();
    let tx: bitcoin::Transaction =
        bitcoin::consensus::encode::deserialize_hex(resp["tx_hex"].as_str().unwrap()).unwrap();
    let change_spk = change
        .parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
        .unwrap()
        .assume_checked()
        .script_pubkey();
    assert_eq!(tx.output.len(), 1, "one coin back, no change");
    assert_eq!(tx.output[0].script_pubkey, change_spk);
    assert!(resp["fee_sat"].as_u64().unwrap() > 0);
}
