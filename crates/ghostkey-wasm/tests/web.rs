//! In-wasm runtime test (issue #93).
//!
//! Proves the signer actually runs across the wasm boundary — that
//! secp256k1 Taproot signing works inside the wasm runtime, not just on
//! the native host. Run with:
//!
//! ```sh
//! wasm-pack test --node crates/ghostkey-wasm
//! ```
//!
//! The signing *logic* (owner vs heir branch, CSV, broadcastability) is
//! verified on a real chain by
//! `ghostkey-core/tests/regtest_e2e.rs::offline_sweep_owner_and_heir`.
//! This test only needs to confirm the wasm build produces a fully-signed
//! transaction, so it uses a fabricated funding tx (its inputs are
//! irrelevant; the signer references its output and signs against the real
//! vault scriptPubKey) and asserts the result is finalized.

#![cfg(target_arch = "wasm32")]

use bitcoin::consensus::encode::deserialize;
use bitcoin::Transaction;
use wasm_bindgen_test::wasm_bindgen_test;

use ghostkey_wasm::sign_sweep;

const FIXTURE: &str = include_str!("fixture_owner.json");

#[wasm_bindgen_test]
fn owner_sweep_signs_in_wasm() {
    // `JsError` isn't `Debug`, but the `JsValue` it converts into is, so we
    // can surface the real message on failure.
    let resp = match sign_sweep(FIXTURE) {
        Ok(s) => s,
        Err(e) => {
            let v: wasm_bindgen::JsValue = e.into();
            panic!("sign_sweep failed in wasm: {v:?}");
        }
    };

    let v: serde_json::Value = serde_json::from_str(&resp).expect("response is JSON");
    let tx_hex = v["tx_hex"].as_str().expect("response has tx_hex");
    assert!(v["txid"].as_str().is_some(), "response has txid");

    let bytes: Vec<u8> = (0..tx_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&tx_hex[i..i + 2], 16).unwrap())
        .collect();
    let tx: Transaction = deserialize(&bytes).expect("tx_hex deserializes");

    assert_eq!(tx.input.len(), 1, "one funding UTXO -> one input");
    assert!(
        !tx.input[0].witness.is_empty(),
        "input must be signed (Taproot witness present) — proves wasm signing works"
    );
    assert_eq!(tx.output.len(), 1, "drain produces a single output");
}
