/**
 * Sign-in portal — email + password unlock from any device.
 *
 * Replaces the legacy `CheckinPortal` (which required the user to know
 * the vault UUID and only worked on the device where the vault was
 * created). The lookup-by-id path lives on as `CheckinPortal` at
 * #/checkin-legacy for users with vaults created before the password
 * flow shipped.
 *
 * Flow:
 *
 *   1. User types their email.
 *   2. Browser computes `hashEmailForLookup(email)` — SHA-256 over the
 *      lowercased, NFKC-normalised value. We POST the *hash*, never
 *      the plaintext email, so the server's index never sees raw
 *      addresses (`/recovery/request`). The response is uniform.
 *   3. If a password vault exists, the server emails a 15-minute,
 *      single-use link to the encrypted owner contact.
 *   4. Redeeming the link atomically returns matching summaries and
 *      password-wrapped blobs; replay and expiry both fail closed.
 *   5. `unsealOwner()` runs Argon2id on the user's password with the
 *      stored salt + params; if the resulting KEK opens both the
 *      owner_xprv blob and the owner_token blob, we have full
 *      credentials.
 *   6. We persist a VaultMeta in localStorage with the recovered
 *      owner_token so the dashboard works on this device, mark the
 *      vault as active, and navigate to /dashboard.
 *
 * Failure modes called out by name in the UI:
 *
 *   - Wrong password → `unsealOwner` throws on the auth-tag check.
 *     We catch and show "Wrong password" (not "decryption failed" —
 *     that's noise to a non-cryptographer).
 *   - Expired/already-used recovery link → request a fresh email.
 *   - The post-create owner-token re-seal call failed silently during
 *     setup, so the owner-token ciphertext on the server is still the
 *     placeholder. Unsealing the placeholder gives us the literal
 *     string `ghostkey-placeholder-owner-token-v1`; we detect this
 *     and tell the user to do one check-in from the original device.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Field,
  InlineAlert,
} from "./ui";
import {
  ApiError,
  api,
  type FoundVault,
  type OwnerRecoveryBundle,
  type SealedBlobsView,
} from "./api";
import { hashEmailForLookup, unsealOwner } from "./crypto/sealing";
import {
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  saveVaultMeta,
  setActiveVaultId,
} from "./vaultStore";
import type { Route } from "./App";

const PLACEHOLDER_OWNER_TOKEN = "ghostkey-placeholder-owner-token-v1";

/** The sealed blobs don't carry the heir's name, but the vault label
 *  does ("Ada's share" / "Ada's inheritance"). Pull the name back out
 *  so cross-device sign-in shows the real name, not a placeholder. */
