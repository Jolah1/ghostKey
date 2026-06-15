//! Native-host test of the sweep JSON layer, to isolate logic bugs from
//! wasm-runtime bugs. Uses the same fixture as the in-wasm test.
#![cfg(not(target_arch = "wasm32"))]

use ghostkey_wasm::sign_sweep_json;

const FIXTURE: &str = include_str!("fixture_owner.json");

#[test]
fn owner_sweep_signs_native() {
    let resp = sign_sweep_json(FIXTURE).expect("sign should succeed");
    assert!(resp.contains("tx_hex"), "got: {resp}");
}
