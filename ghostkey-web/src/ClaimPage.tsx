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
 *     (if they don't have one) and capturing a Bitcoin address
 *
 * What the page does NOT do:
 *   - sign or broadcast a claim transaction. That requires the heir to
 *     sign with a private key derived from the xpub the owner registered
 *     at setup, which is a separate sprint involving PSBT generation.
 *     For now we honestly tell the heir "this is your address, your link
 *     stays valid, contact [owner] or anyone who knows Bitcoin to
 *     receive the funds".
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
import { ApiError, api, type ClaimView } from "./api";
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
        {state.kind === "ok" && <Resolved view={state.view} />}
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

function Resolved({ view }: { view: ClaimView }) {
  // Decide which sub-flow to show based on vault status.
  switch (view.status) {
    case "ok":
    case "warning":
      // Someone issued a claim link prematurely (owner is still active).
      // This is rare but possible if an operator runs issue-claim manually.
      return <NotReadyState view={view} />;
    case "alarmed":
    case "timelock_started":
      return <ClaimableState view={view} />;
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
 * can be moved. We capture an address from them and explain how the
 * actual transfer happens. The transfer itself doesn't happen on this
 * page yet — see top-of-file note.
 */
function ClaimableState({ view }: { view: ClaimView }) {
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [address, setAddress] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const heir = view.heir_display_name?.trim() || "you";
  const owner = "the person who set this up";
  const validAddr = looksLikeBitcoinAddress(address);

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
          A Bitcoin wallet is an app on your phone where you can receive and
          hold Bitcoin. You don't need an account or ID for most of them.
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

      {/* ---- Step 2: paste address ---- */}
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
              />
            </Field>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => setSubmitted(true)}
              disabled={!validAddr}
              size="lg"
            >
              I'm ready
            </Button>
          </div>
        </div>
      )}

      {/* ---- Step 3: honest end-state ----
          We don't actually broadcast the claim transaction yet (PSBT
          signing flow is a separate sprint). Tell the heir exactly
          what's missing and what they can do. */}
      {submitted && (
        <div className="mt-10">
          <p className="text-[11px] uppercase tracking-wider text-dim">Step 3</p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Almost there
          </h2>
          <div className="mt-3">
            <InlineAlert tone="warning">
              We've saved your address. Receiving Bitcoin from an inheritance
              vault needs one more step that GhostKey can't do from this page
              yet — broadcasting a Bitcoin transaction that was prepared for
              you.
            </InlineAlert>
          </div>
          <ol className="mt-5 list-decimal space-y-3 pl-5 text-sm text-body">
            <li>
              <strong>Show this page to {owner}</strong>, or to anyone you
              trust who knows Bitcoin. They can complete the transfer in a few
              minutes.
            </li>
            <li>
              Or write down this link and keep it safe. The link stays valid
              until you, or someone helping you, completes the transfer.
            </li>
          </ol>

          <div className="mt-6 card-flat p-4 text-xs text-muted">
            <p className="text-[11px] uppercase tracking-wider text-dim">
              Your address (saved)
            </p>
            <p className="mt-2 break-all font-mono text-[12px] text-[var(--text)]">
              {address.trim()}
            </p>
          </div>
        </div>
      )}
    </section>
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
 * the real validation. This is just to gate the "I'm ready" button.
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
