//! The HTML version of every email, built from its plain text when it is
//! sent.
//!
//! Each email is written once, as plain text, where it is queued. This
//! turns that text into the redesign's layout: a navy header, a white
//! card with one heading, short paragraphs and one button, and a footer
//! that keeps the "we never ask" line. The plain text still goes out
//! alongside (multipart/alternative), so nothing is lost in an inbox
//! that won't show HTML, and the wording stays in one place.
//!
//! Rules, so the layout follows the text rather than the other way round:
//!   - the heading is the subject (without a leading tick or symbol);
//!   - "Hi," and the "From GhostKey" sign-off are dropped (the card and
//!     footer say both);
//!   - the first paragraph that is only a link becomes the button, its
//!     label chosen by the kind of email; later bare links stay links;
//!   - links inside text are linked; everything else is escaped.
//!
//! Inline styles only: email apps strip `<style>` and classes. The light
//! palette from the design keeps text readable in every inbox.

const PAGE: &str = "#EEF2F6";
const CARD: &str = "#FFFFFF";
const INK: &str = "#0E1A2B";
const BODY: &str = "#1C2A3C";
const FOOTER: &str = "#556377";
const BUTTON: &str = "#0B7A6D";
const NAVY: &str = "#090D12";
const TEAL: &str = "#2EE6D2";

