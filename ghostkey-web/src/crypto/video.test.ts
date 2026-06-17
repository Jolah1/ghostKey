/**
 * Owner video message crypto (#85).
 *
 * This is the anti-deepfake heart of the feature: a substituted clip
 * must fail to decrypt or fail verification, and only the genuine clip
 * sealed under the right claim token, signed by the owner key, must come
 * back verified. These tests lock that contract down.
 */
import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";

import { decryptAndVerifyVideo, prepareVideo } from "./video";

/** A deterministic owner key + the matching public xpub. */
function ownerKeys() {
  const root = HDKey.fromMasterSeed(new Uint8Array(64).fill(1));
  return { xprv: root.privateExtendedKey, xpub: root.publicExtendedKey };
}

const claimToken = new Uint8Array(32).fill(7);
const clip = new TextEncoder().encode("a short proof-of-life clip");

describe("owner video crypto", () => {
  it("round-trips: the genuine clip decrypts and verifies", () => {
    const { xprv, xpub } = ownerKeys();
    const prepared = prepareVideo(xprv, claimToken, clip);

    const result = decryptAndVerifyVideo({
      claimTokenRaw: claimToken,
      ownerXpub: xpub,
      videoCtB64: prepared.video_ct_b64,
      videoNonceB64: prepared.video_nonce_b64,
      ownerSigB64: prepared.owner_sig_b64,
      signedSha256Hex: prepared.signed_sha256_hex,
    });

    expect(result.verified).toBe(true);
    expect(Array.from(result.bytes)).toEqual(Array.from(clip));
  });

  it("rejects a clip signed by a different key (deepfake swap) as unverified", () => {
    const owner = ownerKeys();
    const prepared = prepareVideo(owner.xprv, claimToken, clip);

    // Attacker re-signs their own clip with their own key, then tries to
    // pass it off under the real owner's xpub.
    const attacker = HDKey.fromMasterSeed(new Uint8Array(64).fill(2));
    const fakeClip = new TextEncoder().encode("an AI-generated impostor clip");
    const forged = prepareVideo(attacker.privateExtendedKey, claimToken, fakeClip);

    const result = decryptAndVerifyVideo({
      claimTokenRaw: claimToken,
      ownerXpub: owner.xpub, // the REAL owner's xpub
      videoCtB64: forged.video_ct_b64,
      videoNonceB64: forged.video_nonce_b64,
      ownerSigB64: forged.owner_sig_b64,
      signedSha256Hex: forged.signed_sha256_hex,
    });

    // It still decrypts (right token), but verification fails.
    expect(result.verified).toBe(false);
    expect(prepared.owner_sig_b64).not.toEqual(forged.owner_sig_b64);
  });

  it("flags a real clip with a tampered signed digest as unverified", () => {
    const { xprv, xpub } = ownerKeys();
    const prepared = prepareVideo(xprv, claimToken, clip);

    const result = decryptAndVerifyVideo({
      claimTokenRaw: claimToken,
      ownerXpub: xpub,
      videoCtB64: prepared.video_ct_b64,
      videoNonceB64: prepared.video_nonce_b64,
      ownerSigB64: prepared.owner_sig_b64,
      // Digest the heir is told to expect no longer matches the clip.
      signedSha256Hex: "00".repeat(32),
    });

    expect(result.verified).toBe(false);
  });

  it("won't decrypt at all with the wrong claim token (scam link)", () => {
    const { xprv, xpub } = ownerKeys();
    const prepared = prepareVideo(xprv, claimToken, clip);

    const wrongToken = new Uint8Array(32).fill(9);
    expect(() =>
      decryptAndVerifyVideo({
        claimTokenRaw: wrongToken,
        ownerXpub: xpub,
        videoCtB64: prepared.video_ct_b64,
        videoNonceB64: prepared.video_nonce_b64,
        ownerSigB64: prepared.owner_sig_b64,
        signedSha256Hex: prepared.signed_sha256_hex,
      }),
    ).toThrow();
  });

  it("won't decrypt a clip whose ciphertext was altered (AEAD)", () => {
    const { xprv, xpub } = ownerKeys();
    const prepared = prepareVideo(xprv, claimToken, clip);

    // Flip a byte in the base64 ciphertext.
    const tampered =
      prepared.video_ct_b64[0] === "A"
        ? "B" + prepared.video_ct_b64.slice(1)
        : "A" + prepared.video_ct_b64.slice(1);

    expect(() =>
      decryptAndVerifyVideo({
        claimTokenRaw: claimToken,
        ownerXpub: xpub,
        videoCtB64: tampered,
        videoNonceB64: prepared.video_nonce_b64,
        ownerSigB64: prepared.owner_sig_b64,
        signedSha256Hex: prepared.signed_sha256_hex,
      }),
    ).toThrow();
  });
});
