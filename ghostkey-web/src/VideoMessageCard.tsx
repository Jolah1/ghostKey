/**
 * Owner-side "Video message" card (#222).
 *
 * Shows whether a video message is attached to this vault and lets the
 * owner record, replace, or remove one for an EXISTING vault. Setup's
 * upload is best-effort by design (a failure must not abort a good
 * vault), and vaults created before the feature existed have no clip at
 * all — without this card the owner only finds out at claim time, when
 * it's too late to fix.
 *
 * Recording needs two secrets the browser doesn't hold at dashboard
 * time:
 *   - the owner xprv (signs the clip so the heir can verify it) —
 *     unsealed locally from the sealed-blobs view with the owner's
 *     password, the same way Add Heir authorises itself;
 *   - the heir's claim token (seals the clip so only the heir's link
 *     can play it) — released to the authenticated owner by
 *     GET /vaults/:id/claim-token.
 *
 * Door B vaults store no claim token at rest (the scheduler mints a
 * fresh one at trigger), so a stored clip could never be decrypted;
 * the endpoint 404s and the card says video isn't available.
 */
import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type VideoStatusView } from "./api";
import { b64decode, unsealOwner } from "./crypto/sealing";
import { prepareVideo } from "./crypto/video";
import {
  VideoMessageRecorder,
  type RecordedClip,
} from "./VideoMessageRecorder";
import { Button, Field, InlineAlert } from "./ui";

