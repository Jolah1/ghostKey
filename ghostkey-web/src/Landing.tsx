/**
 * Landing page.
 *
 * Sections (top to bottom):
 *   1. Hero            — headline, CTA, trust row
 *   2. How it works    — 4 numbered steps, plus the always-in-control note
 *   3. Why Bitcoin     — 3 reason cards
 *   4. Comparison      — small table positioning GhostKey vs alternatives
 *   5. FAQ             — accordion of common questions
 *   6. Final CTA       — one-liner + buttons
 *   7. Footer          — sitemap + legal disclaimer
 *
 * Style: Inter Tight headings with the silver-gradient title fill and
 * the orange accent picked out on the punchline word. Tando-inspired.
 * Tone: emotional, no jargon, no AI tells.
 */
import { useState } from "react";
import { Disclosure, Eyebrow } from "./ui";
import { useVocab } from "./vocab";
import type { Route } from "./App";
import { ApiError, api } from "./api";
import { useTrackInView } from "./useTrackInView";

interface Props {
  onNavigate: (r: Route) => void;
}

export function Landing({ onNavigate }: Props) {
  return (
    <main>
      <Hero onNavigate={onNavigate} />
      <HowItWorks onNavigate={onNavigate} />
      <WhyBitcoin />
      <Comparison />
      <FAQ />
      <FinalCTA onNavigate={onNavigate} />
      <Footer />
    </main>
  );
}

/* --------------------------------- Hero ----------------------------------- */

function Hero({ onNavigate }: Props) {
  const ref = useTrackInView("landing.section_viewed", "hero");
  const vocab = useVocab();
  return (
    <section ref={ref} className="relative overflow-hidden hero-glow">
      {/* Mobile padding was `px-5 py-20` (1.25rem / 5rem). On a 360px
          phone py-20 is 160px of vertical dead space before content.
          Drop to py-12 (3rem = 48px) at base so the hero is visible
          on first paint without scroll. md: keeps the generous
          desktop spacing. */}
      <div className="mx-auto flex max-w-5xl flex-col items-center px-5 py-12 text-center md:px-8 md:py-28">
        <Eyebrow>Bitcoin inheritance, without the lawyers</Eyebrow>

        {/* Hero clamp floor was 44px which forces "lives on after you"
            (~21ch) onto a single line of ~510px — wider than a 360px
            phone, so the browser breaks awkwardly mid-word with the
            title-gradient running through the break. 32px floor at
            base keeps the line on two lines cleanly. The 7vw target
            and 96px ceiling are unchanged. */}
        <h1 className="word-in mt-7 max-w-3xl font-display text-[clamp(32px,7vw,96px)] font-bold leading-[1.04] tracking-tight">
          <span className="title-gradient">Your </span>
          <span className="text-accent">Bitcoin</span>
          <br />
          <span className="title-gradient">lives on after you</span>
        </h1>

        <p className="mt-6 max-w-xl text-base text-body md:mt-8 md:text-xl">
          {vocab.longTagline}
        </p>

        <div className="mt-8 flex w-full max-w-sm flex-col gap-3 md:mt-10 md:w-auto md:max-w-none md:flex-row md:flex-wrap md:items-center md:justify-center">
          {/* Mobile-first: buttons stack full-width so the primary CTA
              is a fat tap target instead of two cramped pills. md:
              restores the horizontal pair. */}
          <button
            type="button"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "hero_setup");
              onNavigate("setup");
            }}
            className="btn btn-primary"
          >
            Set up your vault
            <ArrowRight />
          </button>
          <button
            type="button"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "hero_inherit");
              onNavigate("inherit");
            }}
            className="btn btn-ghost"
          >
            I was named to inherit
          </button>
        </div>

        <p className="mt-5 text-xs text-muted">
          Free and open source. No subscription. You only pay tiny network fees
          in sats and your own check-ins.
        </p>

        <TrustRow />
      </div>
    </section>
  );
}

