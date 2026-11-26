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

import {
  b64decode,
  b64encode,
  deriveClaimKek,
  openWithKey,
  sealWithKey,
} from "./sealing";

/** What locks a video: the claim token (older vaults), or the key
 *  derived from the heir code (`heirVideoKey`, heir-code vaults). */
export type VideoLock = { claimTokenRaw: Uint8Array } | { videoKey: Uint8Array };

function videoKek(lock: VideoLock): Uint8Array {
  return "videoKey" in lock ? new Uint8Array(lock.videoKey) : deriveClaimKek(lock.claimTokenRaw);
}

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

export interface VerifiedClip {
  /** Decrypted clip bytes (caller builds an object URL to play). */
  bytes: Uint8Array;
  /** True iff the owner signature checks out against `ownerXpub` AND
   *  the decrypted bytes hash to the signed digest. When false the clip
   *  still decrypted, but its authenticity could not be confirmed —
   *  the heir UI must treat it as suspect. */
  verified: boolean;
}

/**
 * Decrypt the owner's clip with the claim token and verify it is the
 * genuine, untampered recording.
 *
 * Decryption uses XChaCha20-Poly1305 (AEAD): if the ciphertext was
 * altered, or the token is wrong, this throws — a tampered or
 * wrong-link clip never plays at all. If it decrypts, we additionally
 * confirm the bytes hash to the signed digest and that the owner key
 * signed it, so a clip swapped wholesale (even an AI deepfake) is
 * flagged unverified.
 */
export function decryptAndVerifyVideo(input: {
  lock: VideoLock;
  ownerXpub: string;
  videoCtB64: string;
  videoNonceB64: string;
  ownerSigB64: string;
  signedSha256Hex: string;
}): VerifiedClip {
  const kek = videoKek(input.lock);
  let bytes: Uint8Array;
  try {
    bytes = openWithKey(kek, {
      v: 1,
      ct: input.videoCtB64,
      nonce: input.videoNonceB64,
    });
  } finally {
    kek.fill(0);
  }

  let verified = false;
  try {
    const digest = sha256(bytes);
    const hashMatches = bytesToHex(digest) === input.signedSha256Hex.toLowerCase();
    const node = HDKey.fromExtendedKey(input.ownerXpub);
    const sigOk = node.verify(digest, b64decode(input.ownerSigB64));
    verified = hashMatches && sigOk;
  } catch {
    verified = false;
  }
  return { bytes, verified };
}

/**
 * Encrypt + sign a recorded clip for upload. `ownerXprv` is the owner
 * account xprv minted during setup; `claimTokenRaw` is that heir's claim
 * token. Returns the wire payload for `api.uploadVideo`.
 */
export function prepareVideo(
  ownerXprv: string,
  lock: VideoLock,
  videoBytes: Uint8Array,
): PreparedVideo {
  const digest = sha256(videoBytes);
  const node = HDKey.fromExtendedKey(ownerXprv);
  if (!node.privateKey) {
    throw new Error("owner key is not a private key; cannot sign video");
  }
  // Deterministic ECDSA (RFC6979) over the clip digest, 64-byte compact.
  const sig = node.sign(digest);
  const kek = videoKek(lock);
  const sealed = sealWithKey(kek, videoBytes);
  kek.fill(0);
  return {
    video_ct_b64: sealed.ct,
    video_nonce_b64: sealed.nonce,
    owner_sig_b64: b64encode(sig),
    signed_sha256_hex: bytesToHex(digest),
  };
}
