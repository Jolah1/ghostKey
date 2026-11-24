import { describe, expect, it } from "vitest";
import { generateParty } from "./keygen";
import {
  b64decode,
  b64encode,
  deriveOwnerKek,
  sealVaultSecretsHeirLater,
  sealWithKey,
  unsealHeirXprv,
  unsealOwner,
} from "./sealing";
import {
  HeirKeyMismatchError,
  WrongPasswordError,
  heirKeyMatches,
  resealHeirForClaim,
  xpubFromFragment,
} from "./heirLater";

// Small Argon2 parameters: the maths is the same, the test stays fast.
const MEM = 1024;
const ITERS = 1;
const PASSWORD = "test-only-correct-horse-battery-staple";

async function ownerSealed(heirXprv: string) {
  const salt = new Uint8Array(16).fill(3);
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: MEM, iters: ITERS });
  const blob = sealWithKey(kek, new TextEncoder().encode(heirXprv));
  kek.fill(0);
  return { passwordSalt: b64encode(salt), memKiB: MEM, iters: ITERS, blob };
}

const fragment = (p: { fingerprint: string; xpub: string }) =>
  `[${p.fingerprint}/86'/1'/0']${p.xpub}/0/*`;

describe("choosing an heir later", () => {
  const heir = generateParty("signet");
  const stranger = generateParty("signet");

  it("reads the xpub out of a descriptor fragment", () => {
    expect(xpubFromFragment(fragment(heir))).toBe(heir.xpub);
    expect(xpubFromFragment("not a key")).toBeNull();
  });

  it("matches only the heir's own key", () => {
    expect(heirKeyMatches(heir.xprv, fragment(heir), "signet")).toBe(true);
    expect(heirKeyMatches(heir.xprv, fragment(stranger), "signet")).toBe(false);
  });

  it("re-seals the heir key so the claim link opens it", async () => {
    const sealed = { ...(await ownerSealed(heir.xprv)), heirFragment: fragment(heir), network: "signet" as const };
    const out = await resealHeirForClaim(PASSWORD, sealed);
    const opened = unsealHeirXprv(b64decode(out.claim_token_b64), {
      v: 1,
      ct: out.heir_xprv_ct_b64,
      nonce: out.heir_xprv_nonce_b64,
    });
    expect(opened).toBe(heir.xprv);
    expect(b64decode(out.claim_token_b64)).toHaveLength(32);
  });

  it("refuses a wrong password", async () => {
    const sealed = { ...(await ownerSealed(heir.xprv)), heirFragment: fragment(heir), network: "signet" as const };
    await expect(resealHeirForClaim("not the password", sealed)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("never re-seals a key that isn't this vault's heir key", async () => {
    const sealed = { ...(await ownerSealed(stranger.xprv)), heirFragment: fragment(heir), network: "signet" as const };
    await expect(resealHeirForClaim(PASSWORD, sealed)).rejects.toBeInstanceOf(HeirKeyMismatchError);
  });

  it("setup seals owner and heir under one password, and the heir key re-seals later", async () => {
    const owner = generateParty("signet");
    const sealed = await sealVaultSecretsHeirLater({
      password: PASSWORD,
      ownerXprv: owner.xprv,
      heirXprv: heir.xprv,
      ownerToken: "token",
    });
    sealed._owner_kek.fill(0);
    const back = await unsealOwner({
      password: PASSWORD,
      passwordSalt: sealed.password_salt,
      memKiB: sealed.password_kdf_mem_kib,
      iters: sealed.password_kdf_iters,
      ownerXprvBlob: sealed.owner_xprv,
      ownerTokenBlob: sealed.owner_token,
    });
    expect(back.ownerXprv).toBe(owner.xprv);
    const out = await resealHeirForClaim(PASSWORD, {
      passwordSalt: sealed.password_salt,
      memKiB: sealed.password_kdf_mem_kib,
      iters: sealed.password_kdf_iters,
      blob: sealed.heir_xprv_owner,
      heirFragment: fragment(heir),
      network: "signet",
    });
    expect(
      unsealHeirXprv(b64decode(out.claim_token_b64), {
        v: 1,
        ct: out.heir_xprv_ct_b64,
        nonce: out.heir_xprv_nonce_b64,
      }),
    ).toBe(heir.xprv);
  }, 30_000);
});
