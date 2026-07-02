//! Web Push sender: RFC 8030 (push), RFC 8291 (aes128gcm message
//! encryption), RFC 8292 (VAPID auth) — implemented directly on the
//! RustCrypto stack + the reqwest client we already ship.
//!
//! ## Why not the `web-push` crate?
//!
//! Same rationale as the hand-rolled Twilio integration in
//! `notifier.rs`: the surface we need is one encrypted POST with a
//! signed JWT, and the crate would pin legacy hyper 0.14 / http 0.2
//! and its own crypto backend. The encryption scheme is fully
//! specified with an official test vector (RFC 8291 Appendix A),
//! which this module's tests reproduce byte-for-byte — that's a
//! stronger correctness anchor than trusting a transitive dep.
//!
//! ## Key material
//!
//! VAPID is a long-lived P-256 keypair identifying *this server* to
//! the browser push services (FCM, Mozilla autopush, APNs web push).
//! Configured via:
//!
//!   - `GHOSTKEY_VAPID_PRIVATE_KEY` — 32-byte scalar, base64url
//!     no-pad (the format `npx web-push generate-vapid-keys` emits).
//!   - `GHOSTKEY_VAPID_SUBJECT` — `mailto:` contact URI the push
//!     service may use to reach the operator. Defaults to a
//!     placeholder with a startup warning.
//!
//! The public key is derived from the private key (never configured
//! separately, so the pair can't drift apart) and surfaced to the
//! web client via `GET /health` as `push_public_key`. Rotating the
//! private key silently invalidates every existing subscription —
//! browsers will return 403/401 VAPID mismatches which we treat as
//! permanent and prune. Don't rotate casually.
//!
//! ## What a push payload is here
//!
//! The scheduler enqueues a `webpush`-channel notification whose
//! body is a small JSON object `{title, body, url}`. This module
//! encrypts those bytes; the service worker (`push-sw.js` in the
//! web app) decrypts nothing — the browser push stack decrypts
//! transparently — it just parses the JSON and shows a notification
//! whose click opens `url` (the one-tap check-in link).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand::RngCore;
use sha2::Sha256;

/// Push-service response statuses we map to "subscription is dead,
/// delete the row": 404 and 410 per RFC 8030 §7.3.
#[derive(Debug, thiserror::Error)]
pub enum PushError {
    /// The subscription no longer exists at the push service. The
    /// caller should delete the stored row and not retry.
    #[error("subscription gone (push service returned 404/410)")]
    Gone,
    /// Anything that might succeed on a later attempt: network
    /// failures, 429, 5xx.
    #[error("transient: {0}")]
    Transient(String),
    /// Misconfiguration or malformed stored data; retrying with the
    /// same inputs cannot succeed.
    #[error("permanent: {0}")]
    Permanent(String),
}

/// Server-wide VAPID identity, loaded from env once per worker boot.
#[derive(Clone)]
pub struct VapidConfig {
    /// P-256 private scalar. Kept as the parsed key, not the raw
    /// env string, so a typo fails at boot-time load rather than on
    /// the first send.
    private_key: p256::SecretKey,
    /// Uncompressed SEC1 point (65 bytes), base64url no-pad. This is
    /// what the browser passes as `applicationServerKey` and what
    /// goes into the `k=` half of the Authorization header.
    pub public_key_b64: String,
    /// `mailto:` URI included in the signed JWT (`sub` claim).
    pub subject: String,
}

impl std::fmt::Debug for VapidConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never Debug-print the private scalar.
        f.debug_struct("VapidConfig")
            .field("public_key_b64", &self.public_key_b64)
            .field("subject", &self.subject)
            .finish_non_exhaustive()
    }
}

