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
 *   - on the claimable path, walks the heir through getting a wallet
 *     (if they don't have one), capturing a Bitcoin address, asking the
 *     server to build an unsigned PSBT that drains the vault on the
 *     timelock branch, and broadcasting it once the heir signs.
 *
 * Why we hand the heir a base64 PSBT instead of signing in-browser:
 *   The signature has to come from the heir's wallet (Sparrow, Coldcard,
 *   etc.). GhostKey never holds keys. We give the heir a string to copy
 *   into their wallet's PSBT signer, then accept the signed string back.
 *
 * What the page does NOT do:
 *   - hold keys, sign for the heir, or co-sign anything
 *   - hide failure modes: if /build-psbt or /broadcast fails (no UTXOs,
 *     Esplora down, timelock not yet mined, etc.) we surface the
 *     server's error message verbatim so a Bitcoin-literate helper
 *     can debug it
 *
 * The whole page intentionally bypasses the GhostKey navbar — the heir
 * shouldn't see "Set up" / "Dashboard" / "Check in" controls that don't
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
} from "./api";
import { countdown, parseRfc } from "./time";

type State =
  | { kind: "loading" }
  | { kind: "ok"; view: ClaimView }
  | { kind: "not-found" }
  | { kind: "used" }
  | { kind: "error"; message: string };

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
        setState({ kind: "error", message: e.message });
        return;
      }
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
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
          <ErrorState message={state.message} onRetry={load} />
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
        <span className="font-display text-lg font-bold tracking-tight">
          Ghost<span className="text-accent">Key</span>
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
        you, you're done. If you haven't, contact the person who set this up —
        they can issue a new link.
      </p>
    </section>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="text-center">
      <Eyebrow>Something went wrong</Eyebrow>
      <h1 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        We couldn't open your link
      </h1>
      <p className="mt-4 text-muted">Try again in a moment.</p>
      <p className="mt-1 font-mono text-xs text-dim">{message}</p>
      <div className="mt-6">
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </section>
  );
}

/* ----------------------------- Resolved ----------------------------------- */