function TrustRow() {
  const items = [
    { strong: "0",        sub: "Third parties" },
    { strong: "Your key", sub: "Locked by your password" },
    { strong: "On-chain", sub: "No company can freeze it" },
  ];
  return (
    <ul
      role="list"
      className="mt-20 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 text-center"
    >
      {items.map((it) => (
        <li key={it.sub} className="flex flex-col items-center gap-1">
          <span className="font-display text-3xl font-bold tracking-tight title-gradient">{it.strong}</span>
          <span className="text-xs uppercase tracking-wider text-muted">
            {it.sub}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------- How it works ------------------------------- */

interface Step {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "You set up your vault",
    body: "Connect a Bitcoin wallet and choose who inherits. About five minutes. No documents, no lawyers, nothing technical to install.",
  },
  {
    title: "You tap once a month",
    body: "That's the whole job. One tap says you're still here and resets the clock. Miss it for long enough and the countdown begins.",
  },
  {
    title: "Your people get what you left them",
    body: "When the time comes, the person you named gets a notification. They claim it themselves, from anywhere, without asking anyone's permission.",
  },
  {
    title: "The rules live on Bitcoin, not on us",
    body: "Your plan is written into Bitcoin itself, so the rules can't be blocked, deleted, or rewritten, not even by us. The timelock means nothing moves before your waiting period is over. GhostKey just keeps it running: reminders for you, a guided claim for them.",
  },
];

function HowItWorks({ onNavigate }: Props) {
  const ref = useTrackInView("landing.section_viewed", "how_it_works");
  return (
    <section ref={ref} id="how" className="border-t border-app bg-app">
      <div className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-28">
        <Eyebrow dim>How it works</Eyebrow>

        <ol className="mt-12 space-y-0">
          {STEPS.map((s, i) => {
            const last = i === STEPS.length - 1;
            return (
              <li key={s.title} className="relative grid grid-cols-[48px_1fr] gap-x-6 gap-y-2">
                {!last && (
                  <span
                    aria-hidden="true"
                    className="absolute left-6 top-12 bottom-0 w-px -translate-x-1/2 bg-[var(--border-hi)]"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="relative z-[1] flex h-12 w-12 items-center justify-center rounded-full bg-surface font-display text-lg font-bold text-accent"
                  style={{ border: "1px solid var(--border-hi)" }}
                >
                  {i + 1}
                </span>
                <div className="pb-12 pt-2">
                  <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">{s.title}</h2>
                  <p className="mt-2 max-w-prose text-base text-soft md:text-lg">
                    {s.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        <aside
          className="mb-12 flex items-start gap-4 rounded-2xl border border-app p-5"
          style={{ background: "var(--accent-tint)" }}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
            style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
          >
            <ShieldIcon />
          </span>
          <div>
            <p className="font-display text-xl font-bold tracking-tight">Always in control</p>
            <p className="mt-1 text-sm text-soft">
              You can reclaim everything at any moment before the heir claims.
              No approvals, no waiting. It's still your Bitcoin.
            </p>
          </div>
        </aside>

        <div className="flex justify-start">
          <button
            type="button"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "how_it_works_setup");
              onNavigate("setup");
            }}
            className="btn btn-primary"
          >
            Set up your vault
            <ArrowRight />
          </button>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- Why Bitcoin -------------------------------- */

interface Reason {
  tag: string;
  title: string;
  body: string;
}

const REASONS: Reason[] = [
  {
    tag: "Hardened",
    title: "Fifteen years live",
    body: "Bitcoin has settled trillions of dollars in value without a single protocol-level failure. The base layer your inheritance sits on is the most battle-tested ledger in the world.",
  },
  {
    tag: "Precise",
    title: "On-chain timelocks",
    body: "Waiting periods are enforced by Bitcoin itself. Once set, no one can move the funds to your heir before the timer runs out. Not us, not them, not anyone.",
  },
  {
    tag: "Trustless",
    title: "Self-custodied keys",
    body: "Your own key never sits on our servers, so no one can move your Bitcoin while you keep checking in. For the strictest setup, give your heir their own key too, and GhostKey holds nothing that can spend it.",
  },
];

function WhyBitcoin() {
  const ref = useTrackInView("landing.section_viewed", "why_bitcoin");
  return (
    <section ref={ref} className="border-t border-app bg-app">
      <div className="mx-auto max-w-5xl px-5 py-14 md:px-8 md:py-28">
        <div className="max-w-2xl">
          <Eyebrow dim>For the technically curious</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            <span className="title-gradient">Built on the chain that </span>
            <span className="text-accent">doesn't break</span>
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {REASONS.map((r) => (
            <article key={r.title} className="card-flat p-6">
              <p className="eyebrow-tag text-[10px]">{r.tag}</p>
              <h3 className="mt-3 font-display text-xl font-bold leading-tight tracking-tight">{r.title}</h3>
              <p className="mt-2 text-sm text-soft leading-relaxed">{r.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Comparison -------------------------------- */

interface CompRow {
  name: string;
  heirNoSetup:    "yes" | "partial" | "no";
  nonTechHeir:    "yes" | "partial" | "no";
  noCosigner:     "yes" | "partial" | "no";
  onChainLock:    "yes" | "partial" | "no";
  highlight?:     boolean;
}

const COMP: CompRow[] = [
  { name: "Seed phrase in a safe",   heirNoSetup: "no",  nonTechHeir: "no",      noCosigner: "yes", onChainLock: "no"      },
  { name: "Nunchuk inheritance",     heirNoSetup: "no",  nonTechHeir: "partial", noCosigner: "no",  onChainLock: "partial" },
  { name: "AnchorWatch",             heirNoSetup: "no",  nonTechHeir: "no",      noCosigner: "no",  onChainLock: "yes"     },
  { name: "Liana",                   heirNoSetup: "no",  nonTechHeir: "no",      noCosigner: "yes", onChainLock: "yes"     },
  { name: "GhostKey",                heirNoSetup: "yes", nonTechHeir: "yes",     noCosigner: "yes", onChainLock: "yes", highlight: true },
];

function Comparison() {
  const ref = useTrackInView("landing.section_viewed", "comparison");
  return (
    <section ref={ref} className="border-t border-app bg-app">
      <div className="mx-auto max-w-5xl px-5 py-14 md:px-8 md:py-28">
        <div className="max-w-2xl">
          <Eyebrow dim>Comparison</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            <span className="title-gradient">How GhostKey </span>
            <span className="text-accent">compares</span>
          </h2>
        </div>

        {/* Two renderings of the same data:
            - Mobile (`<md`): stacked cards. Each row becomes one
              card with a heading and a 3-column mini-table inside.
              No horizontal scroll, no `min-w` escape hatch needed.
            - Desktop (`md:` and up): the comparison table. Wider
              than mobile can fit, but we never show it there.
            Mirroring data is fine — five rows; the data shape
            (`COMP`) is the single source of truth above. */}
        <div className="mt-10 grid gap-3 md:hidden">
          {COMP.map((row) => (
            <div
              key={row.name}
              className={`card-flat p-4 ${row.highlight ? "border-accent" : ""}`}
              style={row.highlight ? { background: "var(--accent-tint)" } : undefined}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{row.name}</span>
                {row.highlight && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
                    style={{
                      background: "var(--accent)",
                      color: "var(--text-on-accent)",
                    }}
                  >
                    Best
                  </span>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="flex flex-col items-start gap-1">
                  <dt className="text-dim">No heir setup</dt>
                  <dd><Mark v={row.heirNoSetup} /></dd>
                </div>
                <div className="flex flex-col items-start gap-1">
                  <dt className="text-dim">Non-technical heir</dt>
                  <dd><Mark v={row.nonTechHeir} /></dd>
                </div>
                <div className="flex flex-col items-start gap-1">
                  <dt className="text-dim">No third-party key</dt>
                  <dd><Mark v={row.noCosigner} /></dd>
                </div>
                <div className="flex flex-col items-start gap-1">
                  <dt className="text-dim">On-chain timelock</dt>
                  <dd><Mark v={row.onChainLock} /></dd>
                </div>
              </dl>
            </div>
          ))}
        </div>

        <div className="mt-12 hidden md:block">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-dim">
                <th scope="col" className="py-3 pr-4 font-medium">Solution</th>
                <th scope="col" className="py-3 px-4 font-medium">No heir setup</th>
                <th scope="col" className="py-3 px-4 font-medium">Non-technical heir</th>
                <th scope="col" className="py-3 px-4 font-medium">No third-party key</th>
                <th scope="col" className="py-3 px-4 font-medium">On-chain timelock</th>
              </tr>
            </thead>
            <tbody>
              {COMP.map((row, i) => {
                const last = i === COMP.length - 1;
                return (
                  <tr
                    key={row.name}
                    className={
                      row.highlight
                        ? "relative"
                        : ""
                    }
                    style={
                      row.highlight
                        ? {
                            background: "var(--accent-tint)",
                          }
                        : undefined
                    }
                  >
                    <th
                      scope="row"
                      className={`border-t border-app py-4 pr-4 text-left font-medium ${last ? "rounded-bl-xl" : ""}`}
                    >
                      <span className="inline-flex items-center gap-2">
                        {row.name}
                        {row.highlight && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
                            style={{
                              background: "var(--accent)",
                              color: "var(--text-on-accent)",
                            }}
                          >
                            Best
                          </span>
                        )}
                      </span>
                    </th>
                    <td className="border-t border-app py-4 px-4">
                      <Mark v={row.heirNoSetup} />
                    </td>
                    <td className="border-t border-app py-4 px-4">
                      <Mark v={row.nonTechHeir} />
                    </td>
                    <td className="border-t border-app py-4 px-4">
                      <Mark v={row.noCosigner} />
                    </td>
                    <td className={`border-t border-app py-4 px-4 ${last && row.highlight ? "rounded-br-xl" : ""}`}>
                      <Mark v={row.onChainLock} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-6 text-xs text-dim">
          Comparisons reflect each project's public documentation at time of writing.
        </p>
      </div>
    </section>
  );
}

function Mark({ v }: { v: "yes" | "partial" | "no" }) {
  if (v === "yes") {
    return (
      <span className="inline-flex items-center gap-1.5 text-ok">
        <CheckIcon />
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (v === "partial") {
    return (
      <span className="inline-flex items-center gap-1.5 text-warning">
        <DotIcon />
        <span className="text-xs">Partial</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-dim">
      <DashIcon />
      <span className="sr-only">No</span>
    </span>
  );
}

/* ---------------------------------- FAQ ----------------------------------- */

const FAQS = [
  {
    q: "What happens if I lose access to my wallet?",
    a: "Treat the GhostKey vault like any other Bitcoin wallet and back up your seed phrase. If you lose both your wallet and your backup, no one can recover the funds. That includes us. This is the trade-off of true self-custody.",
  },
  {
    q: "Can I change my heir after creating a vault?",
    a: "You can add another heir at any time, each with their own share. To change who inherits an existing share, or to change its waiting period, send that share back to your own wallet from the dashboard (one transaction) and set up a fresh vault with the new details. While you keep checking in, nothing ever moves without you.",
  },
  {
    q: "What does a check-in cost?",
    a: "Nothing. The monthly tap is a web action that resets a timer on our reminder service. No transaction is broadcast and no Bitcoin moves.",
  },
  {
    q: "Are there fees?",
    a: "GhostKey takes no cut. You only pay the normal Bitcoin network fee when you fund the vault, and again when your heir claims.",
  },
  {
    q: "Can my heir claim early?",
    a: "No. The waiting period is locked into Bitcoin itself. Until it fully runs out, nobody can move the funds. Not your heir, not us.",
  },
  {
    q: "What kinds of Bitcoin can I deposit?",
    a: "Any Bitcoin you already hold. You send it from your wallet to your vault's own Bitcoin address, one whose rules already include your heir. We never hold it and can't spend it.",
  },
  {
    q: "Is this a legal will?",
    a: "No. GhostKey is a way to pass on Bitcoin you hold yourself. Most people use it alongside a normal will, which still covers their other things and the legal paperwork.",
  },
  {
    q: "Can I reclaim my Bitcoin after creating a vault?",
    a: "Always. Until your heir actually claims, you have full spending power over the funds with your own key. Emergency withdraw is one transaction away.",
  },
  {
    q: "What if GhostKey shuts down?",
    a: "Your heir can still claim. At setup you save two files: your own spare key, which opens with your password, and a file for your heir, which opens with a short code kept beside it. If GhostKey ever disappears, your heir opens their file and it walks them through claiming straight from the Bitcoin network, no GhostKey needed. Keep both with your important papers.",
  },
];

function FAQ() {
  const ref = useTrackInView("landing.section_viewed", "faq");
  return (
    <section ref={ref} className="border-t border-app bg-app">
      <div className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-28">
        <div className="text-center">
          <Eyebrow dim>FAQ</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            <span className="title-gradient">Common </span>
            <span className="text-accent">questions</span>
          </h2>
        </div>

        <div className="mt-12 space-y-3">
          {FAQS.map((item) => (
            <Disclosure
              key={item.q}
              summary={
                <span className="font-display text-base font-semibold text-[var(--text)] md:text-lg">
                  {item.q}
                </span>
              }
            >
              <p className="text-sm leading-relaxed text-muted md:text-base">
                {item.a}
              </p>
            </Disclosure>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Final CTA --------------------------------- */

function FinalCTA({ onNavigate }: Props) {
  const ref = useTrackInView("landing.section_viewed", "final_cta");
  return (
    <section ref={ref} className="border-t border-app bg-app">
      <div className="mx-auto max-w-3xl px-5 py-14 text-center md:px-8 md:py-28">
        <h2 className="font-display text-3xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          <span className="title-gradient">Don't let your Bitcoin </span>
          <span className="text-accent">die with you</span>
        </h2>
        <p className="mx-auto mt-4 max-w-md text-muted">
          Set up your vault in minutes. The people you named will thank you,
          even if they never have to use it.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "final_setup");
              onNavigate("setup");
            }}
            className="btn btn-primary"
          >
            Set up your vault
            <ArrowRight />
          </button>
          <button
            type="button"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "final_how");
              // Scroll to the on-page "How it works" section rather than
              // bouncing the reader out to GitHub. A bare `#how` anchor
              // would be swallowed by the hash router, so scroll directly.
              document
                .getElementById("how")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
            className="btn btn-ghost"
          >
            How it works
          </button>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- Footer --------------------------------- */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}
interface FooterCol {
  title: string;
  links: FooterLink[];
}

const FOOTER_COLS: FooterCol[] = [
  {
    title: "Protocol",
    links: [
      { label: "How recovery works", href: "#/recovery-guide" },
      { label: "GitHub",          href: "https://github.com/Jolah1/ghostKey",                       external: true },
      { label: "System status",   href: "#/status" },
    ],
  },
  {
    title: "Use it",
    links: [
      { label: "Set up a vault", href: "#/setup" },
      { label: "Sign in",         href: "#/checkin" },
      { label: "Inherit",         href: "#/inherit" },
      { label: "Dashboard",       href: "#/dashboard" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "X", href: "https://x.com/ghostkeyappbtc", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of Service", href: "#/terms" },
      { label: "Privacy Policy",   href: "#/privacy" },
      { label: "Contact",          href: "mailto:support@ghostkeyapp.com" },
    ],
  },
];

/**
 * Email capture for product updates. Posts to the server's sealed-at-rest
 * email list (see `api.subscribeNewsletter`). Deliberately quiet: one
 * field, one button, and a single confirmation line. We never reveal
 * whether an address was already subscribed.
 */
function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "busy") return;
    setState("busy");
    setMessage(null);
    try {
      await api.subscribeNewsletter(email.trim(), "footer");
      void api.trackEvent("newsletter.subscribed", "footer");
      setState("done");
      setEmail("");
    } catch (err) {
      setState("error");
      setMessage(
        err instanceof ApiError && err.status === 400
          ? "That doesn't look like an email. Try again."
          : "Something went wrong. Please try again.",
      );
    }
  }

  if (state === "done") {
    return (
      <p className="mt-6 text-sm text-soft">
        You're on the list. We'll only email now and then.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-sm">
      <label htmlFor="newsletter-email" className="text-sm text-muted">
        Get occasional updates. No spam.
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="newsletter-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-lg border border-app bg-surface px-3 py-2 text-sm outline-none focus:border-[var(--border-hi)]"
        />
        <button
          type="submit"
          disabled={state === "busy"}
          className="btn btn-primary shrink-0 disabled:opacity-60"
        >
          {state === "busy" ? "..." : "Subscribe"}
        </button>
      </div>
      {message ? (
        <p className="mt-2 text-xs text-alarm" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}

function Footer() {
  return (
    <footer className="border-t border-app">
      <div className="mx-auto max-w-6xl px-5 py-14 md:px-8">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-12">
          <div className="md:col-span-4">
            <p className="flex items-center gap-2.5 font-display text-2xl font-bold tracking-tight">
              <img src="/brand-mark.png" alt="" className="h-9 w-9 rounded-lg" />
              <span>ghost<span className="text-accent">Key</span></span>
            </p>
            <p className="mt-3 max-w-sm text-sm text-muted">
              Heartbeat-based Bitcoin inheritance. Your Bitcoin doesn't die with
              you. The rules live on the chain, not on us.
            </p>
            <NewsletterSignup />
          </div>
          {FOOTER_COLS.map((col) => (
            <div key={col.title} className="md:col-span-2 lg:col-span-2">
              <p className="text-xs uppercase tracking-wider text-dim">
                {col.title}
              </p>
              <ul role="list" className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target={l.external ? "_blank" : undefined}
                      rel={l.external ? "noreferrer noopener" : undefined}
                      className="text-sm text-muted transition-colors hover:text-[var(--text)]"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-app pt-6 text-xs text-dim md:flex-row md:items-center md:justify-between">
          <p>
            GhostKey is not a legal will. It is a way to make sure your
            family can reach your Bitcoin if you are gone.
          </p>
          <p>© {new Date().getFullYear()} GhostKey</p>
        </div>
      </div>
    </footer>
  );
}

/* --------------------------------- Icons ---------------------------------- */

function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-2 w-2" aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
