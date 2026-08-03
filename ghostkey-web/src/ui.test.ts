import { describe, it, expect } from "vitest";
import { friendlyEventKind } from "./ui";

describe("friendlyEventKind (#117 T4)", () => {
  it("maps known database codes to plain English", () => {
    expect(friendlyEventKind("owner_send")).toBe("You sent Bitcoin");
    expect(friendlyEventKind("vault_empty")).toBe("Vault is empty");
    expect(friendlyEventKind("lightning_invoice_issued")).toBe(
      "Check-in invoice created",
    );
    expect(friendlyEventKind("checkin")).toBe("Checked in");
    expect(friendlyEventKind("owner_contact_verified")).toBe("Email confirmed");
    expect(friendlyEventKind("claim_broadcast")).toBe(
      "Your heir broadcast the claim",
    );
  });

  it("never leaks a raw snake_case code for an unmapped event", () => {
    // The whole point of T4: no database labels in the activity feed.
    const out = friendlyEventKind("some_future_event");
    expect(out).toBe("Some future event");
    expect(out).not.toContain("_");
  });
});
