//! LNURL-pay support.
//!
//! Each vault gets two static LNURL-pay endpoints — one for check-in, one
//! for panic-stop. The owner's wallet hits `/lnurlp/:id` to fetch the
//! `payRequest` metadata, then hits the returned `callback` URL with the
//! pinned amount (see `lightning::heartbeat_amount_sat`); we mint a BOLT11
//! and return it as `payResponse`. Once the
//! invoice settles, the Lightning poller dispatches on `invoice_type` to
//! either reset the check-in deadline or freeze the vault.
//!
//! LNURL-pay clients expect HTTP 200 with `{"status":"ERROR","reason":...}`
//! on protocol-level errors — never a 4xx/5xx — so every handler returns
//! JSON, never bails with an HTTP status code.
//!
//! Spec: https://github.com/lnurl/luds/blob/luds/06.md

use bech32::{Bech32, Hrp};

/// Bech32-encode a URL as an `lnurl1...` string (uppercase per LNURL convention).
pub fn encode(url: &str) -> String {
    let hrp = Hrp::parse("lnurl").expect("lnurl is a valid bech32 HRP");
    let encoded = bech32::encode::<Bech32>(hrp, url.as_bytes())
        .expect("LNURL bech32 encode cannot fail for ascii URLs");
    encoded.to_uppercase()
}

/// LNURL-pay `payRequest` JSON for a check-in invoice. The amount is
/// pinned: min == max == `amount_sat`.
pub fn pay_request_json(callback_url: &str, amount_sat: u64) -> String {
    pay_request_json_with_metadata(callback_url, amount_sat, "GhostKey vault check-in")
}

/// LNURL-pay `payRequest` JSON for a panic-stop invoice. The amount is
/// pinned: min == max == `amount_sat`.
pub fn panic_pay_request_json(callback_url: &str, amount_sat: u64) -> String {
    pay_request_json_with_metadata(callback_url, amount_sat, "GhostKey panic stop")
}

fn pay_request_json_with_metadata(callback_url: &str, amount_sat: u64, label: &str) -> String {
    // LUD-06 metadata is a JSON-encoded array of [mime, content] pairs,
    // itself embedded as a JSON string.
    let metadata = serde_json::to_string(&serde_json::json!([["text/plain", label],]))
        .expect("metadata array always serializes");
    let msat = amount_sat * 1000;
    serde_json::json!({
        "tag": "payRequest",
        "callback": callback_url,
        "minSendable": msat,
        "maxSendable": msat,
        "metadata": metadata,
        "commentAllowed": 0,
    })
    .to_string()
}

/// LNURL-pay `payResponse` JSON containing the bolt11 invoice.
pub fn pay_response_json(bolt11: &str) -> String {
    serde_json::json!({
        "pr": bolt11,
        "routes": [],
    })
    .to_string()
}

/// LNURL error response (HTTP 200, status=ERROR).
pub fn error_json(reason: &str) -> String {
    serde_json::json!({
        "status": "ERROR",
        "reason": reason,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_is_uppercase_and_lnurl_prefixed() {
        let s = encode("https://example.com/lnurlp/vault-123");
        assert!(s.starts_with("LNURL1"), "got {s}");
        assert_eq!(s, s.to_uppercase());
    }

    #[test]
    fn pay_request_pins_amount() {
        let j = pay_request_json("https://example.com/cb", 21);
        let v: serde_json::Value = serde_json::from_str(&j).unwrap();
        assert_eq!(v["minSendable"], 21_000);
        assert_eq!(v["maxSendable"], 21_000);
        assert_eq!(v["tag"], "payRequest");
    }

    #[test]
    fn error_json_has_status_error() {
        let v: serde_json::Value = serde_json::from_str(&error_json("nope")).unwrap();
        assert_eq!(v["status"], "ERROR");
        assert_eq!(v["reason"], "nope");
    }
}