impl VapidConfig {
    /// Load from env. Returns `None` when `GHOSTKEY_VAPID_PRIVATE_KEY`
    /// is unset/empty (the "web push not configured" signal — same
    /// shape as `SmtpConfig::from_env`). A set-but-malformed key logs
    /// an error and returns `None` rather than panicking: the rest of
    /// the server is useful without push.
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var("GHOSTKEY_VAPID_PRIVATE_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let bytes = match B64URL.decode(raw.trim()) {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "GHOSTKEY_VAPID_PRIVATE_KEY is not base64url; web push disabled"
                );
                return None;
            }
        };
        let private_key = match p256::SecretKey::from_slice(&bytes) {
            Ok(k) => k,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "GHOSTKEY_VAPID_PRIVATE_KEY is not a valid P-256 scalar; web push disabled"
                );
                return None;
            }
        };
        let public_key_b64 = B64URL.encode(
            private_key
                .public_key()
                .to_encoded_point(false) // uncompressed: 0x04 || X || Y
                .as_bytes(),
        );
        let subject = std::env::var("GHOSTKEY_VAPID_SUBJECT")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                tracing::warn!(
                    "GHOSTKEY_VAPID_SUBJECT unset; using a placeholder mailto. \
                     Set a real operator contact for production."
                );
                "mailto:ops@ghostkeyapp.com".to_string()
            });
        Some(VapidConfig {
            private_key,
            public_key_b64,
            subject,
        })
    }

    /// Convenience for `/health`: the public key if push is
    /// configured. Reads env each call (cheap: one base-point
    /// multiply) to stay test-friendly — no OnceLock to poison
    /// across test cases.
    pub fn public_key_from_env() -> Option<String> {
        Self::from_env().map(|c| c.public_key_b64)
    }
}

/// Why a push endpoint was rejected. `Invalid` is structural (wrong
/// scheme, no host, or a non-public target) and will never become
/// valid, so callers should refuse it at subscribe time and prune it
/// at send time. `Unresolvable` is a transient DNS failure that may
/// clear later.
#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unresolvable(String),
}

/// True if `ip` is a publicly routable unicast address.
///
/// Allowlist-shaped: everything that is loopback, private (RFC1918),
/// CGNAT, link-local, unique-local, unspecified, multicast/broadcast,
/// or a reserved/documentation range is rejected. This is the SSRF
/// guard for web-push endpoints — a subscription is an
/// attacker-suppliable URL the server later POSTs to, and on Fly's
/// 6PN private network an unchecked endpoint could reach internal
/// apps (`fdaa::/16`, inside `fc00::/7`).
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
    {
        return false;
    }
    let o = ip.octets();
    // 0.0.0.0/8 "this network".
    if o[0] == 0 {
        return false;
    }
    // 100.64.0.0/10 carrier-grade NAT (no stable std predicate).
    if o[0] == 100 && (o[1] & 0xc0) == 0x40 {
        return false;
    }
    // 192.0.0.0/24 IETF protocol assignments.
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return false;
    }
    // 198.18.0.0/15 benchmarking.
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return false;
    }
    // 240.0.0.0/4 reserved (broadcast 255.255.255.255 already caught).
    if o[0] >= 240 {
        return false;
    }
    true
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    // IPv4-mapped ::ffff:a.b.c.d — classify by the embedded v4 so an
    // attacker can't smuggle a private v4 target through a v6 literal.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let seg = ip.segments();
    // Unique-local fc00::/7 (covers Fly 6PN fdaa::/16).
    if (seg[0] & 0xfe00) == 0xfc00 {
        return false;
    }
    // Link-local fe80::/10.
    if (seg[0] & 0xffc0) == 0xfe80 {
        return false;
    }
    // Documentation 2001:db8::/32.
    if seg[0] == 0x2001 && seg[1] == 0x0db8 {
        return false;
    }
    true
}

