/**
 * Heir claim page.
 *
 * This is what someone sees when they click the one-time link they
 * received by SMS / WhatsApp / email. They have never opened GhostKey
 * before. They may have never owned Bitcoin. The page has to be:
 *
 *   - immediately understandable in one read
 *   - phone-first (the link arrived on a phone)
 *   - free of jargon, free of crypto twitter tone
 *   - honest about what GhostKey can and cannot do today
 *
 * What the page does:
 *   - resolves the token against `GET /claim/:token`
 *   - renders one of five states (loading / not-found / used / not-ready /
 *     claimable) with calm, accessible copy
 *   - on the claimable path, probes /sealed-heir once to decide which
 *     of the two sub-flows applies:
 *
 *     • Password-vault flow (PasswordVaultClaim, default for new
 *       vaults): the heir pastes a Bitcoin address from any receive-
 *       capable wallet. The browser unwraps the heir xprv locally
 *       from the URL fragment and POSTs it to /heir-claim, where the
 *       server builds + signs + broadcasts in one shot. No PSBT, no
 *       Sparrow, no signing in another app.
 *
 *     • PSBT-handoff flow (ManualPsbtClaim, reachable when
 *       /sealed-heir returns 422): the heir holds their own key (Door B)
 *       or this is a legacy vault. The server hands them an unsigned
 *       PSBT to sign in a wallet that can satisfy the Taproot timelock
 *       script. Most phone wallets can't; Bitcoin Core is the tested
 *       signer. The signed string is accepted back here.
 *
 * What the page does NOT do:
 *   - hold keys for the heir or persist their xprv beyond a single
 *     async call (password-vault flow)
 *   - co-sign anything on the legacy path
 *   - hide failure modes: if any of the server calls fail (no UTXOs,
 *     Esplora down, timelock not yet mined, etc.) we surface the
 *     server's error message verbatim so a Bitcoin-literate helper
 *     can debug it
 *
 * The whole page intentionally bypasses the GhostKey navbar — the heir
 * shouldn't see "Set up" / "Dashboard" / "Sign in" controls that don't
 * apply to them. App.tsx handles that swap.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Field,
  Tile,
  InlineAlert,
  useTicker,
} from "./ui";
import {
  ApiError,
  api,
  type BroadcastClaimResponse,
  type BuildClaimPsbtResponse,
  type ClaimView,
  type HeirDerivationParamsView,
  type SealedHeirView,
  type VaultBalanceView,
} from "./api";
import { usePrice, btcAndUsd } from "./fiat";
import { countdown, parseRfc } from "./time";
import { HeirVideoMessage } from "./HeirVideoMessage";
import { ConfirmSend } from "./ConfirmSend";
import {
  addressMatchesNetwork,
  bech32PrefixFor,
  looksLikeBitcoinAddress,
} from "./address";
import { b64decode, unsealHeirXprv } from "./crypto/sealing";
import { deriveHeirKey } from "./crypto/heirKey";
import type { Network } from "./crypto/keygen";
import {
  buildHeirEnvelope,
  downloadHeirEnvelope,
  type HeirEnvelope,
} from "./independenceProof";
import {
  classifyClaimError,
  rawErrorMessage,
  type ClaimContext,
} from "./claimErrors";

type State =
  | { kind: "loading" }
  | { kind: "ok"; view: ClaimView }
  | { kind: "not-found" }
  | { kind: "used" }
  | { kind: "error"; error: unknown };

interface Props {
  token: string;
}

export function ClaimPage({ token }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const view = await api.resolveClaim(token);
      setState({ kind: "ok", view });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 404) {
          setState({ kind: "not-found" });
          return;
        }
        if (e.status === 409) {
          setState({ kind: "used" });
          return;
        }
      }
      setState({ kind: "error", error: e });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-screen bg-app fade-in">
      <ClaimHeader />

      <main className="mx-auto max-w-xl px-5 py-10 md:py-16">
        {state.kind === "loading" && <LoadingState />}
        {state.kind === "not-found" && <NotFoundState />}
        {state.kind === "used" && <AlreadyUsedState />}
        {state.kind === "error" && (
          <ErrorState error={state.error} onRetry={load} />
        )}
        {state.kind === "ok" && <Resolved view={state.view} token={token} />}
      </main>

      <ClaimFooter />
    </div>
  );
}

/* ------------------------------ Header ------------------------------------ */

function ClaimHeader() {
  return (
    <header className="border-b border-app">
      <div className="mx-auto flex h-[60px] max-w-xl items-center justify-between px-5 md:px-8">
        <span className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight">
          <img src="/brand-mark.png" alt="" className="h-7 w-auto" />
          <span>ghost<span className="text-accent">Key</span></span>
        </span>
        <span className="text-xs text-muted">A message for you</span>
      </div>
    </header>
  );
}

/* ----------------------------- States ------------------------------------- */

function LoadingState() {
  return (
    <section className="text-center" aria-busy="true" aria-live="polite">
      <div className="mx-auto h-2 w-32 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full w-1/2 animate-pulse rounded-full bg-[var(--accent)]"
          style={{ animationDuration: "1.2s" }}
        />
      </div>
      <p className="mt-6 text-sm text-muted">Opening your link…</p>
    </section>
  );
}

function NotFoundState() {
  return (
    <section className="text-center">
      <Eyebrow>This link doesn't work</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        We couldn't find anything for this link
      </h1>
      <p className="mt-4 text-muted">
        The link may be incomplete, expired, or copied wrong. If someone gave
        you this by SMS or WhatsApp, ask them to send it again from the start.
      </p>
    </section>
  );
}

