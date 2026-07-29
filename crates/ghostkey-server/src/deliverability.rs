//! Catching a mistyped address while the owner can still fix it.
//!
//! Tier 1 of #327. The product's whole job is to reach one person on one
//! day years from now. Until this module existed, an address was checked
//! only for having an `@` in it — and only on the heir-update path, never
//! at vault creation. So a typo was stored happily and surfaced when the
//! claim link fired: the one moment it matters and the one moment the
//! owner is not around to fix it.
//!
//! On 2026-07-29 every address on the Resend bounce and suppression list
//! was a misspelling. Seven of sixteen mainnet vaults had an owner email
//! that was never confirmed, and one had been rejected outright by the
//! relay as invalid.
//!
//! What this does is small and certain: given an address, say whether it
//! is one or two edits from a mail domain people actually use. It talks
//! to nothing and contacts nobody, so it discloses nothing about any
//! vault — which is what makes it shippable ahead of any verification
//! flow.
//!
//! # Why there is no MX lookup here
//!
//! A DNS check is strictly stronger and was written first. It is absent
//! deliberately:
//!
//!   - It cannot catch the archetypal case anyway. `gmial.com` is a
//!     registered domain with real MX records, so DNS calls it
//!     deliverable. Only the suggestion below catches it.
//!   - It could not be verified. Against a `systemd-resolved` stub
//!     listener, `hickory-resolver` returned `Unknown` for known-good and
//!     known-bad domains alike, intermittently, taking seconds to do it.
//!     A check whose failure mode is "silently pass" is worse than no
//!     check: it looks present and isn't.
//!
//! Two real findings from that attempt are recorded on #327 for whoever
//! picks it up. RFC 7505's null MX (`MX 0 .`, which `example.com`
//! publishes) is a *non-empty* answer meaning "no mail here", so
//! answer-counting reads it backwards. And RFC 5321 §5.1's implicit MX
//! means a domain with address records and no MX is still deliverable, so
//! a missing MX is not grounds for rejection.

use serde::{Deserialize, Serialize};

/// The mail domains people actually mistype, and the near-misses worth
/// asking about.
///
/// Kept deliberately short. A long list makes false suggestions on
/// legitimate small domains, and since the suggestion is only ever
/// advisory, its whole value is being right nearly every time it fires.
const COMMON_MAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "hotmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "aol.com",
    "protonmail.com",
    "proton.me",
    "gmx.com",
    "zoho.com",
    "yandex.com",
    "mail.com",
];

/// Levenshtein distance.
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    // Two rolling rows rather than the full matrix.
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let sub = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            cur[j] = sub.min(prev[j] + 1).min(cur[j - 1] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Did they mean a common domain?
///
/// `None` when the domain IS a common one, or is not close to any. Fires
/// at distance 1 or 2, which covers the real cases: a transposed pair
/// (`gmial.com`), a dropped letter (`gmai.com`), a wrong TLD
/// (`gmail.con`), a doubled letter (`gmaill.com`).
///
/// Length-guarded, because loosening the bound on a short domain starts
/// producing nonsense suggestions, which would teach owners to ignore the
/// warning entirely.
pub(crate) fn suggest_domain(domain: &str) -> Option<&'static str> {
    let domain = domain.trim().to_ascii_lowercase();
    if COMMON_MAIL_DOMAINS.contains(&domain.as_str()) {
        return None;
    }
    COMMON_MAIL_DOMAINS
        .iter()
        .filter_map(|candidate| {
            let d = edit_distance(&domain, candidate);
            let allowed = if candidate.len() <= 8 { 1 } else { 2 };
            (d <= allowed).then_some((d, *candidate))
        })
        .min()
        .map(|(_, candidate)| candidate)
}

/// The domain half of an email address, lowercased.
pub(crate) fn domain_of(address: &str) -> Option<String> {
    let (local, domain) = address.trim().rsplit_once('@')?;
    if local.is_empty() {
        return None;
    }
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    (!domain.is_empty() && domain.contains('.')).then_some(domain)
}