/// Reject a push endpoint that is not HTTPS or that resolves to any
/// non-public address. Called at subscribe time (refuse before the row
/// is ever stored) and again immediately before each send (so a host
/// that resolved public at subscribe but flips to a private address
/// later — DNS rebinding — is caught before the POST goes out).
///
/// A domain that resolves to multiple addresses is rejected if *any*
/// of them is non-public, so an attacker can't hide an internal target
/// behind one public A record.
pub async fn assert_endpoint_public(endpoint: &str) -> Result<(), EndpointError> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|e| EndpointError::Invalid(format!("endpoint is not a URL: {e}")))?;
    if url.scheme() != "https" {
        return Err(EndpointError::Invalid("endpoint must be https".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| EndpointError::Invalid("endpoint has no host".into()))?;
    // `host_str()` brackets IPv6 literals (`[::1]`); strip before parse.
    let host_unbracketed = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let port = url.port_or_known_default().unwrap_or(443);

    // Literal IP host: check directly, no DNS.
    if let Ok(ip) = host_unbracketed.parse::<IpAddr>() {
        return if is_public_ip(ip) {
            Ok(())
        } else {
            Err(EndpointError::Invalid(
                "endpoint resolves to a non-public address".into(),
            ))
        };
    }

    let addrs = tokio::net::lookup_host((host_unbracketed, port))
        .await
        .map_err(|e| {
            EndpointError::Unresolvable(format!("could not resolve endpoint host: {e}"))
        })?;
    let mut saw_any = false;
    for addr in addrs {
        saw_any = true;
        if !is_public_ip(addr.ip()) {
            return Err(EndpointError::Invalid(
                "endpoint resolves to a non-public address".into(),
            ));
        }
    }
    if !saw_any {
        return Err(EndpointError::Unresolvable(
            "endpoint host did not resolve".into(),
        ));
    }
    Ok(())
}

/// One browser subscription as stored in `push_subscriptions`:
/// the `PushSubscription.toJSON()` triple.
pub struct Subscription<'a> {
    pub endpoint: &'a str,
    /// Browser's P-256 ECDH public key, base64url (65-byte SEC1).
    pub p256dh_b64: &'a str,
    /// 16-byte shared auth secret, base64url.
    pub auth_b64: &'a str,
}

/// Encrypt `payload` for the subscription and POST it to the push
/// service with a VAPID-signed Authorization header.
pub async fn send(
    http: &reqwest::Client,
    cfg: &VapidConfig,
    sub: &Subscription<'_>,
    payload: &[u8],
) -> Result<(), PushError> {
    // SSRF guard, re-run per send to defeat DNS rebinding. A
    // definitively-bad target (non-public / not https) is treated as
    // Gone so the row is pruned; a transient resolution failure is
    // Transient so a real subscription isn't dropped over a DNS blip.
    match assert_endpoint_public(sub.endpoint).await {
        Ok(()) => {}
        Err(EndpointError::Invalid(msg)) => {
            tracing::warn!(endpoint = %sub.endpoint, reason = %msg, "push endpoint not public; pruning");
            return Err(PushError::Gone);
        }
        Err(EndpointError::Unresolvable(msg)) => {
            return Err(PushError::Transient(msg));
        }
    }

    let ua_public = B64URL
        .decode(sub.p256dh_b64)
        .map_err(|e| PushError::Permanent(format!("stored p256dh not base64url: {e}")))?;
    let auth_secret = B64URL
        .decode(sub.auth_b64)
        .map_err(|e| PushError::Permanent(format!("stored auth not base64url: {e}")))?;

    // Fresh ephemeral key + salt per message, per RFC 8291 §3.1.
    let as_secret = p256::SecretKey::random(&mut rand::thread_rng());
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);

    let body = encrypt_aes128gcm(&as_secret, &salt, &ua_public, &auth_secret, payload)
        .map_err(PushError::Permanent)?;

    let auth_header = vapid_authorization(cfg, sub.endpoint)?;

    let resp = http
        .post(sub.endpoint)
        .header("Authorization", auth_header)
        .header("Content-Encoding", "aes128gcm")
        // 24h TTL: a check-in reminder older than a day is stale —
        // the alarm path will have produced a fresher message.
        .header("TTL", "86400")
        // High urgency wakes devices in power-save mode; appropriate
        // for "your dead-man switch is about to fire".
        .header("Urgency", "high")
        .body(body)
        .send()
        .await
        .map_err(|e| PushError::Transient(format!("push POST failed: {e}")))?;

    match resp.status().as_u16() {
        200..=202 => Ok(()),
        404 | 410 => Err(PushError::Gone),
        429 | 500..=599 => Err(PushError::Transient(format!(
            "push service returned {}",
            resp.status()
        ))),
        s => {
            // 400/401/403: bad VAPID key or malformed request. The
            // same row will fail forever; surface as permanent so the
            // worker doesn't burn retries.
            let excerpt: String = resp
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            Err(PushError::Permanent(format!(
                "push service returned {s}: {excerpt}"
            )))
        }
    }
}

