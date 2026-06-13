/**
 * Heir-side playback of the owner's video message (#85).
 *
 * Fetched from `GET /claim/:token/video`, decrypted with the claim token
 * (read from the link), and verified against the owner key from the
 * vault descriptor before it plays. The whole point: a real link shows a
 * real, signature-verified face; a scam link can't decrypt anything, and
 * a swapped/deepfake clip is flagged as not verified.
 *
 * Renders nothing when the vault has no video (404) — it's optional.
 */
import { useEffect, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { b64decode } from "./crypto/sealing";
import { decryptAndVerifyVideo } from "./crypto/video";
import { InlineAlert } from "./ui";

type State =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "ready"; url: string; verified: boolean };

export function HeirVideoMessage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await api.getClaimVideo(token);
        const clip = decryptAndVerifyVideo({
          claimTokenRaw: b64decode(token),
          ownerXpub: view.owner_xpub,
          videoCtB64: view.video_ct_b64,
          videoNonceB64: view.video_nonce_b64,
          ownerSigB64: view.owner_sig_b64,
          signedSha256Hex: view.signed_sha256_hex,
        });
        if (cancelled) return;
        // Copy into a fresh ArrayBuffer-backed array so the Blob ctor's
        // BlobPart typing is satisfied regardless of the source buffer.
        const blob = new Blob([new Uint8Array(clip.bytes)], {
          type: view.mime || "video/webm",
        });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ kind: "ready", url, verified: clip.verified });
      } catch (e) {
        if (cancelled) return;
        // 404 = this vault simply has no video. Anything else (including
        // a decryption failure from a tampered clip) we surface quietly.
        if (e instanceof ApiError && e.status === 404) {
          setState({ kind: "none" });
        } else {
          setState({ kind: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [token]);

  if (state.kind === "none") return null;

  if (state.kind === "loading") {
    return (
      <div className="mb-6 rounded-2xl border border-app p-5">
        <p className="text-app-subtle text-sm">Loading a message left for you…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mb-6">
        <InlineAlert tone="warning">
          A video message was left for you, but it couldn't be opened or its
          authenticity couldn't be confirmed. Don't rely on it — continue only
          if you trust how you received this link.
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-app p-5">
      <h2 className="text-lg font-semibold">A message left for you</h2>
      <div className="mt-3 overflow-hidden rounded-xl bg-black/80">
        {/* The owner's own recorded clip — no caption file exists. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={state.url} className="aspect-video w-full object-cover" controls playsInline />
      </div>
      {state.verified ? (
        <p className="text-ok mt-3 flex items-center gap-2 text-sm font-medium">
          <span aria-hidden>✓</span>
          Verified — recorded by the owner of this vault, and untampered.
        </p>
      ) : (
        <div className="mt-3">
          <InlineAlert tone="warning">
            This message played, but its signature did not match the vault
            owner's key — it may have been altered. Treat it with caution.
          </InlineAlert>
        </div>
      )}
    </div>
  );
}
