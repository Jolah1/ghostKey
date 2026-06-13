/**
 * Owner video message crypto (#85).
 *
 * The recorded clip is sealed under the claim-token KEK — the same gate
 * as the heir xprv — so the claim LINK is the only thing that can unlock
 * it (a scam link carries the wrong token and can never decrypt it). The
 * owner also signs sha256(clip) with the vault owner key. At claim the
 * heir's browser verifies that signature against the owner xpub embedded
 * in the public descriptor: a substituted clip (even an AI deepfake)
 * fails verification and is shown to the heir as NOT authentic.
 */
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";

import { b64encode, deriveClaimKek, sealWithKey } from "./sealing";

export interface PreparedVideo {
  video_ct_b64: string;
  video_nonce_b64: string;
  owner_sig_b64: string;
  signed_sha256_hex: string;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

/**
 * Encrypt + sign a recorded clip for upload. `ownerXprv` is the owner
 * account xprv minted during setup; `claimTokenRaw` is that heir's claim
 * token. Returns the wire payload for `api.uploadVideo`.
 */
export function prepareVideo(
  ownerXprv: string,
  claimTokenRaw: Uint8Array,
  videoBytes: Uint8Array,
): PreparedVideo {
  const digest = sha256(videoBytes);
  const node = HDKey.fromExtendedKey(ownerXprv);
  if (!node.privateKey) {
    throw new Error("owner key is not a private key; cannot sign video");
  }
  // Deterministic ECDSA (RFC6979) over the clip digest, 64-byte compact.
  const sig = node.sign(digest);
  const kek = deriveClaimKek(claimTokenRaw);
  const sealed = sealWithKey(kek, videoBytes);
  return {
    video_ct_b64: sealed.ct,
    video_nonce_b64: sealed.nonce,
    owner_sig_b64: b64encode(sig),
    signed_sha256_hex: bytesToHex(digest),
  };
}
