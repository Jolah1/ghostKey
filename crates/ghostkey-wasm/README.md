# ghostkey-wasm

WASM bindings for the GhostKey offline sweep signer (issue #93).

The browser recovery kit runs offline and cannot sync a wallet. This crate
exposes one function, `sign_sweep(request_json) -> response_json`, that
builds and fully signs an owner or heir spend **locally in the browser**,
reusing the audited `ghostkey-core` signing path. The kit fetches the
vault's funding transactions from a chain source the user picks (any
Esplora, or pasted by hand), passes them in, and gets back a finished,
signed transaction to broadcast anywhere.

See `src/lib.rs` for the exact `SweepRequest` / `SweepResponse` JSON shape.

## Building the WASM artifact

The build needs two things beyond the normal Rust toolchain:

1. **`clang`**: secp256k1 ships C that must be compiled to wasm.
   - Debian/Ubuntu: `sudo apt-get install -y clang`
2. **`wasm-pack`**: `cargo install wasm-pack` (or `wasm-bindgen-cli`).

Then:

```sh
wasm-pack build crates/ghostkey-wasm --target web --release
```

This emits a `pkg/` with the `.wasm` plus JS glue. The kit's single-file
build (`ghostkey-web/vite.kit.config.ts`) inlines the `.wasm` as base64 so
the kit still works from `file://` with no network.

## Why native `cargo` still covers it

`ghostkey-wasm` is a workspace member, so `cargo check`/`clippy` build it on
the host target (native secp256k1 uses the system C compiler). That catches
any breakage when `ghostkey-core` changes, even without the wasm toolchain.
The wasm32 build and the in-browser end-to-end test are the steps that need
`clang` + `wasm-pack`.

## Verification

The signing logic this wraps is verified end-to-end on regtest in
`crates/ghostkey-core/tests/regtest_e2e.rs::offline_sweep_owner_and_heir`
(owner spends immediately; heir is rejected pre-timelock and confirms once
the relative timelock matures). The wasm layer is a thin JSON translation
over that proven code.