/// What we can say about one address without contacting anybody.
#[derive(Debug, Serialize)]
pub(crate) struct AddressCheck {
    /// Whether the address is well formed. **Not** a delivery promise —
    /// only the absence of an obvious problem.
    pub ok: bool,
    /// Owner-facing sentence, empty when there is nothing to say.
    pub message: String,
    /// A common domain this one is one or two edits from.
    ///
    /// Present even when `ok` is true, which is the entire point:
    /// `gmial.com` is a real domain that accepts mail, so nothing except
    /// a suggestion can catch it.
    pub suggestion: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CheckRequest {
    pub address: String,
}

/// `POST /contact/check`
///
/// Advisory. Stores nothing, reveals nothing about any vault, and is safe
/// to call while the owner is still typing. Exists so a typo lands in
/// front of the only person who knows the right answer, at the only
/// moment it is cheap to fix.
pub(crate) async fn check_address(
    axum::Json(req): axum::Json<CheckRequest>,
) -> axum::Json<AddressCheck> {
    let Some(domain) = domain_of(&req.address) else {
        return axum::Json(AddressCheck {
            ok: false,
            message: "That doesn't look like an email address.".into(),
            suggestion: None,
        });
    };
    let suggestion = suggest_domain(&domain);
    axum::Json(AddressCheck {
        ok: true,
        message: match suggestion {
            Some(better) => format!("Did you mean {better}?"),
            None => String::new(),
        },
        suggestion,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_is_extracted_and_normalised() {
        assert_eq!(domain_of("a@Example.COM").as_deref(), Some("example.com"));
        // A trailing root dot is legal in DNS and not in a stored address.
        assert_eq!(domain_of("a@example.com.").as_deref(), Some("example.com"));
        assert_eq!(
            domain_of("  a@example.com  ").as_deref(),
            Some("example.com")
        );
        // Take the LAST @, so a quoted local part doesn't split wrongly.
        assert_eq!(domain_of("a@b@example.com").as_deref(), Some("example.com"));

        for bad in ["", "nobody", "@example.com", "a@", "a@localhost", "a@."] {
            assert_eq!(domain_of(bad), None, "{bad:?} has no usable domain");
        }
    }

    /// The typo cases this exists for.
    ///
    /// Every one of these is a real registered domain with real MX
    /// records, so a DNS check calls them all deliverable. The suggestion
    /// is the only thing that catches them.
    #[test]
    fn common_typos_are_suggested() {
        for (typo, expected) in [
            ("gmial.com", "gmail.com"),  // transposition
            ("gmai.com", "gmail.com"),   // dropped letter
            ("gmaill.com", "gmail.com"), // doubled letter
            ("gmail.con", "gmail.com"),  // wrong TLD
            ("gmail.co", "gmail.com"),   // truncated TLD
            ("yahooo.com", "yahoo.com"),
            ("hotmial.com", "hotmail.com"),
            ("outlok.com", "outlook.com"),
            ("iclould.com", "icloud.com"),
        ] {
            assert_eq!(
                suggest_domain(typo),
                Some(expected),
                "{typo} should suggest {expected}"
            );
        }
    }

    /// The other half, and the half that decides whether owners trust the
    /// warning at all: a correct domain must never be second-guessed.
    #[test]
    fn correct_and_unrelated_domains_are_left_alone() {
        for good in COMMON_MAIL_DOMAINS {
            assert_eq!(suggest_domain(good), None, "{good} is correct");
        }
        // Case must not matter.
        assert_eq!(suggest_domain("GMAIL.COM"), None);
        // Real domains that are nobody's typo.
        for other in [
            "ghostkeyapp.com",
            "anthropic.com",
            "nhs.uk",
            "bbc.co.uk",
            "cwru.edu",
            "posteo.de",
            // Real domains two edits from a listed one. `mac.com` is
            // Apple's and sits 2 edits from both `me.com` and
            // `mail.com`; without the length guard it gets falsely
            // flagged, and an owner who is told their correct address
            // is wrong stops reading the warnings.
            //
            // Distance ONE is not in here on purpose. `man.com` really
            // is one edit from `msn.com`, and there is no way to tell
            // which was meant — asking is the correct response to that,
            // which is why this is a question and not a rejection.
            "mac.com",
            "live.co.uk",
        ] {
            assert_eq!(suggest_domain(other), None, "{other} is not a typo");
        }
    }

    /// Short domains are guarded, because loosening the bound makes them
    /// collide with each other. Suggesting "aol.com" to someone using
    /// "me.com" would teach owners to ignore the warning.
    #[test]
    fn short_domains_are_not_confused_with_each_other() {
        assert_eq!(suggest_domain("me.com"), None);
        assert_eq!(suggest_domain("aol.com"), None);
        assert_eq!(suggest_domain("msn.com"), None);
        // One edit still fires on a short domain.
        assert_eq!(suggest_domain("aol.con"), Some("aol.com"));
    }

    #[test]
    fn edit_distance_is_correct() {
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("gmial.com", "gmail.com"), 2);
        assert_eq!(edit_distance("gmail.con", "gmail.com"), 1);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("me.com", "aol.com"), 3);
    }

    #[tokio::test]
    async fn the_endpoint_answers_without_touching_anything() {
        let r = check_address(axum::Json(CheckRequest {
            address: "heir@gmial.com".into(),
        }))
        .await;
        assert!(r.0.ok, "a real domain is not an error, only a question");
        assert_eq!(r.0.suggestion, Some("gmail.com"));
        assert!(r.0.message.contains("gmail.com"), "{}", r.0.message);

        let r = check_address(axum::Json(CheckRequest {
            address: "nonsense".into(),
        }))
        .await;
        assert!(!r.0.ok);
        assert_eq!(r.0.suggestion, None);

        let r = check_address(axum::Json(CheckRequest {
            address: "heir@gmail.com".into(),
        }))
        .await;
        assert!(r.0.ok);
        assert_eq!(r.0.suggestion, None);
        assert!(
            r.0.message.is_empty(),
            "nothing to say about a good address"
        );
    }
}