function AlreadyUsedState() {
  return (
    <section className="text-center">
      <Eyebrow>This link has already been opened</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        Looks like someone has been here before
      </h1>
      <p className="mt-4 text-muted">
        A claim link works once. If you've already received what was left for
        you, you're done. If you haven't, contact the person who set this
        up. They can issue a new link.
      </p>
    </section>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const copy = classifyClaimError(error, "resolve");
  return (
    <section className="text-center">
      <Eyebrow>Something went wrong</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        {copy.headline}
      </h1>
      <p className="mt-4 text-muted">{copy.body}</p>
      <p className="mt-2 text-sm text-muted">{copy.nextStep}</p>
      <TechnicalDetails error={error} align="center" />
      {copy.kind !== "contact" && (
        <div className="mt-6">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </section>
  );
}

/**
 * Collapsed footer block holding the raw server / client error
 * string. The heir never needs this; a Bitcoin-literate helper they
 * forward the page to does. Keep it out of the way but reachable.
 */
function TechnicalDetails({
  error,
  align = "left",
}: {
  error: unknown;
  align?: "left" | "center";
}) {
  const raw = rawErrorMessage(error);
  if (!raw) return null;
  return (
    <details
      className={`mt-4 ${align === "center" ? "mx-auto inline-block text-left" : ""}`}
    >
      <summary className="cursor-pointer text-xs text-dim">
        Show technical details
      </summary>
      <p className="mt-1 break-all font-mono text-xs text-dim">{raw}</p>
    </details>
  );
}

/**
 * Shared error block for the in-flow failure states (probe error,
 * one-shot send error, build error, broadcast error). Looks up the
 * friendly copy from `claimErrors.ts` and tucks the raw message away
 * behind a "Show technical details" toggle.
 */
function ClaimErrorBlock({
  error,
  context,
}: {
  error: unknown;
  context: ClaimContext;
}) {
  const copy = classifyClaimError(error, context);
  return (
    <div className="mt-4">
      <InlineAlert tone="alarm">
        <p className="font-bold">{copy.headline}</p>
        <p className="mt-1 text-sm">{copy.body}</p>
        <p className="mt-2 text-sm">{copy.nextStep}</p>
        <TechnicalDetails error={error} />
      </InlineAlert>
    </div>
  );
}

/* ----------------------------- Resolved ----------------------------------- */

function Resolved({ view, token }: { view: ClaimView; token: string }) {
  // Decide which sub-flow to show based on vault status. The switch
  // is exhaustive over today's `VaultStatus` union; the `default`
  // branch exists so a server adding a new status doesn't silently
  // render an empty page — it shows the generic NotReadyState until
  // the web app catches up.
  const body = (() => {
    switch (view.status) {
      case "ok":
      case "warning":
        // Someone issued a claim link prematurely (owner is still active).
        // This is rare but possible if an operator runs issue-claim manually.
        return <NotReadyState view={view} />;
      case "alarmed":
      case "timelock_started": {
        // Claim-challenge window: the first open of this link alerted
        // the vault's owner, and the claim can only be completed once
        // the safety wait ends. Render the wait screen instead of
        // probing the (gated) claim endpoints.
        if (view.claim_available_at) {
          return (
            <ChallengeGate
              availableAt={new Date(view.claim_available_at)}
              view={view}
              token={token}
            />
          );
        }
        return <ClaimableState view={view} token={token} />;
      }
      case "claimed":
        return <AlreadyClaimedState view={view} />;
      default:
        return <NotReadyState view={view} />;
    }
  })();

  // The owner's video message (if any) sits above every state — it's the
  // heir's first reassurance the link is genuine, shown whether they're
  // waiting out the safety window or claiming right now.
  return (
    <>
      <HeirVideoMessage token={token} />
      {body}
    </>
  );
}

/**
 * Wraps the claimable flow in the challenge-window clock: while the
 * safety wait is running we show the wait screen, and the ticker
 * flips the page into the real claim flow the minute it ends — no
 * reload needed if the heir leaves the tab open.
 */
function ChallengeGate({
  availableAt,
  view,
  token,
}: {
  availableAt: Date;
  view: ClaimView;
  token: string;
}) {
  const now = useTicker(30_000);
  if (now.getTime() >= availableAt.getTime()) {
    return <ClaimableState view={view} token={token} />;
  }
  return <SafetyWaitState availableAt={availableAt} now={now} />;
}

/**
 * Shown between the first open of the claim link and the end of the
 * challenge window. Calm by design: the heir has done everything
 * right, the wait is a feature, and they'll get an email when it
 * ends — no action needed, no jargon.
 */
function SafetyWaitState({ availableAt, now }: { availableAt: Date; now: Date }) {
  const cd = useMemo(() => countdown(availableAt, now), [availableAt, now]);
  const friendly = availableAt.toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <section>
      <Eyebrow>Almost there</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        Your claim has started. There's a short safety wait
      </h1>
      <p className="mt-4 text-muted">
        You've done everything right, and what was left for you is being
        prepared. For everyone's protection, every claim includes a short
        waiting period before anything can be collected.
      </p>
      <p className="mt-3 text-muted">
        Come back <strong>{friendly}</strong> ({cd.friendly}) using this
        same link. We'll also email you when it's time, so you don't have
        to remember.
      </p>
      <p className="mt-3 text-sm text-dim">
        Why the wait? It gives the person who set this up one last chance
        to respond if this claim was started by mistake. If nothing
        changes, your claim continues automatically.
      </p>
    </section>
  );
}

function NotReadyState({ view }: { view: ClaimView }) {
  const now = useTicker(60_000);
  const cd = useMemo(
    () => countdown(parseRfc(view.next_deadline_at), now),
    [view.next_deadline_at, now],
  );
  return (
    <section>
      <Eyebrow>Not yet</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        It's not time yet
      </h1>
      <p className="mt-4 text-muted">
        The person who set this up is still active. There's nothing for you to
        do today. You'll receive a new message if anything changes.
      </p>
      <p className="mt-3 text-sm text-dim">Next check-in {cd.friendly}.</p>
    </section>
  );
}

function AlreadyClaimedState({ view }: { view: ClaimView }) {
  return (
    <section>
      <Eyebrow>Done</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        This has already been passed on
      </h1>
      <p className="mt-4 text-muted">
        {view.label
          ? `"${view.label}" was claimed earlier.`
          : "This inheritance was claimed earlier."}{" "}
        Nothing more to do here.
      </p>
    </section>
  );
}

/* ----------------------------- Claimable ---------------------------------- */

/**
 * Two distinct claim flows live behind this entry point:
 *
 *   1. Password-vault flow (the default for vaults set up after the
 *      crypto redesign): the heir's xprv is sealed server-side under
 *      HKDF(claim_token). The browser reads the token from the URL
 *      fragment, fetches the sealed blob via /claim/:token/sealed-heir,
 *      unwraps locally, and POSTs to /claim/:token/heir-claim, which
 *      builds + signs + broadcasts in one shot. No wallet install
 *      required on the heir's side.
 *
 *   2. Legacy PSBT-handoff flow (for vaults created before the
 *      redesign): the server cannot produce a sealed-heir view (the
 *      column is NULL), so /sealed-heir returns 422 and we fall back
 *      to the original "ask the server for an unsigned PSBT, paste
 *      it into Sparrow, paste the signed PSBT back" path. The heir
 *      needs a real Bitcoin wallet for this.
 *
 * Detection is a single GET. We surface a small spinner during the
 * probe and pick the sub-flow once we know.
 */
function ClaimableState({ view, token }: { view: ClaimView; token: string }) {
  // Guardian vaults (#81) need the heir plus one guardian, so they have
  // their own two-link flow rather than the heir-derivation / sealed-heir
  // probe. Dispatch here (no hooks) so each sub-flow owns its own hooks.
  if (view.vault_kind === "guardian") {
    return <GuardianClaim view={view} token={token} />;
  }
  return <HeirClaimable view={view} token={token} />;
}

function HeirClaimable({
  view,
  token,
}: {
  view: ClaimView;
  token: string;
}) {
  const [flow, setFlow] = useState<
    | { kind: "probing" }
    | { kind: "password-vault"; sealed: SealedHeirView }
    | { kind: "derived-heir"; params: HeirDerivationParamsView }
    | { kind: "manual-psbt" }
    | { kind: "probe-error"; error: unknown }
  >({ kind: "probing" });

  useEffect(() => {
    let cancelled = false;
    // The server's "this vault is the wrong shape for this endpoint"
    // probe signal. ApiError::Validation maps to HTTP 400 with a
    // `validation: this vault was not created with ...` body; we match
    // on the message (422 kept for belt-and-braces against any future
    // remap) because matching the bare status code is what broke this
    // flow before: 400 also covers genuine bad requests.
    const isWrongShape = (e: unknown): e is ApiError =>
      e instanceof ApiError &&
      (e.status === 422 ||
        (e.status === 400 && /this vault was not created with/i.test(e.message)));
    (async () => {
      // F2 first: if this vault was created with heir_derivation, the
      // dedicated endpoint returns 200 with the derivation params and
      // we skip the sealed-heir path entirely. A wrong-shape error
      // means this is NOT an F2 vault, in which case we fall through
      // to the password-vault / manual-psbt detection that pre-dated
      // F2.
      try {
        const params = await api.getHeirDerivationParams(token);
        if (!cancelled) setFlow({ kind: "derived-heir", params });
        return;
      } catch (e) {
        if (cancelled) return;
        if (!isWrongShape(e)) {
          setFlow({ kind: "probe-error", error: e });
          return;
        }
        // Not an F2 vault. Fall through.
      }

      try {
        const sealed = await api.getSealedHeirXprv(token);
        if (!cancelled) setFlow({ kind: "password-vault", sealed });
      } catch (e) {
        if (cancelled) return;
        // Wrong shape = no sealed blob on this row = legacy vault.
        // The legacy two-step flow still works for it.
        if (isWrongShape(e)) {
          setFlow({ kind: "manual-psbt" });
          return;
        }
        // 404 / 409 should already have been handled by the outer
        // Resolved switch, but just in case we slip through, bubble.
        setFlow({ kind: "probe-error", error: e });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (flow.kind === "probing") {
    return <LoadingState />;
  }
  if (flow.kind === "probe-error") {
    const copy = classifyClaimError(flow.error, "probe");
    return (
      <section>
        <Eyebrow>Hold on</Eyebrow>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
          {copy.headline}
        </h1>
        <p className="mt-3 text-muted">{copy.body}</p>
        <p className="mt-2 text-sm text-muted">{copy.nextStep}</p>
        <TechnicalDetails error={flow.error} />
      </section>
    );
  }
  if (flow.kind === "password-vault") {
    return <PasswordVaultClaim view={view} token={token} sealed={flow.sealed} />;
  }
  if (flow.kind === "derived-heir") {
    return <DerivedHeirClaim view={view} token={token} params={flow.params} />;
  }
  return <ManualPsbtClaim view={view} token={token} />;
}

/* ---------------------- Guardian vault claim (#81) ------------------------- */

/** Pull the claim token out of a pasted GhostKey link, or accept a bare
 *  token. Links look like `{base}/#/claim/{token}`; we take everything
 *  after `/claim/` up to the next path/query/hash separator. */
function extractClaimToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const marker = "/claim/";
  const i = s.lastIndexOf(marker);
  const raw = i >= 0 ? s.slice(i + marker.length) : s;
  const tok = raw.split(/[/?#\s]/)[0];
  return tok || null;
}

/**
 * Guardian vault claim: the heir AND one guardian must finish together
 * (spend branch `heir AND (g1 OR g2)`). Each holds their own one-time
 * link. This page works from either link: whichever opened it, we ask
 * for the other party's link, unwrap both keys locally, and POST a
 * single two-key claim to the heir token's `/guardian-claim` endpoint.
 *
 * Keeping both keys client-side until the one submit mirrors the heir
 * one-shot flow: each xprv is unwrapped from its own claim token, used
 * for a single call, and dropped.
 */
function GuardianClaim({ view, token }: { view: ClaimView; token: string }) {
  const openedRole = view.token_role; // "heir" | "guardian"
  const [otherLink, setOtherLink] = useState("");
  const [otherToken, setOtherToken] = useState<string | null>(null);
  const [otherErr, setOtherErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [address, setAddress] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BroadcastClaimResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const heir = view.heir_display_name?.trim() || "your family member";

  // The two-key claim always POSTs to the heir token. One of heir/guardian
  // token is the one that opened this page; the other is pasted in.
  const heirToken = openedRole === "heir" ? token : otherToken;
  const guardianToken = openedRole === "guardian" ? token : otherToken;
  const needLabel = openedRole === "heir" ? "a guardian's" : "the heir's";

  const checkOtherLink = useCallback(async () => {
    const t = extractClaimToken(otherLink);
    if (!t) {
      setOtherErr("That doesn't look like a GhostKey link. Paste the whole link.");
      return;
    }
    if (t === token) {
      setOtherErr("That's the link you already opened. Paste the other person's link.");
      return;
    }
    setChecking(true);
    setOtherErr(null);
    try {
      const other = await api.resolveClaim(t);
      if (other.vault_id !== view.vault_id) {
        setOtherErr("That link is for a different inheritance. Check you have the right one.");
        setOtherToken(null);
        return;
      }
      const needRole = openedRole === "heir" ? "guardian" : "heir";
      if (other.token_role !== needRole) {
        setOtherErr(
          openedRole === "heir"
            ? "That's another heir link. You need a guardian's link to finish."
            : "That's a guardian link. You need the heir's link to finish.",
        );
        setOtherToken(null);
        return;
      }
      setOtherToken(t);
    } catch (e) {
      setOtherErr(
        e instanceof ApiError && e.status === 409
          ? "That link has already been used."
          : "We couldn't check that link. Try again in a moment.",
      );
      setOtherToken(null);
    } finally {
      setChecking(false);
    }
  }, [otherLink, token, view.vault_id, openedRole]);

  const bothReady = Boolean(heirToken && guardianToken);
  const addrShapeOk = looksLikeBitcoinAddress(address);
  const addrNetworkOk = addressMatchesNetwork(address, view.network);
  const validAddr = addrShapeOk && addrNetworkOk;
  const feeRateNum = parseFeeRate(feeRate);
  const feeRateValid = feeRate.trim() === "" || feeRateNum !== null;

  const onSubmit = useCallback(async () => {
    if (!bothReady || !validAddr || !feeRateValid) return;
    if (!heirToken || !guardianToken) return;
    setSubmitting(true);
    setError(null);
    // Both xprvs live only for this call; null the references after.
    let heirXprv: string | null = null;
    let guardianXprv: string | null = null;
    try {
      const heirSealed = await api.getSealedHeirXprv(heirToken);
      heirXprv = unsealHeirXprv(b64decode(heirToken), {
        v: 1,
        ct: heirSealed.heir_xprv_ct_b64,
        nonce: heirSealed.heir_xprv_nonce_b64,
      });
      const gSealed = await api.getSealedGuardianXprv(guardianToken);
      guardianXprv = unsealHeirXprv(b64decode(guardianToken), {
        v: 1,
        ct: gSealed.guardian_xprv_ct_b64,
        nonce: gSealed.guardian_xprv_nonce_b64,
      });
      const resp = await api.guardianClaim(heirToken, {
        destination: address.trim(),
        fee_rate_sat_per_vb: feeRateNum,
        heir_xprv: heirXprv,
        guardian_xprv: guardianXprv,
      });
      setResult(resp);
    } catch (e) {
      setError(e);
    } finally {
      heirXprv = null;
      guardianXprv = null;
      setSubmitting(false);
    }
  }, [
    address,
    feeRateNum,
    feeRateValid,
    validAddr,
    bothReady,
    heirToken,
    guardianToken,
  ]);

  if (result) {
    return (
      <section>
        <p className="eyebrow">It's done</p>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
          Sent.
        </h1>
        <BroadcastSuccess result={result} />
      </section>
    );
  }

  return (
    <section>
      <p className="eyebrow">Two of you, together</p>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
        {openedRole === "heir" ? `Hello ${heir}.` : `Helping ${heir}.`}
      </h1>
      <p className="mt-4 text-base text-body md:text-lg">
        {openedRole === "heir"
          ? `Someone set this up so that ${heir} and a trusted guardian finish it together. You can't do it alone, and that's on purpose. Ask one guardian to be with you now.`
          : `${heir} was set up with a guardian's help. You're one of the guardians. To finish, ${heir} and you do this together on this page.`}
      </p>

      <div className="mt-8 card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          What's being passed on
        </p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">
          {view.label || "A Bitcoin inheritance"}
        </p>
        <p className="mt-1 text-xs text-muted">
          On the {networkLabel(view.network)}.
        </p>
        <VaultValueLine vaultId={view.vault_id} />
      </div>

      <div className="mt-10">
        <p className="text-xs uppercase tracking-wider text-dim">Step 1</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
          Bring in {needLabel} link
        </h2>
        <p className="mt-2 text-sm text-soft">
          {openedRole === "heir"
            ? "Each guardian got their own message with a link. Ask one guardian to open their link and paste it below, or paste it for them."
            : "The heir got their own message with a link. Paste it below so the two halves come together."}
        </p>

        {otherToken ? (
          <div className="mt-4">
            <InlineAlert tone="ok">
              Both links are here. You can finish below.
            </InlineAlert>
          </div>
        ) : (
          <div className="mt-4">
            <Field
              label={`Paste ${needLabel} link`}
              hint={otherErr ?? "It's the long web link from their message."}
            >
              <textarea
                rows={2}
                value={otherLink}
                onChange={(e) => setOtherLink(e.target.value)}
                placeholder="https://…/#/claim/…"
                spellCheck={false}
                autoComplete="off"
                className="textarea"
                disabled={checking}
              />
            </Field>
            <div className="mt-3">
              <Button
                onClick={() => void checkOtherLink()}
                disabled={checking || !otherLink.trim()}
              >
                {checking ? "Checking…" : "Add this link"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {bothReady && (
        <div className="mt-10">
          <p className="text-xs uppercase tracking-wider text-dim">Step 2</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Where should the money go?
          </h2>
          <p className="mt-2 text-sm text-soft">
            Open any Bitcoin wallet and tap <strong>Receive</strong> to get an
            address. Copy the long address that starts with{" "}
            <code className="font-mono">{bech32PrefixFor(view.network)}</code>{" "}
            and paste it below.
          </p>

          <div className="mt-4">
            <Field
              label="Bitcoin address"
              hint={
                address && !addrShapeOk
                  ? "That doesn't look like a Bitcoin address. Check the start."
                  : address && !addrNetworkOk
                    ? `That address is for a different network. It should start with ${bech32PrefixFor(view.network)}.`
                    : undefined
              }
            >
              <textarea
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={`${bech32PrefixFor(view.network)}...`}
                spellCheck={false}
                autoComplete="off"
                className="textarea"
                disabled={submitting || confirming}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field
              label="Fee rate in sat/vB (optional)"
              hint={
                feeRate.trim() && !feeRateValid
                  ? "Enter a whole number between 1 and 1000, or leave blank."
                  : "Leave blank to use 2 sat/vB."
              }
            >
              <input
                type="text"
                inputMode="numeric"
                value={feeRate}
                onChange={(e) => setFeeRate(e.target.value)}
                placeholder="2"
                className="input"
                disabled={submitting || confirming}
              />
            </Field>
          </div>

          {!confirming ? (
            <>
              <div className="mt-4">
                <Button
                  onClick={() => setConfirming(true)}
                  disabled={!validAddr || !feeRateValid}
                  size="lg"
                >
                  Review and send
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted">
                We'll show you the details to check, then prepare and broadcast
                the transaction for both of you. No app to install.
              </p>
            </>
          ) : (
            <div className="mt-4 card-flat p-4">
              <ConfirmSend
                destination={address.trim()}
                amountLabel="Everything in the vault, minus the network fee"
                networkLabel={networkLabel(view.network)}
                feeLabel={feeRateNum ? `${feeRateNum} sat/vB` : "2 sat/vB"}
                busy={submitting}
                confirmLabel={submitting ? "Sending Bitcoin…" : "Send the Bitcoin"}
                onConfirm={() => void onSubmit()}
                onBack={() => setConfirming(false)}
              />
            </div>
          )}

          {error ? <ClaimErrorBlock error={error} context="send" /> : null}
        </div>
      )}
    </section>
  );
}

/* ------------------ Password-vault claim (one-shot) ------------------------ */

/**
 * The happy path for vaults set up via the password-vault flow.
 *
 * Flow:
 *   1. Heir picks (or grabs) a Bitcoin address where the funds should
 *      land. Any wallet that can receive will do — no PSBT signing,
 *      no advanced features. Wallet of Satoshi works fine here, where
 *      it could not in the legacy path.
 *   2. On submit, we:
 *        a. b64decode(token) -> 32 raw token bytes
 *        b. unsealHeirXprv(rawBytes, sealedBlob) -> heir account xprv
 *           (pure local; KEK derived from HKDF-SHA256 of the token)
 *        c. POST /claim/:token/heir-claim with { destination, heir_xprv }
 *           — the server builds, signs, broadcasts; the xprv is held
 *           in memory only for that single call.
 *        d. Wipe our local copy of the unwrapped xprv, regardless of
 *           outcome.
 *
 * What if step (c) fails? The atomic claim-token consumption on the
 * server is rolled back on broadcast failure (release_claim_token),
 * so the heir can retry. We surface the server's error verbatim
 * because the realistic causes (no UTXOs, timelock not yet matured,
 * Esplora down) all need a Bitcoin-literate person to read.
 */
function PasswordVaultClaim({
  view,
  token,
  sealed,
}: {
  view: ClaimView;
  token: string;
  sealed: SealedHeirView;
}) {
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [address, setAddress] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BroadcastClaimResponse | null>(null);
  // The unwrapped error object, not just a string — `claimErrors.ts`
  // needs the HTTP status as well as the message text to classify
  // correctly.
  const [error, setError] = useState<unknown>(null);

  const heir = view.heir_display_name?.trim() || "you";
  const addrShapeOk = looksLikeBitcoinAddress(address);
  const addrNetworkOk = addressMatchesNetwork(address, sealed.network);
  const validAddr = addrShapeOk && addrNetworkOk;
  const feeRateNum = parseFeeRate(feeRate);
  const feeRateValid = feeRate.trim() === "" || feeRateNum !== null;

  const onSubmit = useCallback(async () => {
    if (!validAddr || !feeRateValid) return;
    setSubmitting(true);
    setError(null);

    // Holds the unwrapped xprv only for the duration of this call.
    // JS strings can't be securely wiped (V8 may have copied), but we
    // still null the reference to encourage GC. The xprv leaves this
    // scope only as part of the POST body, which fetch() owns and
    // garbage-collects on its own schedule.
    let heirXprv: string | null = null;
    try {
      const rawToken = b64decode(token);
      // unsealHeirXprv throws on a Poly1305 tag mismatch — handled
      // generically by the Poly1305 entry in `claimErrors.ts`.
      heirXprv = unsealHeirXprv(rawToken, {
        v: 1,
        ct: sealed.heir_xprv_ct_b64,
        nonce: sealed.heir_xprv_nonce_b64,
      });
      const resp = await api.heirClaim(token, {
        destination: address.trim(),
        fee_rate_sat_per_vb: feeRateNum,
        heir_xprv: heirXprv,
      });
      setResult(resp);
    } catch (e) {
      setError(e);
    } finally {
      heirXprv = null;
      setSubmitting(false);
    }
  }, [address, feeRateNum, feeRateValid, sealed, token, validAddr]);

  if (result) {
    return (
      <section>
        <p className="eyebrow">Someone left you something</p>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
          Hello {heir}.
        </h1>
        <BroadcastSuccess result={result} />
      </section>
    );
  }

  return (
    <section>
      <p className="eyebrow">Someone left you something</p>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
        Hello {heir}.
      </h1>
      <p className="mt-4 text-base text-body md:text-lg">
        Someone you knew left you Bitcoin. They set up GhostKey so that if they
        ever stopped checking in, the link would reach you. That's what
        happened. This page is for you.
      </p>

      <div className="mt-8 card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          What's being passed on
        </p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">
          {view.label || "A Bitcoin inheritance"}
        </p>
        <p className="mt-1 text-xs text-muted">
          On the {networkLabel(sealed.network)}.
        </p>
        <VaultValueLine vaultId={view.vault_id} />
      </div>

      <div className="mt-10">
        <p className="text-xs uppercase tracking-wider text-dim">Step 1</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
          Do you have a Bitcoin wallet?
        </h2>
        <p className="mt-2 text-sm text-soft">
          A Bitcoin wallet is an app where you can receive Bitcoin. You only
          need one that can <em>receive</em> on the {networkLabel(sealed.network)}.{" "}
          {walletExamplesInline(sealed.network)} all work.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Tile
            selected={hasWallet === true}
            onClick={() => setHasWallet(true)}
            title="Yes, I do"
            sub="Skip to step 2"
          />
          <Tile
            selected={hasWallet === false}
            onClick={() => setHasWallet(false)}
            title="No, not yet"
            sub="We'll point you somewhere"
          />
        </div>

        {hasWallet === false && <WalletGuide network={sealed.network} />}
      </div>

      {hasWallet !== null && (
        <div className="mt-10">
          <p className="text-xs uppercase tracking-wider text-dim">Step 2</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Where should the money go?
          </h2>
          <p className="mt-2 text-sm text-soft">
            Open any Bitcoin wallet and tap <strong>Receive</strong>. A
            Lightning wallet works too. Apps like Wallet of Satoshi, Bitnob,
            Cash App, or Phoenix each give you a Bitcoin address that adds the
            money to your balance. Copy the long address that starts with{" "}
            <code className="font-mono">{bech32PrefixFor(sealed.network)}</code>{" "}
            and paste it below.
          </p>

          <div className="mt-4">
            <Field
              label="Your Bitcoin address"
              hint={
                address && !addrShapeOk
                  ? "That doesn't look like a Bitcoin address. Check the start."
                  : address && !addrNetworkOk
                    ? `That address is for a different network. It should start with ${bech32PrefixFor(sealed.network)}.`
                    : undefined
              }
            >
              <textarea
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={`${bech32PrefixFor(sealed.network)}...`}
                spellCheck={false}
                autoComplete="off"
                className="textarea"
                disabled={submitting || confirming}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field
              label="Fee rate in sat/vB (optional)"
              hint={
                feeRate.trim() && !feeRateValid
                  ? "Enter a whole number between 1 and 1000, or leave blank."
                  : "Leave blank to use 2 sat/vB. Raise it if you need the transaction to confirm faster."
              }
            >
              <input
                type="text"
                inputMode="numeric"
                value={feeRate}
                onChange={(e) => setFeeRate(e.target.value)}
                placeholder="2"
                className="input"
                disabled={submitting || confirming}
              />
            </Field>
          </div>

          {!confirming ? (
            <>
              <div className="mt-4">
                <Button
                  onClick={() => setConfirming(true)}
                  disabled={!validAddr || !feeRateValid}
                  size="lg"
                >
                  Review and send
                </Button>
              </div>

              <p className="mt-3 text-xs text-muted">
                We'll show you the details to check, then prepare and
                broadcast the transaction for you. You don't need to sign
                anything in another app.
              </p>
            </>
          ) : (
            <div className="mt-4 card-flat p-4">
              <ConfirmSend
                destination={address.trim()}
                amountLabel="Everything in the vault, minus the network fee"
                networkLabel={networkLabel(sealed.network)}
                feeLabel={feeRateNum ? `${feeRateNum} sat/vB` : "2 sat/vB"}
                busy={submitting}
                confirmLabel={submitting ? "Sending Bitcoin…" : "Send the Bitcoin"}
                onConfirm={() => void onSubmit()}
                onBack={() => setConfirming(false)}
              />
            </div>
          )}

          {error ? <ClaimErrorBlock error={error} context="send" /> : null}
        </div>
      )}

      <HeirRecoveryFileSection
        vaultId={sealed.vault_id}
        network={sealed.network}
        timelockBlocks={sealed.timelock_blocks}
        descriptorExternal={sealed.descriptor_external}
        descriptorInternal={sealed.descriptor_internal}
        heirName={view.heir_display_name?.trim() || ""}
        deriveXprv={() =>
          unsealHeirXprv(b64decode(token), {
            v: 1,
            ct: sealed.heir_xprv_ct_b64,
            nonce: sealed.heir_xprv_nonce_b64,
          })
        }
      />
    </section>
  );
}

/* ------------------ Manual PSBT-handoff flow (legacy) --------------------- */

/**
 * The original heir-claim path. The heir has the link, the timer has
 * run, the funds can be moved. We walk them through:
 *
 *   1. Make sure they have a Bitcoin wallet.
 *   2. Capture the address they want the funds to land at.
 *   3. Ask the server to build an unsigned PSBT (`/build-psbt`).
 *   4. Hand the PSBT to the heir so they (or a helper) can sign it in
 *      their own wallet — GhostKey never holds keys.
 *   5. Accept the signed PSBT and broadcast it (`/broadcast`).
 *   6. Show the txid + a mempool.space link.
 *
 * Each network call has its own loading + error state. The error path
 * shows the server's message verbatim because the realistic failure
 * modes ("no UTXOs at vault addresses", "timelock not yet mined",
 * "esplora: connection refused") all need a Bitcoin-literate human to
 * interpret. Sugaring those is misleading.
 */

/* -------------------- F2: heir-derived claim flow ------------------------- */

/**
 * Claim flow for vaults where the heir's xpub was server-derived
 * from an email. The heir doesn't need any setup ahead of time: we
 * recompute their BIP86 mnemonic + xprv locally from the server's
 * `vault_secret`, ship the xprv to the heir-claim endpoint (held
 * in memory only there), and then show the heir the 12-word
 * mnemonic so they can record it.
 *
 * Why also show the mnemonic? The heir-claim flow sweeps to a
 * destination address; once the funds land there, the derived key
 * is functionally retired. But the mnemonic is the only artefact
 * that exists OUTSIDE the server's master key — if the operator ever
 * loses the master key, the only way back to the derived xpub is the
 * mnemonic. Showing it once gives the heir a personal escape hatch.
 */
function DerivedHeirClaim({
  view,
  token,
  params,
}: {
  view: ClaimView;
  token: string;
  params: HeirDerivationParamsView;
}) {
  const [address, setAddress] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; resp: BroadcastClaimResponse; mnemonic: string }
    | null
  >(null);
  const [error, setError] = useState<unknown>(null);

  const heir = view.heir_display_name?.trim() || "you";
  const addrShapeOk = looksLikeBitcoinAddress(address);
  const addrNetworkOk = addressMatchesNetwork(address, params.network);
  const validAddr = addrShapeOk && addrNetworkOk;
  const feeRateNum = parseFeeRate(feeRate);
  const feeRateValid = feeRate.trim() === "" || feeRateNum !== null;

  const onSubmit = useCallback(async () => {
    if (!validAddr || !feeRateValid) return;
    setSubmitting(true);
    setError(null);

    let heirXprv: string | null = null;
    let mnemonic: string | null = null;
    try {
      const network = params.network as Network;
      const derived = deriveHeirKey(
        params.vault_secret_hex,
        params.heir_email,
        network,
      );
      heirXprv = derived.xprvBase58;
      mnemonic = derived.mnemonic;
      const resp = await api.heirClaim(token, {
        destination: address.trim(),
        fee_rate_sat_per_vb: feeRateNum,
        heir_xprv: heirXprv,
      });
      setResult({ kind: "ok", resp, mnemonic });
    } catch (e) {
      setError(e);
    } finally {
      heirXprv = null;
      // Keep `mnemonic` only inside `result` (state) on the success
      // path. On error we drop it.
      if (!mnemonic) mnemonic = null;
      setSubmitting(false);
    }
  }, [address, feeRateNum, feeRateValid, params, token, validAddr]);

  if (result) {
    return (
      <section>
        <p className="eyebrow">Someone left you something</p>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
          Hello {heir}.
        </h1>
        <BroadcastSuccess result={result.resp} />

        <div className="mt-10 card-flat p-5">
          <p className="text-xs uppercase tracking-wider text-dim">
            Your backup phrase
          </p>
          <p className="mt-2 text-sm text-soft">
            Write these 12 words down somewhere safe. They're the only
            way to recover this key without GhostKey. The funds you just
            claimed are already on their way to your address. This is
            just insurance.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {result.mnemonic.split(/\s+/).map((w, i) => (
              <div
                key={`${i}-${w}`}
                className="rounded bg-[var(--bg-elev)] p-2 font-mono text-xs"
              >
                <span className="text-dim">{i + 1}.</span> {w}
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <p className="eyebrow">Someone left you something</p>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
        Hello {heir}.
      </h1>
      <p className="mt-4 text-base text-body md:text-lg">
        Someone you knew left you Bitcoin. They set up GhostKey so that if
        they ever stopped checking in, the link would reach you. That's
        what happened. This page is for you.
      </p>

      <div className="mt-8 card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          Confirm this is you
        </p>
        <p className="mt-2 text-sm">
          They told us to expect <strong>{params.heir_email}</strong>. If
          that's not your email, stop and reach out to whoever sent you
          this link.
        </p>
      </div>

      <div className="mt-10">
        <p className="text-xs uppercase tracking-wider text-dim">Step 1</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
          Where should the money go?
        </h2>
        <p className="mt-2 text-sm text-soft">
          Paste any Bitcoin address you control on the {networkLabel(params.network)}.{" "}
          A Lightning wallet works too. Apps like Wallet of Satoshi, Bitnob,
          Cash App, or Phoenix each give you a Bitcoin address that adds the
          money to your balance. {walletExamplesInline(params.network)}.
        </p>

        <div className="mt-4">
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={`${bech32PrefixFor(params.network)}...`}
            autoComplete="off"
            className="input"
            disabled={submitting || confirming}
          />
          {address && !addrShapeOk ? (
            <p className="mt-1 text-xs text-alarm">
              That doesn't look like a Bitcoin address. Check the start.
            </p>
          ) : address && !addrNetworkOk ? (
            <p className="mt-1 text-xs text-alarm">
              That address is for a different network. It should start with{" "}
              {bech32PrefixFor(params.network)}.
            </p>
          ) : null}
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">
            Advanced: custom fee rate
          </summary>
          <div className="mt-2">
            <input
              type="text"
              value={feeRate}
              onChange={(e) => setFeeRate(e.target.value)}
              placeholder="sat/vB (optional, e.g. 4)"
              autoComplete="off"
              className="input"
              disabled={submitting || confirming}
            />
          </div>
        </details>
      </div>

      {error ? <ClaimErrorBlock error={error} context="send" /> : null}

      {!confirming ? (
        <div className="mt-8">
          <Button
            onClick={() => setConfirming(true)}
            disabled={!validAddr || !feeRateValid}
          >
            Review and claim
          </Button>
        </div>
      ) : (
        <div className="mt-8 card-flat p-4">
          <ConfirmSend
            destination={address.trim()}
            amountLabel="Everything in the vault, minus the network fee"
            networkLabel={networkLabel(params.network)}
            feeLabel={feeRateNum ? `${feeRateNum} sat/vB` : "2 sat/vB"}
            busy={submitting}
            confirmLabel={submitting ? "Sending Bitcoin…" : "Claim and send"}
            onConfirm={() => void onSubmit()}
            onBack={() => setConfirming(false)}
          />
        </div>
      )}

      <HeirRecoveryFileSection
        vaultId={params.vault_id}
        network={params.network}
        timelockBlocks={params.timelock_blocks}
        descriptorExternal={params.descriptor_external}
        descriptorInternal={params.descriptor_internal}
        heirName={view.heir_display_name?.trim() || ""}
        deriveXprv={() =>
          deriveHeirKey(
            params.vault_secret_hex,
            params.heir_email,
            params.network as Network,
          ).xprvBase58
        }
      />
    </section>
  );
}

function ManualPsbtClaim({
  view,
  token,
}: {
  view: ClaimView;
  token: string;
}) {
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [address, setAddress] = useState("");
  const [feeRate, setFeeRate] = useState("");

  /** PSBT build phase. */
  const [building, setBuilding] = useState(false);
  const [build, setBuild] = useState<BuildClaimPsbtResponse | null>(null);
  const [buildError, setBuildError] = useState<unknown>(null);

  /** Broadcast phase. */
  const [signedPsbt, setSignedPsbt] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcast, setBroadcast] = useState<BroadcastClaimResponse | null>(
    null,
  );
  const [broadcastError, setBroadcastError] = useState<unknown>(null);

  /** "Copied!" feedback for the base64 PSBT block. */
  const [copied, setCopied] = useState(false);

  const heir = view.heir_display_name?.trim() || "you";
  const addrShapeOk = looksLikeBitcoinAddress(address);
  const addrNetworkOk = addressMatchesNetwork(address, view.network);
  const validAddr = addrShapeOk && addrNetworkOk;
  const feeRateNum = parseFeeRate(feeRate);
  const feeRateValid = feeRate.trim() === "" || feeRateNum !== null;

  const onBuild = useCallback(async () => {
    if (!validAddr || !feeRateValid) return;
    setBuilding(true);
    setBuildError(null);
    setBuild(null);
    try {
      const res = await api.buildClaimPsbt(token, {
        destination: address.trim(),
        fee_rate_sat_per_vb: feeRateNum,
      });
      setBuild(res);
    } catch (e) {
      setBuildError(e);
    } finally {
      setBuilding(false);
    }
  }, [address, feeRateNum, feeRateValid, token, validAddr]);

  const onCopyPsbt = useCallback(async () => {
    if (!build) return;
    try {
      await navigator.clipboard.writeText(build.psbt_b64);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context, permissions);
      // the heir can still long-press / select the text block manually.
    }
  }, [build]);

  const onBroadcast = useCallback(async () => {
    const trimmed = signedPsbt.trim();
    if (!trimmed) return;
    setBroadcasting(true);
    setBroadcastError(null);
    setBroadcast(null);
    try {
      const res = await api.broadcastClaim(token, {
        signed_psbt_b64: trimmed,
      });
      setBroadcast(res);
    } catch (e) {
      setBroadcastError(e);
    } finally {
      setBroadcasting(false);
    }
  }, [signedPsbt, token]);

  return (
    <section>
      <p className="eyebrow">Someone left you something</p>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-5xl">
        Hello {heir}.
      </h1>
      <p className="mt-4 text-base text-body md:text-lg">
        Someone you knew left you Bitcoin. They set up GhostKey so that if they
        ever stopped checking in, the link would reach you. That's what
        happened. This page is for you.
      </p>

      {/* ---- What you're inheriting ---- */}
      <div className="mt-8 card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          What's being passed on
        </p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">
          {view.label || "A Bitcoin inheritance"}
        </p>
        <p className="mt-1 text-xs text-muted">
          On the {networkLabel(view.network)}.
        </p>
        <VaultValueLine vaultId={view.vault_id} />
      </div>

      {/* ---- Step 1: do you have a Bitcoin wallet? ---- */}
      <div className="mt-10">
        <p className="text-xs uppercase tracking-wider text-dim">Step 1</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
          Do you have a Bitcoin wallet?
        </h2>
        <p className="mt-2 text-sm text-soft">
          A Bitcoin wallet is an app where you can receive and hold Bitcoin on
          the {networkLabel(view.network)}. This claim is special: it needs a
          wallet that can sign a Bitcoin Taproot timelock.{" "}
          <strong>Most phone wallets can't.</strong> The one we've tested is
          Bitcoin Core, on a computer.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Tile
            selected={hasWallet === true}
            onClick={() => setHasWallet(true)}
            title="Yes, I do"
            sub="On a computer"
          />
          <Tile
            selected={hasWallet === false}
            onClick={() => setHasWallet(false)}
            title="No, not yet"
            sub="We'll point you somewhere"
          />
        </div>

        {hasWallet === true && (
          <div className="mt-4">
            <InlineAlert tone="warning">
              One thing to check first: most phone wallets can't sign this
              kind of claim. If your wallet can't sign a Bitcoin Taproot
              script, choose <strong>No, not yet</strong> and we'll point you
              to Bitcoin Core.
            </InlineAlert>
          </div>
        )}

        {hasWallet === false && (
          <WalletGuide network={view.network} requirePsbt />
        )}
      </div>

      {/* ---- Step 2: paste address + (optional) fee rate ---- */}
      {hasWallet !== null && (
        <div className="mt-10">
          <p className="text-xs uppercase tracking-wider text-dim">Step 2</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Where should the Bitcoin go?
          </h2>
          <p className="mt-2 text-sm text-soft">
            Open your wallet. Tap <strong>Receive</strong>. Copy the long
            address that starts with{" "}
            <code className="font-mono">{bech32PrefixFor(view.network)}</code>.
            Paste it below.
          </p>

          <div className="mt-4">
            <Field
              label="Your Bitcoin address"
              hint={
                address && !addrShapeOk
                  ? "That doesn't look like a Bitcoin address. Check the start."
                  : address && !addrNetworkOk
                    ? `That address is for a different network. It should start with ${bech32PrefixFor(view.network)}.`
                    : undefined
              }
            >
              <textarea
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={`${bech32PrefixFor(view.network)}...`}
                spellCheck={false}
                autoComplete="off"
                className="textarea"
                disabled={build !== null || building}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field
              label="Fee rate in sat/vB (optional)"
              hint={
                feeRate.trim() && !feeRateValid
                  ? "Enter a whole number between 1 and 1000, or leave blank."
                  : "Leave blank to use 2 sat/vB. Raise it if you need the transaction to confirm faster."
              }
            >
              <input
                type="text"
                inputMode="numeric"
                value={feeRate}
                onChange={(e) => setFeeRate(e.target.value)}
                placeholder="2"
                className="input"
                disabled={build !== null || building}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => void onBuild()}
              disabled={
                !validAddr || !feeRateValid || building || build !== null
              }
              size="lg"
            >
              {building ? "Preparing transaction…" : "Prepare transaction"}
            </Button>
          </div>

          {buildError ? (
            <ClaimErrorBlock error={buildError} context="build" />
          ) : null}
        </div>
      )}

      {/* ---- Step 3: sign the PSBT ---- */}
      {build && !broadcast && (
        <div className="mt-10">
          <p className="text-xs uppercase tracking-wider text-dim">Step 3</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Sign it in your wallet
          </h2>
          <p className="mt-2 text-sm text-soft">
            We've prepared an unsigned transaction. GhostKey can't sign it for
            you. This claim spends a Bitcoin timelock, so it needs a wallet
            that can sign Taproot scripts. Many phone wallets can't. Bitcoin
            Core is the one we've tested. If the wallet that holds your key can
            open and sign this, that works too. Sign it there, then paste the
            signed transaction back.
          </p>

          <PsbtSummary build={build} />

          <div className="mt-5">
            <p className="text-xs uppercase tracking-wider text-dim">
              Unsigned transaction
            </p>
            <p className="mt-1 text-xs text-muted">
              This long block of letters and numbers is just your transaction
              written out as text (its technical name is a "PSBT"). Nothing here
              can spend your money on its own. It still has to be signed. It's
              safe to copy.
            </p>
            <textarea
              readOnly
              value={build.psbt_b64}
              rows={6}
              className="textarea mt-2 font-mono text-[11px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={() => void onCopyPsbt()} variant="ghost">
                {copied ? "Copied" : "Copy"}
              </Button>
              <span className="text-xs text-muted">
                Open the wallet that holds your key, find its transaction
                signer (sometimes called "sign PSBT"), paste this in, and sign.
              </span>
            </div>
          </div>

          <div className="mt-8">
            <Field
              label="Signed transaction"
              hint="Paste back what your wallet gives you after signing."
            >
              <textarea
                rows={6}
                value={signedPsbt}
                onChange={(e) => setSignedPsbt(e.target.value)}
                placeholder="cHNidP8BA..."
                spellCheck={false}
                autoComplete="off"
                className="textarea font-mono text-[11px]"
                disabled={broadcasting}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => void onBroadcast()}
              disabled={signedPsbt.trim().length === 0 || broadcasting}
              size="lg"
            >
              {broadcasting ? "Broadcasting…" : "Broadcast transaction"}
            </Button>
          </div>

          {broadcastError ? (
            <ClaimErrorBlock error={broadcastError} context="broadcast" />
          ) : null}
        </div>
      )}

      {/* ---- Done ---- */}
      {broadcast && <BroadcastSuccess result={broadcast} />}
    </section>
  );
}

function PsbtSummary({ build }: { build: BuildClaimPsbtResponse }) {
  return (
    <div className="mt-5 card-flat p-4">
      <p className="text-xs uppercase tracking-wider text-dim">
        Transaction summary
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm">
        <Row k="Amount being moved" v={`${formatSats(build.total_input_sats)} sats`} />
        <Row k="You'll receive" v={`${formatSats(build.output_sats)} sats`} />
        <Row k="Network fee" v={`${formatSats(build.fee_sats)} sats`} />
        <Row k="Network" v={build.network} />
      </dl>
      <p className="mt-3 text-xs text-muted">
        Double-check these numbers in your wallet before signing. If the
        amount or destination looks wrong, don't sign. Come back and start
        again.
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono text-[var(--text)]">{v}</dd>
    </div>
  );
}

function BroadcastSuccess({ result }: { result: BroadcastClaimResponse }) {
  return (
    <div className="mt-10">
      <p className="text-xs uppercase tracking-wider text-dim">Done</p>
      <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
        It's on the network
      </h2>
      <p className="mt-2 text-sm text-soft">
        Your transaction has been broadcast. Bitcoin transactions usually
        confirm within an hour, sometimes faster. Once it's confirmed, the
        funds are yours.
      </p>

      <div className="mt-5 card-flat p-4">
        <p className="text-xs uppercase tracking-wider text-dim">
          Transaction ID
        </p>
        <p className="mt-2 break-all font-mono text-xs text-[var(--text)]">
          {result.txid}
        </p>
        <div className="mt-4">
          <a
            href={result.explorer_url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-display text-sm font-bold tracking-tight text-accent underline underline-offset-2"
          >
            Watch it confirm on mempool.space ↗
          </a>
        </div>
      </div>

      <p className="mt-6 text-xs text-muted">
        You don't need to keep this page open. The transaction is on the
        Bitcoin network and will confirm on its own.
      </p>
    </div>
  );
}

/* ----------------------------- Wallet guide -------------------------------- */

interface WalletRec {
  name: string;
  blurb: string;
  url: string;
  note: string;
}

const WALLETS_MAINNET: WalletRec[] = [
  {
    name: "Blink",
    blurb: "Free. Popular in Nigeria. Works without ID.",
    url: "https://blink.sv/",
    note: "Tap Receive → Bitcoin → copy the address.",
  },
  {
    name: "Wallet of Satoshi",
    blurb: "Free. Works on any phone. No setup.",
    url: "https://www.walletofsatoshi.com/",
    note: "Tap Receive → On-chain → copy the address.",
  },
  {
    name: "Cake Wallet",
    blurb: "Free. You hold your own keys.",
    url: "https://cakewallet.com/",
    note: "Tap the QR icon top-right → copy the address.",
  },
  {
    name: "Sparrow",
    blurb: "Desktop. Power user. Hardware wallet support.",
    url: "https://sparrowwallet.com/",
    note: "File → New Wallet → Receive tab → copy the address.",
  },
];

// Non-mainnet wallets. Most consumer Lightning wallets (Blink, Wallet
// of Satoshi, Phoenix) are mainnet-only and would silently reject
// signet/testnet addresses, so we surface a smaller list of wallets
// that actually support test networks. Reused for both signet and
// testnet (same address prefix `tb1`, same wallet behaviour).
const WALLETS_TEST: WalletRec[] = [
  {
    name: "Sparrow",
    blurb: "Desktop. Switch network to Signet/Testnet at first launch.",
    url: "https://sparrowwallet.com/",
    note: "File → New Wallet → set Server type to Signet/Testnet → Receive tab → copy the address.",
  },
  {
    name: "Mutiny Wallet",
    blurb: "Web wallet. Built for signet. No install.",
    url: "https://signet.mutinywallet.com/",
    note: "Open the link → Receive → copy the tb1q… address.",
  },
  {
    name: "BlueWallet",
    blurb: "Mobile. Long-press the + button when adding to pick Testnet.",
    url: "https://bluewallet.io/",
    note: "Add wallet → long-press Plus → Testnet → Receive → copy the address.",
  },
];

function walletsFor(network: string): WalletRec[] {
  return network === "bitcoin" ? WALLETS_MAINNET : WALLETS_TEST;
}

/** Short human label for the network, used inline in copy. */
function networkLabel(network: string): string {
  return network === "bitcoin" ? "Bitcoin network" : `${network} network`;
}

/** A handful of wallet names, comma-separated, for inline copy.
 *  Avoids hard-coding mainnet-only names when the vault is on a
 *  test network. */
function walletExamplesInline(network: string): string {
  return walletsFor(network)
    .map((w) => w.name)
    .join(", ");
}

/**
 * `requirePsbt` filters the wallet list down to ones that can sign
 * PSBTs. Set to `true` on the legacy ManualPsbtClaim flow (where the
 * heir has to sign a base64 PSBT in their wallet), `false` on the
 * password-vault flow (where the heir only needs to receive).
 */
function WalletGuide({
  network,
  requirePsbt = false,
}: {
  network: string;
  requirePsbt?: boolean;
}) {
  // The PSBT-signing path can't honestly recommend phone wallets: the
  // heir branch is a Taproot timelock script, and the wallets we'd list
  // for receiving can't satisfy it (the restore drill confirmed Sparrow
  // and Liana refuse our descriptor). Point at the one signer we've
  // tested instead of promising a wallet that will dead-end the claim.
  if (requirePsbt) {
    return (
      <div className="mt-5 card-flat p-5">
        <p className="text-sm text-body">
          Signing this claim needs a wallet that can sign Bitcoin Taproot
          timelock scripts. Most phone wallets can't. The one we've tested is
          Bitcoin Core, on a desktop computer.
        </p>
        <a
          href="https://bitcoincore.org/en/download/"
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-block font-display text-base font-bold tracking-tight text-[var(--text)] underline-offset-2 hover:underline"
        >
          Download Bitcoin Core
          <span className="ml-1 text-xs text-dim">↗</span>
        </a>
        <p className="mt-2 text-xs text-soft">
          Open the transaction below in Bitcoin Core, sign it, and paste the
          signed version back here.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 card-flat p-5">
      <p className="text-sm text-body">
        Pick any of these. Download it on your phone, open it, and follow the
        steps inside.
      </p>
      <ul role="list" className="mt-4 space-y-3">
        {walletsFor(network).map((w) => (
          <li key={w.name} className="flex flex-col gap-1">
            <a
              href={w.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-display text-base font-bold tracking-tight text-[var(--text)] underline-offset-2 hover:underline"
            >
              {w.name}
              <span className="ml-1 text-xs text-dim">↗</span>
            </a>
            <span className="text-xs text-muted">{w.blurb}</span>
            <span className="text-xs text-soft">{w.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------ Heir recovery file (block B) -------------------------- */

/**
 * Optional, secondary action on the claim page: download a
 * self-contained recovery file the heir can use to reach the Bitcoin
 * without GhostKey — the same offline-signing kit the owner gets,
 * built for the heir branch.
 *
 * Why offer it here? Two reasons. (1) Independence from this moment on:
 * once they hold the file plus its code, GhostKey going away never
 * strands them. (2) Self-serve fallback: if the one-shot send above
 * ever fails (Esplora down, etc.), they can open the file and move the
 * money themselves.
 *
 * The heir's xprv is re-derived on click (cheap — HKDF or BIP39, no
 * Argon2), sealed under an auto-generated code inside
 * `buildHeirEnvelope`, and dropped immediately after. We never hold it
 * in component state.
 */
function HeirRecoveryFileSection({
  vaultId,
  network,
  timelockBlocks,
  descriptorExternal,
  descriptorInternal,
  heirName,
  deriveXprv,
}: {
  vaultId: string;
  network: string;
  timelockBlocks: number;
  descriptorExternal: string;
  descriptorInternal: string;
  heirName: string;
  deriveXprv: () => string;
}) {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "building" }
    | { kind: "ready"; env: HeirEnvelope }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Descriptors are required to build the file; on older servers that
  // don't return them yet, just hide the section rather than error.
  if (!descriptorExternal || !descriptorInternal) return null;

  async function onCreate() {
    setStatus({ kind: "building" });
    let xprv: string | null = null;
    try {
      xprv = deriveXprv();
      const env = await buildHeirEnvelope({
        vaultId,
        label: heirName ? `${heirName}'s inheritance` : null,
        network,
        timelockBlocks,
        descriptorExternal,
        descriptorInternal,
        heirName,
        heirXprv: xprv,
      });
      setStatus({ kind: "ready", env });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      xprv = null;
    }
  }

  return (
    <details className="mt-10">
      <summary className="cursor-pointer text-sm text-muted">
        Advanced: save your own recovery file
      </summary>
      <div className="mt-3 card-flat p-5">
        <p className="text-sm text-soft">
          This downloads a file that can reach this Bitcoin{" "}
          <strong>without GhostKey</strong>, using just a code we'll show
          you. You don't need it to receive the money above. It's a
          backup, and a way to do it yourself if you ever want to.
        </p>

        {status.kind === "idle" && (
          <div className="mt-4">
            <Button variant="ghost" onClick={() => void onCreate()}>
              Create my recovery file
            </Button>
          </div>
        )}

        {status.kind === "building" && (
          <p className="mt-4 text-sm text-muted" aria-live="polite">
            Preparing your file… this takes a few seconds.
          </p>
        )}

        {status.kind === "error" && (
          <div className="mt-4">
            <InlineAlert tone="alarm">
              <p className="text-sm">Couldn't build the file: {status.message}</p>
            </InlineAlert>
            <div className="mt-3">
              <Button variant="ghost" onClick={() => void onCreate()}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {status.kind === "ready" && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wider text-dim">
              Your code, write it down
            </p>
            <code className="mt-2 inline-block select-all rounded bg-[var(--bg-elev)] px-3 py-2 font-mono text-sm">
              {status.env.passphrase}
            </code>
            <p className="mt-3 text-sm text-muted">
              The file is locked with this code. We won't show it again,
              and we never store it. Keep the file and the code together.
            </p>
            <div className="mt-4">
              <Button onClick={() => downloadHeirEnvelope(status.env)}>
                Download the file
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

/* ----------------------------- Footer ------------------------------------- */

function ClaimFooter() {
  return (
    <footer className="mt-16 border-t border-app">
      <div className="mx-auto max-w-xl px-5 py-6 text-center text-xs text-dim md:px-8">
        <p>
          This page is from GhostKey, a Bitcoin inheritance service. The link
          you opened was sent to you because someone you knew set up an
          inheritance and named your phone or email.
        </p>
      </div>
    </footer>
  );
}

/* -------------------------- Helpers --------------------------------------- */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] uppercase tracking-[0.16em] font-bold text-accent">
      {children}
    </p>
  );
}

/**
 * Loose client-side Bitcoin address check. We accept anything that
 * smells right (bech32 / base58) and let the eventual signing path do
 * the real validation. This is just to gate the "Prepare transaction"
 * button — the server re-validates against the vault's network.
 */
/**
 * Parse the optional fee-rate field. Returns null when:
 *   - the field is non-empty but doesn't parse as an integer, or
 *   - the parsed value is out of the 1..=1000 sat/vB range we'll honour.
 * Returns `undefined` when the field is blank (the server defaults to
 * 2 sat/vB).
 *
 * Capping at 1000 is a soft sanity bound; mainnet fee rates above a
 * few hundred sat/vB are almost always typos.
 */
function parseFeeRate(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  return n;
}

/**
 * Format a sat count with thousands separators. We pick the locale
 * from the browser so this works in en-NG, en-US, fr-FR, etc. without
 * any extra plumbing.
 */
/** Shows the vault's current value (sats · BTC · ≈ $USD) inside the
 *  "what's being passed on" card, so the heir sees roughly what they're
 *  about to receive. Balance is public on-chain info; renders nothing
 *  while loading, empty, or if the lookup fails. */
function VaultValueLine({ vaultId }: { vaultId: string }) {
  const [balance, setBalance] = useState<VaultBalanceView | null>(null);
  const usdPerBtc = usePrice();
  useEffect(() => {
    let cancelled = false;
    api
      .getVaultBalance(vaultId)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        /* balance is a nicety here; hide on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId]);
  if (!balance || balance.total_sat <= 0) return null;
  return (
    <p className="mt-2 text-sm text-soft">
      {formatSats(balance.total_sat)} sat · {btcAndUsd(balance.total_sat, usdPerBtc)}
    </p>
  );
}

function formatSats(n: number): string {
  return n.toLocaleString();
}