/** One line describing the stored clip, for the card and its tests. */
export function videoStatusLine(status: VideoStatusView): string {
  if (!status.has_video) return "No video message yet.";
  if (!status.created_at) return "A video message is saved.";
  const d = new Date(status.created_at);
  if (Number.isNaN(d.getTime())) return "A video message is saved.";
  const when = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Video message saved ${when}.`;
}

type StatusState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; view: VideoStatusView };

type Busy = null | "unlocking" | "saving" | "removing";

export function VideoMessageCard({
  vaultId,
  ownerToken,
  heirName,
}: {
  vaultId: string;
  ownerToken: string | null;
  heirName?: string;
}) {
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const refresh = useCallback(async () => {
    if (!ownerToken) return;
    try {
      const view = await api.getVideoStatus(vaultId, ownerToken);
      setStatus({ kind: "ready", view });
    } catch {
      setStatus({ kind: "error" });
    }
  }, [vaultId, ownerToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Availability probe when the record panel opens: Door B / legacy
  // vaults have no claim token to seal under, and the owner should
  // learn that BEFORE recording a clip, not after.
  async function onOpen() {
    setError(null);
    setSavedFlash(false);
    if (!ownerToken) return;
    try {
      await api.getVaultClaimToken(vaultId, ownerToken);
      setOpen(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setUnavailable(true);
      } else {
        setError("Couldn't reach the server. Try again in a moment.");
      }
    }
  }

  function onClose() {
    setOpen(false);
    setClip(null);
    setPassword("");
    setError(null);
  }

  async function onSave() {
    if (!clip || !ownerToken) return;
    setError(null);

    // (1) Unseal the owner xprv locally with the password. Wrong
    // password = AEAD failure, nothing leaves the browser.
    setBusy("unlocking");
    let ownerXprv: string;
    try {
      const blobs = await api.getSealedBlobs(vaultId, ownerToken);
      const unsealed = await unsealOwner({
        password,
        passwordSalt: blobs.password_salt_b64,
        memKiB: blobs.password_kdf_mem_kib,
        iters: blobs.password_kdf_iters,
        ownerXprvBlob: {
          v: 1,
          ct: blobs.owner_xprv_ct_b64,
          nonce: blobs.owner_xprv_nonce_b64,
        },
        ownerTokenBlob: {
          v: 1,
          ct: blobs.owner_token_ct_b64,
          nonce: blobs.owner_token_nonce_b64,
        },
      });
      ownerXprv = unsealed.ownerXprv;
    } catch (e) {
      setBusy(null);
      setError(
        e instanceof ApiError
          ? e.message
          : "That password didn't unlock the vault. Check it and try again.",
      );
      return;
    }

    // (2) Seal under the heir's claim token and upload — the exact
    // sealing setup performs, so the heir's link plays it unchanged.
    setBusy("saving");
    try {
      const tok = await api.getVaultClaimToken(vaultId, ownerToken);
      const bytes = new Uint8Array(await clip.blob.arrayBuffer());
      const prepared = prepareVideo(
        ownerXprv,
        b64decode(tok.claim_token_b64),
        bytes,
      );
      await api.uploadVideo(vaultId, ownerToken, {
        ...prepared,
        mime: clip.mime,
        duration_ms: Math.round(clip.durationMs),
      });
    } catch (e) {
      setBusy(null);
      if (e instanceof ApiError && e.status === 404) {
        setUnavailable(true);
        setOpen(false);
      } else {
        setError(
          e instanceof ApiError
            ? e.message
            : "Saving failed. Your vault is fine. Try again in a moment.",
        );
      }
      return;
    }

    setBusy(null);
    onClose();
    setSavedFlash(true);
    void refresh();
  }

  async function onRemove() {
    if (!ownerToken) return;
    setBusy("removing");
    setError(null);
    try {
      await api.deleteVideo(vaultId, ownerToken);
    } catch {
      setError("Removing failed. Try again in a moment.");
    }
    setBusy(null);
    setConfirmingRemove(false);
    void refresh();
  }

  if (!ownerToken) return null;

  const who = heirName?.trim() ? heirName.trim() : "your heir";
  const hasVideo = status.kind === "ready" && status.view.has_video;

  return (
    <section className="card-flat p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Video message</h3>
          <p className="mt-1 text-sm text-muted">
            {status.kind === "loading"
              ? "Checking…"
              : status.kind === "error"
                ? "Couldn't check for a video right now."
                : videoStatusLine(status.view)}
          </p>
          {hasVideo ? (
            <p className="mt-1 text-xs text-muted">
              {who} sees it when they claim, with proof it really is you.
            </p>
          ) : status.kind === "ready" && !unavailable ? (
            <p className="mt-1 text-xs text-muted">
              A short clip {who} sees at claim time, with proof it really
              is you.
            </p>
          ) : null}
        </div>
        {!open && !unavailable && status.kind === "ready" ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => void onOpen()}>
              {hasVideo ? "Replace" : "Record"}
            </Button>
            {hasVideo && !confirmingRemove ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {confirmingRemove ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-sm">Remove the saved video for {who}?</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRemove()}
            disabled={busy === "removing"}
          >
            {busy === "removing" ? "Removing…" : "Yes, remove it"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingRemove(false)}
            disabled={busy === "removing"}
          >
            Keep it
          </Button>
        </div>
      ) : null}

      {unavailable ? (
        <div className="mt-3">
          <InlineAlert tone="neutral">
            Video messages aren't available for this vault: {who} holds
            their own key, so there's no claim link to lock the video to.
          </InlineAlert>
        </div>
      ) : null}

      {savedFlash ? (
        <div className="mt-3">
          <InlineAlert tone="ok">
            Saved. {who} will see your video when they claim.
          </InlineAlert>
        </div>
      ) : null}

      {open ? (
        <div className="mt-4">
          <VideoMessageRecorder
            heirName={heirName}
            onChange={setClip}
            disabled={busy !== null}
          />

          <div className="mt-4">
            <Field
              label="Your password"
              hint="Signs the video so your heir can verify it's really you."
            >
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="The password you set up the vault with"
                disabled={busy !== null}
              />
            </Field>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => void onSave()}
              disabled={!clip || !password || busy !== null}
            >
              {busy === "unlocking"
                ? "Unlocking…"
                : busy === "saving"
                  ? "Saving…"
                  : "Save video"}
            </Button>
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <InlineAlert tone="alarm">{error}</InlineAlert>
        </div>
      ) : null}
    </section>
  );
}