function Resolved({ view, token }: { view: ClaimView; token: string }) {
  // Decide which sub-flow to show based on vault status.
  switch (view.status) {
    case "ok":
    case "warning":
      // Someone issued a claim link prematurely (owner is still active).
      // This is rare but possible if an operator runs issue-claim manually.
      return <NotReadyState view={view} />;
    case "alarmed":
    case "timelock_started":
      return <ClaimableState view={view} token={token} />;
    case "claimed":
      return <AlreadyClaimedState view={view} />;
  }
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
 * The happy path. The heir has the link, the timer has run, the funds
 * can be moved. We walk them through:
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
function ClaimableState({
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
  const [buildError, setBuildError] = useState<string | null>(null);

  /** Broadcast phase. */
  const [signedPsbt, setSignedPsbt] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcast, setBroadcast] = useState<BroadcastClaimResponse | null>(
    null,
  );
  const [broadcastError, setBroadcastError] = useState<string | null>(null);

  /** "Copied!" feedback for the base64 PSBT block. */
  const [copied, setCopied] = useState(false);

  const heir = view.heir_display_name?.trim() || "you";
  const validAddr = looksLikeBitcoinAddress(address);
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
      setBuildError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
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
      setBroadcastError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
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
        <p className="text-[11px] uppercase tracking-wider text-dim">
          What's being passed on
        </p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">
          {view.label || "A Bitcoin inheritance"}
        </p>
        <p className="mt-1 text-xs text-muted">
          On the {view.network === "bitcoin" ? "Bitcoin network" : `${view.network} network`}.
        </p>
      </div>

      {/* ---- Step 1: do you have a Bitcoin wallet? ---- */}
      <div className="mt-10">
        <p className="text-[11px] uppercase tracking-wider text-dim">Step 1</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
          Do you have a Bitcoin wallet?
        </h2>
        <p className="mt-2 text-sm text-soft">
          A Bitcoin wallet is an app where you can receive and hold Bitcoin.
          For this claim you'll need one that can <em>sign a PSBT</em> — most
          self-custody wallets can (Sparrow on desktop, BlueWallet, Nunchuk,
          Coldcard). Custodial wallets like Wallet of Satoshi cannot.
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

        {hasWallet === false && <WalletGuide />}
      </div>

      {/* ---- Step 2: paste address + (optional) fee rate ---- */}
      {hasWallet !== null && (
        <div className="mt-10">
          <p className="text-[11px] uppercase tracking-wider text-dim">Step 2</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Where should the Bitcoin go?
          </h2>
          <p className="mt-2 text-sm text-soft">
            Open your wallet. Tap <strong>Receive</strong>. Copy the long
            address that starts with <code className="font-mono">bc1</code> or{" "}
            <code className="font-mono">3</code>. Paste it below.
          </p>

          <div className="mt-4">
            <Field
              label="Your Bitcoin address"
              hint={
                address && !validAddr
                  ? "That doesn't look like a Bitcoin address. Check the start."
                  : undefined
              }
            >
              <textarea
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="bc1q..."
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

          {buildError && (
            <div className="mt-4">
              <InlineAlert tone="alarm">
                We couldn't prepare the transaction. The server said:{" "}
                <span className="font-mono text-xs">{buildError}</span>
                <br />
                <span className="text-xs text-muted">
                  Common causes: the timelock hasn't been mined yet, no funds
                  are visible at the vault addresses, or the chain indexer is
                  unreachable. Show this message to someone who knows Bitcoin.
                </span>
              </InlineAlert>
            </div>
          )}
        </div>
      )}

      {/* ---- Step 3: sign the PSBT ---- */}
      {build && !broadcast && (
        <div className="mt-10">
          <p className="text-[11px] uppercase tracking-wider text-dim">Step 3</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Sign it in your wallet
          </h2>
          <p className="mt-2 text-sm text-soft">
            We've prepared an unsigned transaction. GhostKey can't sign for
            you — only your wallet can. Copy the text below into your wallet's
            PSBT signer, sign it, then paste the result back here.
          </p>

          <PsbtSummary build={build} />

          <div className="mt-5">
            <p className="text-[11px] uppercase tracking-wider text-dim">
              Unsigned PSBT (base64)
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
                {copied ? "Copied" : "Copy PSBT"}
              </Button>
              <span className="text-xs text-muted">
                In Sparrow: File → Open Transaction → paste, then Sign.
              </span>
            </div>
          </div>

          <div className="mt-8">
            <Field
              label="Signed PSBT (base64)"
              hint="Paste what your wallet gives you after signing."
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

          {broadcastError && (
            <div className="mt-4">
              <InlineAlert tone="alarm">
                Broadcast failed. The server said:{" "}
                <span className="font-mono text-xs">{broadcastError}</span>
                <br />
                <span className="text-xs text-muted">
                  Likely causes: the PSBT wasn't fully signed, the signature
                  didn't satisfy the timelock branch, or the network rejected
                  the transaction. Your link is still valid — fix the signed
                  PSBT and try again.
                </span>
              </InlineAlert>
            </div>
          )}
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
      <p className="text-[11px] uppercase tracking-wider text-dim">
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
        amount or destination looks wrong, don't sign — come back and start
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
      <p className="text-[11px] uppercase tracking-wider text-dim">Done</p>
      <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
        It's on the network
      </h2>
      <p className="mt-2 text-sm text-soft">
        Your transaction has been broadcast. Bitcoin transactions usually
        confirm within an hour, sometimes faster. Once it's confirmed, the
        funds are yours.
      </p>

      <div className="mt-5 card-flat p-4">
        <p className="text-[11px] uppercase tracking-wider text-dim">
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

const WALLETS: WalletRec[] = [
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
];

function WalletGuide() {
  return (
    <div className="mt-5 card-flat p-5">
      <p className="text-sm text-body">
        Pick any of these. Download it on your phone, open it, and follow the
        steps inside.
      </p>
      <ul role="list" className="mt-4 space-y-3">
        {WALLETS.map((w) => (
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
function looksLikeBitcoinAddress(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // Bech32 mainnet / testnet / signet / regtest.
  if (/^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{20,}$/i.test(t)) return true;
  // Base58 P2PKH / P2SH (mainnet starts with 1 or 3, testnet 2 / m / n).
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{20,}$/.test(t)) return true;
  return false;
}

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
function formatSats(n: number): string {
  return n.toLocaleString();
}