/// RFC 8292 §2: short-lived ES256 JWT over the endpoint's origin.
fn vapid_authorization(cfg: &VapidConfig, endpoint: &str) -> Result<String, PushError> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|e| PushError::Permanent(format!("stored endpoint is not a URL: {e}")))?;
    let aud = url.origin().ascii_serialization();

    // 12h expiry: max allowed is 24h; half that gives clock-skew
    // headroom without re-signing per message batch.
    let exp = chrono::Utc::now().timestamp() + 12 * 3600;

    let header = B64URL.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64URL
        .encode(serde_json::json!({ "aud": aud, "exp": exp, "sub": cfg.subject }).to_string());
    let signing_input = format!("{header}.{claims}");

    let signing_key = p256::ecdsa::SigningKey::from(&cfg.private_key);
    // ES256 JWT wants the raw fixed-width r||s form (64 bytes), not
    // ASN.1 DER. `Signature::to_bytes` is exactly that.
    let signature: p256::ecdsa::Signature = signing_key.sign(signing_input.as_bytes());
    let jwt = format!("{signing_input}.{}", B64URL.encode(signature.to_bytes()));

    Ok(format!("vapid t={jwt}, k={}", cfg.public_key_b64))
}

/// RFC 8291 §3: derive the content-encryption key + nonce from an
/// ECDH agreement and seal one record. Returns the full `aes128gcm`
/// body: header (salt | rs | idlen | as_public) followed by the
/// ciphertext+tag.
///
/// Split out from [`send`] with explicit `as_secret` / `salt` inputs
/// so the unit test can replay the RFC's Appendix A vector
/// deterministically.
fn encrypt_aes128gcm(
    as_secret: &p256::SecretKey,
    salt: &[u8; 16],
    ua_public_sec1: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::KeyInit;

    // `from_sec1_bytes` validates the point is on the curve — the
    // RFC 8291 security considerations require rejecting invalid
    // public keys before running ECDH with them.
    let ua_public = p256::PublicKey::from_sec1_bytes(ua_public_sec1)
        .map_err(|e| format!("subscription p256dh is not a valid P-256 point: {e}"))?;
    if auth_secret.len() != 16 {
        return Err(format!(
            "subscription auth secret must be 16 bytes, got {}",
            auth_secret.len()
        ));
    }

    let as_public_bytes = as_secret.public_key().to_encoded_point(false);
    let as_public_bytes = as_public_bytes.as_bytes(); // 65

    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());

    // IKM = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0" || ua_pub || as_pub, 32)
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public_sec1);
    key_info.extend_from_slice(as_public_bytes);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");

    // CEK / NONCE per RFC 8188 with the RFC 8291 info strings.
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .expect("16 bytes is a valid HKDF-SHA256 output length");
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("12 bytes is a valid HKDF-SHA256 output length");

    // Single record: plaintext || 0x02 (last-record delimiter).
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02);

    let cipher = aes_gcm::Aes128Gcm::new((&cek).into());
    let ct = cipher
        .encrypt((&nonce).into(), record.as_slice())
        .map_err(|e| format!("AES-GCM encrypt failed: {e}"))?;

    // Header: salt(16) | record-size u32be | idlen u8 | keyid(as_public).
    // Record size 4096 matches the RFC example; our payloads are a
    // few hundred bytes, well within one record.
    let mut out = Vec::with_capacity(16 + 4 + 1 + 65 + ct.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(65);
    out.extend_from_slice(as_public_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8291 Appendix A: replay the official end-to-end vector.
    /// If this passes, every derivation step (ECDH, both HKDF stages,
    /// AES-128-GCM, header layout, padding byte) is byte-correct.
    #[test]
    fn rfc8291_appendix_a_vector() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let as_private = B64URL
            .decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
            .unwrap();
        let ua_public = B64URL
            .decode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
            .unwrap();
        let auth_secret = B64URL.decode("BTBZMqHH6r4Tts7J_aSIgg").unwrap();
        let salt: [u8; 16] = B64URL
            .decode("DGv6ra1nlYgDCS1FRnbzlw")
            .unwrap()
            .try_into()
            .unwrap();

        let as_secret = p256::SecretKey::from_slice(&as_private).unwrap();
        let body =
            encrypt_aes128gcm(&as_secret, &salt, &ua_public, &auth_secret, plaintext).unwrap();

        // Expected: 86-byte header || 58-byte ciphertext, from the
        // RFC's Section 5 / Appendix A (whitespace removed).
        let expected_header = B64URL
            .decode(
                "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
            )
            .unwrap();
        let expected_ct = B64URL
            .decode(
                "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
            )
            .unwrap();

        assert_eq!(&body[..86], &expected_header[..], "header mismatch");
        assert_eq!(&body[86..], &expected_ct[..], "ciphertext mismatch");
    }

    #[test]
    fn rejects_invalid_ua_public_key() {
        let as_secret = p256::SecretKey::random(&mut rand::thread_rng());
        let salt = [0u8; 16];
        // 65 bytes that are not a curve point.
        let bogus = [0x04u8; 65];
        let err = encrypt_aes128gcm(&as_secret, &salt, &bogus, &[0u8; 16], b"x");
        assert!(err.is_err(), "off-curve point must be rejected");
    }

    #[test]
    fn rejects_wrong_auth_secret_length() {
        let as_secret = p256::SecretKey::random(&mut rand::thread_rng());
        let ua = p256::SecretKey::random(&mut rand::thread_rng());
        let ua_pub = ua.public_key().to_encoded_point(false);
        let salt = [0u8; 16];
        let err = encrypt_aes128gcm(&as_secret, &salt, ua_pub.as_bytes(), &[0u8; 8], b"x");
        assert!(err.is_err());
    }

    #[test]
    fn vapid_header_shape() {
        // Build a config directly (no env) and check the header
        // parts parse back out.
        let sk = p256::SecretKey::random(&mut rand::thread_rng());
        let pk_b64 = B64URL.encode(sk.public_key().to_encoded_point(false).as_bytes());
        let cfg = VapidConfig {
            private_key: sk,
            public_key_b64: pk_b64.clone(),
            subject: "mailto:test@example.com".into(),
        };
        let header =
            vapid_authorization(&cfg, "https://fcm.googleapis.com/fcm/send/abc123").unwrap();
        assert!(header.starts_with("vapid t="));
        assert!(header.ends_with(&format!("k={pk_b64}")));
        // JWT: three dot-separated base64url segments.
        let t = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT must have 3 segments");
        let claims: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:test@example.com");
        // Signature is fixed-width r||s.
        assert_eq!(B64URL.decode(parts[2]).unwrap().len(), 64);
    }

    #[test]
    fn public_ip_classifier_rejects_internal_ranges() {
        use std::net::IpAddr;
        let public = [
            "8.8.8.8",
            "1.1.1.1",
            "142.250.72.196", // fcm/google
            "2606:4700:4700::1111",
        ];
        for s in public {
            assert!(
                is_public_ip(s.parse::<IpAddr>().unwrap()),
                "{s} should be public"
            );
        }
        let internal = [
            "127.0.0.1",       // loopback
            "10.0.0.5",        // RFC1918
            "192.168.1.1",     // RFC1918
            "172.16.0.1",      // RFC1918
            "169.254.169.254", // link-local / cloud metadata
            "100.64.0.1",      // CGNAT
            "0.0.0.0",         // this-network
            "::1",             // v6 loopback
            "fd00::1",         // v6 ULA
            "fdaa:0:1::1",     // Fly 6PN
            "fe80::1",         // v6 link-local
            "::ffff:10.0.0.1", // v4-mapped private
        ];
        for s in internal {
            assert!(
                !is_public_ip(s.parse::<IpAddr>().unwrap()),
                "{s} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn assert_endpoint_rejects_non_https_and_literal_private() {
        assert!(matches!(
            assert_endpoint_public("http://fcm.googleapis.com/x").await,
            Err(EndpointError::Invalid(_))
        ));
        assert!(matches!(
            assert_endpoint_public("https://127.0.0.1/x").await,
            Err(EndpointError::Invalid(_))
        ));
        assert!(matches!(
            assert_endpoint_public("https://[::1]/x").await,
            Err(EndpointError::Invalid(_))
        ));
        assert!(matches!(
            assert_endpoint_public("https://169.254.169.254/latest/meta-data").await,
            Err(EndpointError::Invalid(_))
        ));
        // A literal public IP over https is allowed.
        assert!(assert_endpoint_public("https://1.1.1.1/x").await.is_ok());
    }
}
