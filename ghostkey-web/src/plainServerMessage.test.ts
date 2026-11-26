import { describe, expect, it } from "vitest";
import { plainServerMessage } from "./api";

describe("plainServerMessage", () => {
  it("drops the server's log label", () => {
    expect(plainServerMessage("validation: the Bitcoin network lookup is busy")).toBe(
      "The Bitcoin network lookup is busy",
    );
    expect(plainServerMessage("conflict: already claimed")).toBe("Already claimed");
  });
  it("leaves other messages alone", () => {
    expect(plainServerMessage("That isn't a transaction.")).toBe("That isn't a transaction.");
    expect(plainServerMessage("502 Bad Gateway")).toBe("502 Bad Gateway");
  });
});
