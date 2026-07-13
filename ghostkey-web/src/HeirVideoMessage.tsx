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
import {
  captureVideoPoster,
  videoDownloadName,
  videoIsPlayable,
} from "./videoPoster";

type State =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error" }
  | {
      kind: "ready";
      url: string;
      verified: boolean;
      /** False when this browser can't decode the clip's container
       *  (WebM on an iPhone): render a download offer, not a player
       *  that never plays. */
      playable: boolean;
      /** First-frame data URL so the player isn't a blank box before
       *  play is pressed. Arrives async; null renders as before. */
      poster: string | null;
      /** Filename for the download offer, from the clip's MIME. */
      filename: string;
    };

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
        const mime = view.mime || "video/webm";
        const blob = new Blob([new Uint8Array(clip.bytes)], { type: mime });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const playable = videoIsPlayable(mime);
        setState({
          kind: "ready",
          url,
          verified: clip.verified,
          playable,
          poster: null,
          filename: videoDownloadName(mime),
        });
        if (playable) {
          // Poster arrives after first render; the player shows it as
          // long as playback hasn't started, which is exactly the gap
          // it exists to fill.
          void captureVideoPoster(url).then((poster) => {
            if (cancelled || !poster) return;
            setState((s) => (s.kind === "ready" ? { ...s, poster } : s));
          });
        }
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
    // A load/decrypt failure — NOT a tamper signal. A clip that decrypts
    // but fails signature verification is the real "may be altered" case,
    // and it's handled below in the `ready` branch via `verified: false`.
    // So keep this neutral: leading with scam language on a transient
    // network hiccup scares a legitimate heir off a real claim.
    return (
      <div className="mb-6 rounded-2xl border border-app p-5">
        <p className="text-app-subtle text-sm">
          There was a video message left for you, but it couldn't be loaded
          right now. You can still continue with your claim below.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-app p-5">
      <h2 className="text-lg font-semibold">A message left for you</h2>
      {state.playable ? (
        <div className="mt-3 overflow-hidden rounded-xl bg-black/80">
          {/* The owner's own recorded clip — no caption file exists. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={state.url}
            poster={state.poster ?? undefined}
            className="aspect-video w-full object-cover"
            controls
            playsInline
          />
        </div>
      ) : (
        <>
          <p className="text-app-subtle mt-2 text-sm">
            This phone can't play the video here. Save it and open it in a
            video app, or open this same link on a computer.
          </p>
          <p className="mt-3">
            <a
              href={state.url}
              download={state.filename}
              className="font-display text-sm font-bold tracking-tight text-accent underline underline-offset-2"
            >
              Save the video
            </a>
          </p>
        </>
      )}
      {state.verified ? (
        <p className="text-ok mt-3 flex items-center gap-2 text-sm font-medium">
          <span aria-hidden>✓</span>
          Verified. Recorded by the owner of this vault, and it hasn't been
          changed since.
        </p>
      ) : (
        <div className="mt-3">
          <InlineAlert tone="warning">
            We could not confirm this message really came from the person who
            set up this vault. It may have been changed. Treat it with
            caution.
          </InlineAlert>
        </div>
      )}
    </div>
  );
}