function heirNameFromLabel(label: string | null): string {
  const m = label?.match(/^(.+?)'s (?:share|inheritance)$/i);
  return m ? m[1] : "Heir";
}

interface Props {
  onNavigate: (r: Route) => void;
  recoveryToken?: string;
  /** Unlock an existing trusted-device credential without sending email. */
  localUnlock?: boolean;
  onUnlock?: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "sent" }
  | { kind: "exchanging" }
  | { kind: "ready" }
  | { kind: "unsealing"; vaultId: string; progress: number }
  | { kind: "done" };

export function SignInPortal({
  onNavigate,
  recoveryToken,
  localUnlock = false,
  onUnlock,
}: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Mistyped passwords are the #1 sign-in failure, and the field hides
  // every character. A show toggle costs nothing and rescues most of
  // them (Bitcoin UX principle: password UX is money UX).
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [bundles, setBundles] = useState<OwnerRecoveryBundle[]>([]);
  const [recoveredEmail, setRecoveredEmail] = useState("");
  const [useEmailRecovery, setUseEmailRecovery] = useState(false);
  const exchangeStarted = useRef(false);
  const localVaultId = localUnlock ? getActiveVaultId() : null;
  const localOwnerToken = localVaultId
    ? getVaultOwnerToken(localVaultId)
    : null;
  const localMeta = localVaultId ? getVaultMeta(localVaultId) : null;
  const trustedUnlock = Boolean(
    localUnlock &&
      !useEmailRecovery &&
      localVaultId &&
      localOwnerToken &&
      localMeta,
  );

  useEffect(() => {
    if (!recoveryToken || exchangeStarted.current) return;
    exchangeStarted.current = true;
    setPhase({ kind: "exchanging" });
    void api
      .exchangeOwnerRecovery(recoveryToken)
      .then((result) => {
        setRecoveredEmail(result.owner_email);
        setBundles(result.vaults);
        setPhase({ kind: "ready" });
      })
      .catch((e) => {
        setError(
          e instanceof ApiError && e.status === 404
            ? "This sign-in link has expired or was already used. Request a new one."
            : e instanceof ApiError
              ? e.message
              : String(e),
        );
        setPhase({ kind: "idle" });
      });
  }, [recoveryToken]);

  function reset() {
    setError(null);
  }

  async function lookUp() {
    reset();
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    if (!/^.+@.+\..+$/.test(email.trim())) {
      setError("That email looks off. Double-check it.");
      return;
    }
    setPhase({ kind: "looking" });
    try {
      const hash = hashEmailForLookup(email);
      await api.requestOwnerRecovery(hash);
      setPhase({ kind: "sent" });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPhase({ kind: "idle" });
    }
  }

  async function recover() {
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (bundles.length === 1) {
      await openVault(bundles[0].vault, bundles[0].sealed_blobs);
    } else if (bundles.length > 1) {
      await openGroup(bundles);
    } else {
      setError("No password-enabled vaults were found for this recovery link.");
    }
  }

  async function unlockTrustedDevice() {
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (!localVaultId || !localOwnerToken) {
      setError("This browser no longer has its trusted-device credential.");
      return;
    }

    setError(null);
    setPhase({ kind: "unsealing", vaultId: localVaultId, progress: 0 });
    try {
      const blobs = await api.getSealedBlobs(localVaultId, localOwnerToken);
      const out = await unsealOwner({
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
        onProgress: (progress) =>
          setPhase({
            kind: "unsealing",
            vaultId: localVaultId,
            progress: Math.round(progress * 100),
          }),
      });
      if (out.ownerToken !== localOwnerToken) {
        throw new Error("The saved credential does not match this vault.");
      }
      setPhase({ kind: "done" });
      onUnlock?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const wrongPassword = /poly1305|tag|invalid|decryp/i.test(message);
      setError(
        wrongPassword
          ? "Wrong password. Try again."
          : e instanceof ApiError && e.status === 409
            ? "This older vault has no local password lock. Use email recovery or open it from its original wallet flow."
            : message,
      );
      setPhase({ kind: "idle" });
    }
  }

  async function openVault(v: FoundVault, blobs: SealedBlobsView) {
    setPhase({ kind: "unsealing", vaultId: v.id, progress: 0 });
    setError(null);

    try {
      const out = await unsealOwner({
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
        onProgress: (p) =>
          setPhase({
            kind: "unsealing",
            vaultId: v.id,
            progress: Math.round(p * 100),
          }),
      });

      if (out.ownerToken === PLACEHOLDER_OWNER_TOKEN) {
        // Setup completed but the post-create re-seal call failed.
        // The user can fix this by checking in once from the device
        // where they originally set up the vault — that browser still
        // has the real owner_token in localStorage and the next
        // check-in will keep that working.
        setError(
          "We can open your vault but the sign-in credentials aren't " +
            "ready yet for this device. Check in once from the device " +
            "you used to set up the vault, then try again here.",
        );
        setPhase({ kind: "idle" });
        return;
      }

      // Land everything we need in localStorage so the dashboard
      // works exactly like it does on the original device. We keep
      // the heir's local-only fields (name, etc.) empty here — the
      // sealed blobs don't carry them. The dashboard tolerates that
      // gracefully (it shows "—" for unknown values).
      saveVaultMeta({
        id: v.id,
        label: v.label ?? "Your vault",
        owner: { address: recoveredEmail || email.trim() },
        heir: { name: heirNameFromLabel(v.label), email: "", address: "" },
        createdAt: v.created_at,
        ownerToken: out.ownerToken,
      });
      setActiveVaultId(v.id);
      setPhase({ kind: "done" });
      onUnlock?.();
      onNavigate("dashboard");
    } catch (e) {
      // @noble/ciphers throws a generic Error on a bad auth tag.
      // We don't differentiate further — wrong password is by far
      // the most common cause.
      const msg = e instanceof Error ? e.message : String(e);
      const isAuthTagFail = /poly1305|tag|invalid|decryp/i.test(msg);
      setError(
        isAuthTagFail
          ? "Wrong password. Try again."
          : msg,
      );
      setPhase({ kind: "idle" });
    }
  }

  /**
   * Recover every vault in an owner's heir group and persist them under
   * one shared group id so this device renders them as a single vault
   * (matching the setup device). All siblings share the owner password,
   * so we unseal each in turn; a failure on the first is almost
   * certainly a wrong password and aborts before anything is written.
   *
   * Cost: one Argon2id unwrap per heir. We show aggregate progress
   * across the group so a multi-heir owner sees steady movement rather
   * than a bar that restarts N times.
   */
  async function openGroup(recoveryBundles: OwnerRecoveryBundle[]) {
    setError(null);
    const groupId = crypto.randomUUID();
    let firstId: string | null = null;

    for (let i = 0; i < recoveryBundles.length; i++) {
      const { vault: v, sealed_blobs: blobs } = recoveryBundles[i];
      setPhase({ kind: "unsealing", vaultId: v.id, progress: 0 });

      try {
        const out = await unsealOwner({
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
          onProgress: (p) =>
            setPhase({
              kind: "unsealing",
              vaultId: v.id,
              progress: Math.round(((i + p) / recoveryBundles.length) * 100),
            }),
        });

        // A placeholder owner_token means setup's re-seal never landed
        // for this sibling. We still add it to the group so it's visible,
        // but without a token its mutations will need a check-in from the
        // original device first. `undefined` (not the placeholder string)
        // keeps the dashboard's "no credential" handling intact.
        const ownerToken =
          out.ownerToken === PLACEHOLDER_OWNER_TOKEN
            ? undefined
            : out.ownerToken;

        saveVaultMeta({
          id: v.id,
          label: v.label ?? "Your vault",
          owner: { address: recoveredEmail || email.trim() },
          heir: { name: heirNameFromLabel(v.label), email: "", address: "" },
          createdAt: v.created_at,
          ownerToken,
          groupId,
        });
        if (!firstId) firstId = v.id;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isAuthTagFail = /poly1305|tag|invalid|decryp/i.test(msg);
        setError(isAuthTagFail ? "Wrong password. Try again." : msg);
        setPhase({ kind: "idle" });
        return;
      }
    }

    if (!firstId) {
      setError(
        "These vaults were set up before cross-device sign-in shipped. " +
          "Check in from the device you used originally.",
      );
      setPhase({ kind: "idle" });
      return;
    }
    setActiveVaultId(firstId);
    setPhase({ kind: "done" });
    onUnlock?.();
    onNavigate("dashboard");
  }

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-md px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">Sign in</p>
          <h1 className="mt-6 font-serif text-3xl md:text-4xl">
            {trustedUnlock ? "Session timed out" : "Open your vault on this device"}
          </h1>
          <p className="mx-auto mt-3 text-sm text-muted">
            {trustedUnlock
              ? `Enter your password to continue${localMeta?.label ? ` to ${localMeta.label}` : ""}. No email is needed.`
              : recoveryToken
              ? "Enter the password you chose at setup. Your encrypted vault opens here on this device."
              : "Enter your email and we'll send a private, one-time sign-in link. We never reveal whether an address has a vault."}
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (trustedUnlock
              ? unlockTrustedDevice()
              : recoveryToken
                ? recover()
                : lookUp());
          }}
          className="mt-10"
        >
          {!recoveryToken && !trustedUnlock ? (
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  reset();
                }}
                placeholder="you@example.com"
                autoComplete="username"
                inputMode="email"
                className="input"
                disabled={phase.kind === "looking" || phase.kind === "sent"}
              />
            </Field>
          ) : null}

          {recoveryToken || trustedUnlock ? <Field label="Password">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  reset();
                }}
                autoComplete="current-password"
                className="input pr-16"
                disabled={phase.kind !== "ready" && phase.kind !== "idle"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-3 text-xs font-medium text-muted hover:text-[var(--text)]"
                aria-pressed={showPassword}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </Field> : null}

          {phase.kind === "sent" ? (
            <div className="mt-4">
              <InlineAlert tone="ok">
                If that address belongs to a password-enabled vault, a
                15-minute sign-in link is on its way. Check spam too.
              </InlineAlert>
            </div>
          ) : null}

          {phase.kind === "exchanging" ? (
            <p className="mt-4 text-sm text-muted">Checking your one-time link…</p>
          ) : null}

          {phase.kind === "unsealing" ? (
            <div className="mt-4">
              <p className="text-sm text-muted">
                Signing you in… {phase.progress}%
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-[var(--surface-2)]">
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${Math.max(5, phase.progress)}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4">
              <InlineAlert tone="alarm">{error}</InlineAlert>
              {recoveryToken && bundles.length === 0 ? (
                <button
                  type="button"
                  className="mt-3 text-xs underline text-muted hover:text-[var(--text)]"
                  onClick={() => onNavigate("checkin")}
                >
                  Request a new sign-in link
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6">
            <Button
              type="submit"
              size="lg"
              loading={
                phase.kind === "looking" ||
                phase.kind === "exchanging" ||
                phase.kind === "unsealing"
              }
              disabled={
                phase.kind === "looking" ||
                phase.kind === "sent" ||
                phase.kind === "exchanging" ||
                phase.kind === "unsealing" ||
                (Boolean(recoveryToken) && bundles.length === 0)
              }
            >
              {recoveryToken || trustedUnlock
                ? "Unlock vault"
                : "Email me a sign-in link"}
            </Button>
          </div>
        </form>

        {trustedUnlock ? (
          <div className="mt-6 text-center">
            <button
              type="button"
              className="text-xs text-muted underline hover:text-[var(--text)]"
              onClick={() => {
                setError(null);
                setPassword("");
                setUseEmailRecovery(true);
              }}
            >
              Use email recovery instead
            </button>
          </div>
        ) : null}

        {!trustedUnlock ? <div className="mt-10 border-t border-app pt-6 text-center text-xs text-muted">
          New here?{" "}
          <button
            type="button"
            className="underline hover:text-[var(--text)]"
            onClick={() => onNavigate("setup")}
          >
            Set up a vault
          </button>
        </div> : null}
      </div>
    </main>
  );
}
