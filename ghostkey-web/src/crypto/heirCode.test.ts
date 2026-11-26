import { describe, expect, it } from "vitest";
import {
  checkHeirCode,
  deriveHeirCodeKek,
  generateHeirCode,
  heirCodeForDisplay,
  heirVideoKey,
  lockHeirKey,
  looksLikeHeirCode,
  normalizeHeirCode,
  openHeirXprv,
  openOwnerHeirCode,
} from "./heirCode";

const XPRV = "tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK";

describe("heir code", () => {
  it("is five list words, hyphen-joined, different each time", () => {
    const a = generateHeirCode();
    expect(a.split("-")).toHaveLength(5);
    expect(looksLikeHeirCode(a)).toBe(true);
    expect(generateHeirCode()).not.toBe(a);
  });

  it("forgives how a person types it", () => {
    expect(normalizeHeirCode("  River garden,MANGO\nseven -- lamp ")).toBe("river-garden-mango-seven-lamp");
    expect(heirCodeForDisplay("river-garden-mango-seven-lamp")).toBe("river garden mango seven lamp");
    expect(looksLikeHeirCode("river garden mango seven")).toBe(false);
    expect(looksLikeHeirCode("river garden mango seven zzzz")).toBe(false);
  });

  it("locks the heir key so only the code opens it; the owner copy holds the code", async () => {
    const ownerKek = new Uint8Array(32).fill(3);
    const lock = await lockHeirKey(XPRV, ownerKek);
    const kdf = {
      salt_b64: lock.heir_code.salt_b64,
      kdf_mem_kib: lock.heir_code.kdf_mem_kib,
      kdf_iters: lock.heir_code.kdf_iters,
    };
    const blob = { v: 1 as const, ct: lock.heir_xprv_ct_b64, nonce: lock.heir_xprv_nonce_b64 };

    // Typed with spaces and capitals, as a person would.
    const typed = heirCodeForDisplay(lock.code).toUpperCase();
    const kek = await deriveHeirCodeKek(typed, kdf);
    expect(openHeirXprv(kek, blob)).toBe(XPRV);
    // The video key comes from the same code.
    expect(Array.from(heirVideoKey(kek))).toEqual(Array.from(lock.videoKey));

    const wrong = await deriveHeirCodeKek(generateHeirCode(), kdf);
    expect(() => openHeirXprv(wrong, blob)).toThrow();

    // The check value says "right code" without the heir key, and only
    // for the right code (the practice run uses this).
    const check = { ct_b64: lock.heir_code.check_ct_b64, nonce_b64: lock.heir_code.check_nonce_b64 };
    expect(() => checkHeirCode(kek, check)).not.toThrow();
    expect(() => checkHeirCode(wrong, check)).toThrow();
    expect(() => openHeirXprv(kek, { v: 1, ct: check.ct_b64, nonce: check.nonce_b64 })).toThrow();

    const ownerBlob = { v: 1 as const, ct: lock.heir_code.owner_ct_b64, nonce: lock.heir_code.owner_nonce_b64 };
    expect(openOwnerHeirCode(ownerKek, ownerBlob)).toBe(lock.code);
  }, 60_000);
});
