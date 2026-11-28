import { describe, expect, it } from "vitest";
import { deriveOwnerKek, openWithKey, sealHeirLaterWithKek, sealWithKey, unsealOwnerKeepKek, b64decode } from "./sealing";

const PASSWORD = "Okra-lantern-harbour-quietly-92";
const SALT = "CQkJCQkJCQkJCQkJCQkJCQ=="; // 16 bytes of 9
const KDF = { memKiB: 1024, iters: 1 };

describe("locking a goal with one Argon2 run", () => {
  it("opens the owner key, keeps the password key, and seals the new goal under it", async () => {
    const kek = await deriveOwnerKek(PASSWORD, b64decode(SALT), KDF);
    const enc = new TextEncoder();
    const ownerXprvBlob = sealWithKey(kek, enc.encode("tprv-owner"));
    const ownerTokenBlob = sealWithKey(kek, enc.encode("token"));

    const opened = await unsealOwnerKeepKek({ password: PASSWORD, passwordSalt: SALT, ...KDF, ownerXprvBlob, ownerTokenBlob });
    expect(opened.ownerXprv).toBe("tprv-owner");
    expect(opened.kek).toEqual(kek);

    const sealed = sealHeirLaterWithKek({
      kek: opened.kek,
      passwordSalt: SALT,
      ...KDF,
      ownerXprv: opened.ownerXprv,
      heirXprv: "tprv-spare-heir",
      ownerToken: "placeholder",
    });
    // Same salt and settings, so the same password re-derives this key.
    expect([sealed.password_salt, sealed.password_kdf_mem_kib, sealed.password_kdf_iters]).toEqual([SALT, 1024, 1]);
    const dec = new TextDecoder();
    const again = await deriveOwnerKek(PASSWORD, b64decode(sealed.password_salt), KDF);
    expect(dec.decode(openWithKey(again, sealed.owner_xprv))).toBe("tprv-owner");
    expect(dec.decode(openWithKey(again, sealed.heir_xprv_owner))).toBe("tprv-spare-heir");
    // Fresh nonces: nothing is reused from the main savings' blobs.
    expect(sealed.owner_xprv.nonce).not.toBe(ownerXprvBlob.nonce);
  });

  it("refuses a wrong password", async () => {
    const kek = await deriveOwnerKek(PASSWORD, b64decode(SALT), KDF);
    const blob = sealWithKey(kek, new TextEncoder().encode("x"));
    await expect(
      unsealOwnerKeepKek({ password: "wrong", passwordSalt: SALT, ...KDF, ownerXprvBlob: blob, ownerTokenBlob: blob }),
    ).rejects.toThrow();
  });
});
