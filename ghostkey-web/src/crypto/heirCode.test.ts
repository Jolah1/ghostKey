import { describe, expect, it } from "vitest";
import { b64encode, deriveClaimKek, deriveOwnerKek, sealWithKey } from "./sealing";
import {
  WrongOwnerPasswordError,
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
  relockWithHeirCode,
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

  it("moves an older vault to a code: key and video re-locked, password checked", async () => {
    const password = "test-only-owner-password";
    const salt = new Uint8Array(16).fill(5);
    const ownerKek = await deriveOwnerKek(password, salt, { memKiB: 1024, iters: 1 });
    const ownerBlob = sealWithKey(ownerKek, new TextEncoder().encode("owner-xprv"));
    const token = new Uint8Array(32).fill(9);
    const linkKek = deriveClaimKek(token);
    const heirBlob = sealWithKey(linkKek, new TextEncoder().encode(XPRV));
    const clip = new TextEncoder().encode("a short message");
    const videoBlob = sealWithKey(linkKek, clip);
    const owner = {
      password_salt_b64: b64encode(salt),
      password_kdf_mem_kib: 1024,
      password_kdf_iters: 1,
      owner_xprv_ct_b64: ownerBlob.ct,
      owner_xprv_nonce_b64: ownerBlob.nonce,
    };
    const kit = {
      claim_token_b64: b64encode(token),
      heir_xprv_ct_b64: heirBlob.ct,
      heir_xprv_nonce_b64: heirBlob.nonce,
      video: { video_ct_b64: videoBlob.ct, video_nonce_b64: videoBlob.nonce },
    };

    await expect(relockWithHeirCode({ password: "wrong", owner, kit })).rejects.toBeInstanceOf(
      WrongOwnerPasswordError,
    );

    const { body, code } = await relockWithHeirCode({ password, owner, kit });
    const kek = await deriveHeirCodeKek(code, body.heir_code);
    expect(openHeirXprv(kek, { v: 1, ct: body.heir_xprv_ct_b64, nonce: body.heir_xprv_nonce_b64 })).toBe(XPRV);
    expect(() => checkHeirCode(kek, { ct_b64: body.heir_code.check_ct_b64, nonce_b64: body.heir_code.check_nonce_b64 })).not.toThrow();
    // The video opens with the new code's video key (decoded as text here).
    const videoBlobNew = { v: 1 as const, ct: body.video!.video_ct_b64, nonce: body.video!.video_nonce_b64 };
    expect(openHeirXprv(heirVideoKey(kek), videoBlobNew)).toBe("a short message");
    // The owner's copy of the new code opens with the same password key.
    expect(openOwnerHeirCode(ownerKek, { v: 1, ct: body.heir_code.owner_ct_b64, nonce: body.heir_code.owner_nonce_b64 })).toBe(code);
  }, 60_000);
});