/// The button's words for each kind of email (see `NotificationKind`).
fn button_label(kind: &str) -> &'static str {
    match kind {
        "claim_link" => "See what they left",
        "pre_deadline_reminder" | "alarm_owner" | "alarm_escalation" => "I'm still here",
        "contact_verification" => "Confirm email",
        "claim_ready" => "Finish my claim",
        "drill_invite" => "Start practice",
        "received" | "funded" | "owner_send" => "See details",
        "owner_recovery" => "Sign in",
        "heir_unreachable" => "Check their email",
        "savings_reminder" => "Add sats",
        "challenge_done" => "See your badge",
        "locked_unlocked" => "See my goal",
        "locked_heir_date" => "Lock it again",
        _ => "Open GhostKey",
    }
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// A URL ends at whitespace; a trailing full stop, comma or bracket is
/// the sentence's, not the link's.
fn split_url(s: &str) -> (&str, &str) {
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    let mut url = &s[..end];
    while let Some(last) = url.chars().last() {
        if matches!(last, '.' | ',' | ')' | ';' | ':' | '!' | '?') {
            url = &url[..url.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    (url, &s[url.len()..])
}

/// Escape a line of text and turn any http(s) links in it into links.
fn linkify(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    loop {
        let at = rest.find("https://").or_else(|| rest.find("http://"));
        let Some(i) = at else {
            out.push_str(&escape(rest));
            return out;
        };
        out.push_str(&escape(&rest[..i]));
        let (url, after) = split_url(&rest[i..]);
        let safe = escape(url);
        out.push_str(&format!(
            "<a href=\"{safe}\" style=\"color:{BUTTON};text-decoration:underline;word-break:break-all\">{safe}</a>"
        ));
        rest = after;
    }
}

fn is_bare_url(p: &str) -> bool {
    let t = p.trim();
    (t.starts_with("https://") || t.starts_with("http://")) && !t.contains(char::is_whitespace)
}

/// The subject without a leading tick or symbol ("✓ Your send…"), but
/// keeping a sign that's part of the words ("+21,000 sats…").
/// Attributes are always double-quoted, so `escape` leaves apostrophes.
fn heading_from(subject: &str) -> &str {
    subject
        .trim_start_matches(|c: char| !(c.is_alphanumeric() || "+-$₦\"'".contains(c)))
        .trim()
}

/// Build the HTML part for one email.
pub fn render(kind: &str, subject: &str, body: &str) -> String {
    let paragraphs: Vec<&str> = body
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let l = p.to_ascii_lowercase();
            !(l == "hi," || l == "hello," || l == "from ghostkey" || l == "from ghostkey.")
        })
        .collect();

    let preview = paragraphs
        .iter()
        .find(|p| !is_bare_url(p))
        .map(|p| {
            let one_line = p.split_whitespace().collect::<Vec<_>>().join(" ");
            one_line.chars().take(110).collect::<String>()
        })
        .unwrap_or_default();

    let mut content = String::new();
    let mut button_done = false;
    for p in &paragraphs {
        if is_bare_url(p) && !button_done {
            let (url, _) = split_url(p.trim());
            let safe = escape(url);
            content.push_str(&format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:24px 0\"><tr><td style=\"border-radius:999px;background:{BUTTON}\">\
<a href=\"{safe}\" style=\"display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px\">{label}</a>\
</td></tr></table>",
                label = escape(button_label(kind)),
            ));
            button_done = true;
            continue;
        }
        let lines: Vec<String> = p.lines().map(|l| linkify(l.trim_end())).collect();
        content.push_str(&format!(
            "<p style=\"margin:0 0 16px;font-size:16px;line-height:1.55;color:{BODY}\">{}</p>",
            lines.join("<br>")
        ));
    }

    let says_never_ask = body.to_ascii_lowercase().contains("never ask");
    let footer_line = if says_never_ask {
        "From GhostKey".to_string()
    } else {
        "We never ask for your password or seed phrase. · From GhostKey".to_string()
    };

    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title></head>\
<body style=\"margin:0;padding:0;background:{PAGE}\">\
<div style=\"display:none;max-height:0;overflow:hidden;opacity:0\">{preview}</div>\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:{PAGE}\"><tr><td align=\"center\" style=\"padding:24px 12px\">\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif\">\
<tr><td style=\"background:{NAVY};border-radius:20px 20px 0 0;padding:20px 28px;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#FFFFFF\">ghost<span style=\"color:{TEAL}\">Key</span></td></tr>\
<tr><td style=\"background:{CARD};border-radius:0 0 20px 20px;padding:32px 28px 20px\">\
<h1 style=\"margin:0 0 16px;font-size:26px;line-height:1.2;font-weight:800;color:{INK}\">{heading}</h1>\
{content}\
</td></tr>\
<tr><td style=\"padding:20px 28px;font-size:13px;line-height:1.5;color:{FOOTER}\">{footer}</td></tr>\
</table></td></tr></table></body></html>",
        title = escape(subject),
        preview = escape(&preview),
        heading = escape(heading_from(subject)),
        footer = escape(&footer_line),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_bare_link_becomes_the_button_labelled_for_the_email() {
        let body = "Hi,\n\nYour check-in is due on 27 May.\n\nhttps://www.ghostkeyapp.com/#/checkin-link/v/t\n\nFrom GhostKey";
        let html = render(
            "pre_deadline_reminder",
            "Still there? Sign in by 27 May",
            body,
        );
        assert!(html.contains(">I'm still here</a>"));
        assert!(html.contains("href=\"https://www.ghostkeyapp.com/#/checkin-link/v/t\""));
        assert!(html.contains("<h1"));
        assert!(html.contains("Still there? Sign in by 27 May</h1>"));
        // The greeting and sign-off are dropped; the footer signs off.
        assert!(!html.contains(">Hi,<"));
        assert_eq!(html.matches("From GhostKey").count(), 1);
        assert!(html.contains("We never ask for your password or seed phrase."));
    }

    #[test]
    fn text_is_escaped_and_inline_links_are_linked() {
        let body = "Tolu <tolu@example.com> says: open https://example.com/x. Thanks & bye.";
        let html = render("received", "✓ +21,000 sats landed", body);
        assert!(html.contains("&lt;tolu@example.com&gt;"));
        assert!(html.contains("Thanks &amp; bye."));
        // The trailing full stop belongs to the sentence.
        assert!(html.contains("href=\"https://example.com/x\""));
        assert!(html.contains("</a>. Thanks"));
        // The heading loses the leading tick.
        assert!(html.contains(">+21,000 sats landed</h1>"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn a_body_that_already_says_never_ask_is_not_repeated() {
        let body = format!(
            "Hello Ada,\n\nSomething for you.\n\n{}",
            crate::notifier::NEVER_ASK_EMAIL
        );
        let html = render("claim_link", "Tolu asked us to reach you", &body);
        assert_eq!(html.to_ascii_lowercase().matches("never ask").count(), 1);
        // The multi-line list keeps its line breaks.
        assert!(html.contains("<br>"));
    }

    #[test]
    fn only_the_first_bare_link_is_a_button() {
        let body = "One.\n\nhttps://a.example/1\n\nTwo.\n\nhttps://a.example/2";
        let html = render("welcome", "Welcome", body);
        assert_eq!(html.matches("border-radius:999px;background:").count(), 1);
        assert!(html.contains("href=\"https://a.example/2\""));
    }
}
