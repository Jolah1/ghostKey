/**
 * The heir contact channels, in one place.
 *
 * The setup portals and the "how your heir is reached" edit page all offer
 * the same three ways to reach a heir, with the same labels and placeholders,
 * and all need the same "does this contact fit this channel" check. This kept
 * drifting when it lived in each file, so it lives here.
 *
 * `contactShapeError` mirrors the server's `validate_contact_shape`
 * (crates/ghostkey-server/src/routes.rs): an email needs an `@` with text
 * either side and a dot in the domain; a phone number needs a `+`-prefixed
 * run of at least seven digits (E.164), the format Twilio expects. Keep the
 * two in step so the client and server agree on what's deliverable.
 */
export type HeirContactChannel = "sms" | "email" | "whatsapp";

export interface HeirChannelOption {
  id: HeirContactChannel;
  title: string;
  sub: string;
  placeholder: string;
}

export const HEIR_CHANNELS: HeirChannelOption[] = [
  { id: "sms", title: "SMS", sub: "Phone number", placeholder: "+234 800 000 0000" },
  { id: "whatsapp", title: "WhatsApp", sub: "Same number", placeholder: "+234 800 000 0000" },
  { id: "email", title: "Email", sub: "Inbox", placeholder: "sarah@example.com" },
];

export function looksLikeEmail(contact: string): boolean {
  const at = contact.indexOf("@");
  if (at <= 0) return false;
  const domain = contact.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export function looksLikePhone(contact: string): boolean {
  if (!contact.startsWith("+")) return false;
  const digits = contact.slice(1);
  return digits.length >= 7 && /^\d+$/.test(digits);
}

/**
 * Returns a human error string if `contact` can't be delivered on `channel`,
 * or `null` if it's fine. `contact` is assumed already trimmed.
 */
export function contactShapeError(
  channel: HeirContactChannel,
  contact: string,
): string | null {
  if (channel === "email") {
    return looksLikeEmail(contact) ? null : "That doesn't look like an email address.";
  }
  return looksLikePhone(contact)
    ? null
    : "That doesn't look like a phone number. Use the international format, like +2348000000000.";
}
