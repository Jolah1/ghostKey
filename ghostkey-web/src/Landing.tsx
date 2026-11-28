/**
 * The website's front page: savings first, passing it on optional.
 *
 *   1. Hero          headline, two buttons, and a live example savings card
 *                    (balance ticks up, goal bar fills, monthly ring, streak,
 *                    a "Pass it on" switch)
 *   2. How it works  four steps that play in turn and can be clicked
 *   3. Try it        a monthly-savings slider, the optional wait picker, and
 *                    (once the server has it) the lock picker
 *   4. Safety        four plain promises
 *   5. Questions     the home-page subset of src/faq.ts, answers on tap
 *   6. Final call    one line and one button
 *   7. Footer
 *
 * Locked savings appear only when the server says they're live
 * (`useLockedGoals`), so the page never promises something we can't do.
 * Every animation stops for anyone whose device asks for reduced motion.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Route } from "./App";
import { ApiError, api } from "./api";
import { FAQS } from "./faq";
import { useLockedGoals, useServerNetwork } from "./features";
import { useTrackInView } from "./useTrackInView";

interface Props {
  onNavigate: (r: Route) => void;
}

/** Lock lengths offered, in months. */
const LOCK_MONTHS = [3, 6, 12] as const;
const WAIT_MONTHS = [3, 6, 9, 12] as const;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function addMonths(months: number, from = new Date()): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

function longDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

export function Landing({ onNavigate }: Props) {
  const locked = useLockedGoals();
  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="gk-drift pointer-events-none absolute -right-40 -top-56 h-[760px] w-[760px] rounded-full"
        style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 65%)" }}
      />
      <div
        aria-hidden="true"
        className="gk-drift pointer-events-none absolute -left-64 top-[420px] h-[680px] w-[680px] rounded-full"
        style={{
          background: "radial-gradient(circle, color-mix(in srgb, var(--brand-blue) 18%, transparent), transparent 65%)",
          animationDelay: "-6s",
        }}
      />
      <Hero onNavigate={onNavigate} locked={locked} />
      <HowItWorks locked={locked} />
      <TryIt locked={locked} />
      <Safety locked={locked} />
      <Questions onNavigate={onNavigate} locked={locked} />
      <FinalCTA onNavigate={onNavigate} />
      <Footer />
    </main>
  );
}

/* --------------------------------- Shared --------------------------------- */

function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="text-sm font-bold uppercase tracking-[0.08em] text-accent">{children}</span>;
}

function SectionTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={`m-0 font-display text-[clamp(34px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[var(--text)] ${className}`}
    >
      {children}
    </h2>
  );
}

/** A pill button in a row of choices (months, years). */
function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`min-h-12 min-w-[72px] rounded-full border px-[18px] py-2.5 text-base font-bold transition-colors ${
        on
          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--text-on-accent)]"
          : "border-[var(--border-hi)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--accent)]"
      }`}
    >
      {children}
    </button>
  );
}

function LockIcon({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function Check() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/* ---------------------------------- Hero ---------------------------------- */

function Hero({ onNavigate, locked }: Props & { locked: boolean }) {
  const ref = useTrackInView("landing.section_viewed", "hero");
  const network = useServerNetwork();
  return (
    <section ref={ref} className="relative mx-auto flex max-w-[1200px] flex-wrap items-center gap-14 px-6 pb-24 pt-10 md:pt-14">
      <div className="gk-rise flex min-w-0 flex-[1_1_480px] flex-col gap-6">
        {network === "bitcoin" ? (
          <span className="inline-flex items-center gap-2.5 self-start rounded-full border border-[var(--card-outline)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3.5 py-2 text-sm font-semibold text-[var(--accent-text)]">
            <span className="gk-dot h-2 w-2 rounded-full bg-[var(--ok)]" />
            Live on Bitcoin mainnet
          </span>
        ) : null}
        <h1 className="m-0 font-display text-[clamp(48px,6.4vw,84px)] font-extrabold leading-[0.98] tracking-[-0.035em] text-[var(--text)]">
          Stack sats.
          <br />
          <span className="text-accent">{locked ? "Lock them for big things." : "Build your future."}</span>
        </h1>
        <p className="m-0 max-w-[34ch] text-xl leading-relaxed text-muted">
          {locked
            ? "Pick a goal and a date. Bitcoin keeps your savings locked until then. Nobody can open it early, not even us."
            : "Save toward the big things, on your own key. If you ever stop showing up, it goes to the people you choose."}
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <button
            type="button"
            className="btn btn-primary px-7 py-4 text-[17px]"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "hero_setup");
              onNavigate("setup");
            }}
          >
            Start saving <ArrowRight />
          </button>
          <button type="button" className="btn btn-ghost px-6 py-4 text-[17px]" onClick={() => scrollToId("how")}>
            See how it works
          </button>
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-5 p-0 pt-1 text-[15px] text-muted">
          {["Free, no cut", "Nothing to install", "About 5 minutes"].map((t) => (
            <li key={t} className="flex items-center gap-2">
              <Check />
              {t}
            </li>
          ))}
        </ul>
        <p className="m-0 text-sm text-muted">
          Were you left something?{" "}
          <button
            type="button"
            className="font-semibold text-[var(--accent-text)] underline-offset-2 hover:underline"
            onClick={() => {
              void api.trackEvent("landing.cta_clicked", "hero_inherit");
              onNavigate("inherit");
            }}
          >
            Claim it here
          </button>
        </p>
      </div>
      <div className="relative flex min-w-0 flex-[1_1_420px] justify-center">
        <div
          aria-hidden="true"
          className="gk-glow absolute inset-10 rounded-[40px] blur-[30px]"
          style={{
            background:
              "radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--accent) 35%, transparent), color-mix(in srgb, var(--brand-blue) 25%, transparent) 50%, transparent 75%)",
          }}
        />
        <HeroCard locked={locked} />
      </div>
    </section>
  );
}

const MONTH_TARGET = 20_000;

/**
 * The example savings card. Sample deposits arrive every few seconds, the
 * goal bar fills, and "Add 5,000 sats" adds one by hand. It's labelled as
 * an example: nothing here is anyone's real money.
 */
function HeroCard({ locked }: { locked: boolean }) {
  const [balance, setBalance] = useState(1_248_500);
  const [month, setMonth] = useState(12_000);
  const [streak, setStreak] = useState(3);
  const [goal, setGoal] = useState(62);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [ripple, setRipple] = useState(0);
  const [heir, setHeir] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const unlockAt = useMemo(() => addMonths(6), []);
  const toastTimer = useRef<number | undefined>(undefined);

  const add = (sats: number, byHand: boolean) => {
    setBalance((b) => b + sats);
    setMonth((m) => {
      const next = m + sats;
      if (next >= MONTH_TARGET) {
        setStreak((s) => s + 1);
        return next - MONTH_TARGET;
      }
      return next;
    });
    if (sats >= 5_000) setGoal((g) => Math.min(100, g + 1));
    setToast({ key: Date.now(), text: sats.toLocaleString("en-US") });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2_400);
    if (byHand) setRipple((r) => r + 1);
  };

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const amounts = [1_000, 2_500, 5_000, 2_100];
    const deposits = window.setInterval(() => add(amounts[Math.floor(Math.random() * amounts.length)], false), 3_400);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(deposits);
      window.clearInterval(clock);
      window.clearTimeout(toastTimer.current);
    };
  }, []);

  const left = Math.max(0, unlockAt.getTime() - now);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const countdown = [
    [String(Math.floor(left / 864e5)), "days"],
    [pad(Math.floor(left / 36e5) % 24), "hrs"],
    [pad(Math.floor(left / 6e4) % 60), "min"],
    [pad(Math.floor(left / 1e3) % 60), "sec"],
  ];
  const ringC = 2 * Math.PI * 26;
  const monthPct = Math.round((month / MONTH_TARGET) * 100);

  return (
    <figure
      className="gk-float relative m-0 flex w-full max-w-[440px] flex-col gap-[22px] rounded-[28px] border border-[var(--card-outline)] p-7 shadow-[var(--shadow-lg)]"
      style={{ background: "linear-gradient(160deg, var(--surface), var(--bg-elev))" }}
      aria-label="An example savings card"
      data-testid="hero-card"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-muted">Your savings</span>
        {locked ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-2.5 py-1.5 text-[13px] font-bold text-[var(--accent-text)]">
            <LockIcon size={14} />
            Locked
          </span>
        ) : (
          <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-semibold text-muted">Example</span>
        )}
      </div>

      <div className="relative">
        <div className="font-display text-[44px] font-extrabold tracking-[-0.03em] text-[var(--text)]" data-testid="hero-balance">
          {balance.toLocaleString("en-US")} <span className="text-xl font-semibold text-muted">sats</span>
        </div>
        {toast ? (
          <div
            key={toast.key}
            className="gk-toast absolute -top-1.5 right-0 rounded-full bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-[var(--text-on-accent)]"
            aria-hidden="true"
          >
            +{toast.text} sats
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-sm">
          <span className="font-semibold text-[var(--text-body)]">School fees</span>
          <span className="text-muted">{goal}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{ width: `${goal}%`, background: "linear-gradient(90deg, var(--accent), var(--brand-blue))" }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[20px] border border-app bg-[var(--bg-elev)] p-[18px]">
        {locked ? (
          <>
            <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text-body)]">
              <LockIcon className="text-accent" />
              Unlocks {longDate(unlockAt)}
            </span>
            <div role="timer" aria-label="Time until it unlocks" className="grid grid-cols-4 gap-2">
              {countdown.map(([v, l]) => (
                <div key={l} className="flex flex-col items-center gap-0.5 rounded-xl border border-app bg-surface px-1 py-2.5">
                  <span key={`${l}${v}`} className="gk-tick font-display text-2xl font-extrabold text-[var(--text)]">
                    {v}
                  </span>
                  <span className="text-xs font-semibold text-muted">{l}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-4">
            <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" className="-rotate-90 shrink-0">
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--surface-2)" strokeWidth="7" />
              <circle
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={ringC}
                strokeDashoffset={ringC * (1 - monthPct / 100)}
                style={{ transition: "stroke-dashoffset .8s cubic-bezier(.16,1,.3,1)" }}
              />
            </svg>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-[var(--text-body)]">This month</span>
              <span className="text-sm text-muted">
                {month.toLocaleString("en-US")} of {MONTH_TARGET.toLocaleString("en-US")} sats
              </span>
            </div>
          </div>
        )}
        <div className="relative self-start">
          {ripple ? (
            <span key={ripple} aria-hidden="true" className="gk-ripple absolute inset-0 rounded-full border-[3px] border-[var(--accent)]" />
          ) : null}
          <button type="button" onClick={() => add(5_000, true)} className="btn btn-primary relative min-h-11 px-[18px] py-2.5">
            Add 5,000 sats
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3.5">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold text-[var(--text)]">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z" />
          </svg>
          {streak}-month streak
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={heir}
          onClick={() => setHeir((h) => !h)}
          className="flex min-h-11 items-center gap-2.5 text-sm font-semibold text-[var(--text-body)]"
        >
          Pass it on
          <span
            aria-hidden="true"
            className="relative h-[26px] w-11 rounded-full transition-colors"
            style={{ background: heir ? "var(--accent)" : "var(--surface-hi)" }}
          >
            <span
              className="absolute top-[3px] h-5 w-5 rounded-full bg-white transition-[left] duration-200"
              style={{ left: heir ? 21 : 3 }}
            />
          </span>
        </button>
      </div>
      {heir ? (
        <div className="gk-rise flex items-center gap-3 rounded-[14px] border border-[color-mix(in_srgb,var(--brand-blue)_40%,transparent)] bg-[color-mix(in_srgb,var(--brand-blue)_14%,transparent)] px-3.5 py-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand-blue)] text-[13px] font-bold text-white">
            AO
          </span>
          <span className="text-sm leading-snug text-[var(--text-body)]">Ada gets it if you go quiet for 6 months.</span>
        </div>
      ) : null}
      <figcaption className="text-xs text-dim">An example. Your own savings start at zero.</figcaption>
    </figure>
  );
}

/* ------------------------------ How it works ------------------------------ */

interface Step {
  title: string;
  who: string;
  line: string;
  big: string;
  small: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  width: 56,
  height: 56,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "var(--accent)",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const TargetIcon = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </svg>
);
const PlusIcon = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
const GrowIcon = (
  <svg {...ICON_PROPS}>
    <path d="M4 19h16" />
    <path d="M6 15l4-4 3 3 5-6" />
    <path d="M14 8h4v4" />
  </svg>
);
const HeartIcon = (
  <svg {...ICON_PROPS}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  </svg>
);
const LockBig = (
  <svg {...ICON_PROPS}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path className="gk-shackle" d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const UnlockIcon = (
  <svg {...ICON_PROPS}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.5-2" />
  </svg>
);

const FLEX_STEPS: Step[] = [
  { title: "Set a goal", who: "You", line: "School fees, a home, a rainy day. Name it, or skip it.", big: "Name what you're saving for", small: "A goal keeps you going.", icon: TargetIcon },
  { title: "Save when you can", who: "You", line: "Send sats from any wallet or exchange. Keep a streak, earn badges.", big: "Add sats any time", small: "On-chain or Lightning. Gentle nudges if you want them.", icon: PlusIcon },
  { title: "Watch it grow", who: "You", line: "Every deposit counts toward your goal and your streak.", big: "See your progress", small: "Your balance, your goal and your streak, in one place.", icon: GrowIcon },
  { title: "Pass it on", who: "Optional", line: "Name someone. If you stop showing up, they can claim it.", big: "If you ever stop showing up", small: "The person you chose can claim it. Nobody else.", icon: HeartIcon },
];

const LOCK_STEPS: Step[] = [
  FLEX_STEPS[0],
  { title: "Lock it", who: "Optional", line: "Pick a date. Bitcoin keeps it locked until then. Or keep it flexible.", big: "Lock it till you get there", small: "Nobody can open it early. Not a thief, not us, not even you.", icon: LockBig },
  { ...FLEX_STEPS[1] },
  { title: "Reach it", who: "You", line: "On your date it unlocks. Spend it on what you saved for.", big: "Unlock day", small: "Your savings, ready for the big thing you planned.", icon: UnlockIcon },
];

function HowItWorks({ locked }: { locked: boolean }) {
  const ref = useTrackInView("landing.section_viewed", "how_it_works");
  const steps = locked ? LOCK_STEPS : FLEX_STEPS;
  const [step, setStep] = useState(0);
  // Bumped on every change, so the progress bar and the panel replay.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const t = window.setInterval(() => {
      setStep((s) => (s + 1) % 4);
      setTick((k) => k + 1);
    }, 4_000);
    return () => window.clearInterval(t);
  }, [tick]);

  const cur = steps[step];
  return (
    <section ref={ref} id="how" className="relative border-y border-app bg-[var(--bg-elev)]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-12 px-6 py-24">
        <div className="flex max-w-[640px] flex-col gap-3">
          <Eyebrow>How it works</Eyebrow>
          <SectionTitle>Saving, made simple.</SectionTitle>
        </div>
        <div className="flex flex-wrap items-stretch gap-8">
          <ol className="m-0 flex min-w-0 flex-[1_1_380px] list-none flex-col gap-2.5 p-0">
            {steps.map((s, i) => {
              const on = i === step;
              return (
                <li key={s.title}>
                  <button
                    type="button"
                    onClick={() => {
                      setStep(i);
                      setTick((k) => k + 1);
                    }}
                    aria-pressed={on}
                    className={`flex w-full flex-col gap-2.5 rounded-[18px] border px-5 py-[18px] text-left transition-colors ${
                      on ? "border-[var(--card-outline)] bg-surface" : "border-app bg-transparent hover:bg-surface"
                    }`}
                  >
                    <span className="flex items-center gap-3.5">
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-extrabold ${
                          on ? "bg-[var(--accent)] text-[var(--text-on-accent)]" : "bg-[var(--surface-2)] text-[var(--text-body)]"
                        }`}
                      >
                        {i + 1}
                      </span>
                      <span className="font-display text-xl font-bold text-[var(--text)]">{s.title}</span>
                      <span className={`ml-auto text-[13px] font-semibold ${s.who === "Optional" ? "text-[var(--blue-text)]" : "text-muted"}`}>
                        {s.who}
                      </span>
                    </span>
                    {on ? (
                      <>
                        <span className="pl-[50px] text-base leading-normal text-muted">{s.line}</span>
                        <span aria-hidden="true" className="ml-[50px] block h-[3px] overflow-hidden rounded-full bg-[var(--surface-2)]">
                          <span key={tick} className="gk-fill block h-full bg-[var(--accent)]" />
                        </span>
                      </>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="relative flex min-h-[380px] min-w-0 flex-[1_1_420px] flex-col items-center justify-center gap-6 overflow-hidden rounded-[28px] border border-[var(--card-outline)] bg-surface p-10 text-center">
            <div aria-hidden="true" className="absolute inset-0" style={{ background: "var(--hero-glow)" }} />
            <div key={tick} className="gk-rise relative flex flex-col items-center gap-5" aria-live="polite">
              <div className="flex h-[120px] w-[120px] items-center justify-center rounded-[32px] border border-[var(--border-hi)] bg-[var(--surface-2)]">
                {cur.icon}
              </div>
              <div className="font-display text-[30px] font-extrabold tracking-[-0.02em] text-[var(--text)]">{cur.big}</div>
              <div className="max-w-[34ch] text-[17px] leading-normal text-muted">{cur.small}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- Try it --------------------------------- */

function TryIt({ locked }: { locked: boolean }) {
  const ref = useTrackInView("landing.section_viewed", "try_it");
  return (
    <section ref={ref} className="relative mx-auto flex max-w-[1200px] flex-col gap-10 px-6 py-24">
      <div className="flex max-w-[640px] flex-col gap-3">
        <Eyebrow>Try it</Eyebrow>
        <SectionTitle>Your plan, your rules.</SectionTitle>
      </div>
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        <GrowCard />
        {locked ? <LockCard /> : null}
        <PassItOnCard />
      </div>
    </section>
  );
}

function Card({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <div
      className={`gk-lift flex flex-col gap-6 rounded-[28px] border bg-surface p-8 ${
        accent ? "border-[var(--card-outline)]" : "border-app"
      }`}
    >
      {children}
    </div>
  );
}

function GrowCard() {
  const [monthly, setMonthly] = useState(20_000);
  const [years, setYears] = useState(5);
  const total = monthly * 12 * years;
  return (
    <Card accent>
      <h3 className="m-0 font-display text-2xl font-bold text-[var(--text)]">Watch it grow</h3>
      <div className="flex flex-col gap-2.5">
        <label htmlFor="gk-monthly" className="flex justify-between text-base text-[var(--text-body)]">
          <span>Each month</span>
          <strong className="text-[var(--text)]">{monthly.toLocaleString("en-US")} sats</strong>
        </label>
        <input
          id="gk-monthly"
          type="range"
          min={1_000}
          max={100_000}
          step={1_000}
          value={monthly}
          onChange={(e) => setMonthly(Number(e.target.value))}
          className="h-7 w-full accent-[var(--accent)]"
        />
      </div>
      <div role="group" aria-label="Years" className="flex flex-wrap gap-2.5">
        {[1, 5, 10, 20].map((y) => (
          <Choice key={y} on={y === years} onClick={() => setYears(y)}>
            {y} {y === 1 ? "year" : "years"}
          </Choice>
        ))}
      </div>
      <div className="flex flex-col gap-1 rounded-[20px] border border-[var(--card-outline)] bg-[var(--bg-elev)] p-5">
        <span className="text-sm text-muted">
          After {years} {years === 1 ? "year" : "years"} you&apos;d have saved
        </span>
        <span className="font-display text-[38px] font-extrabold tracking-[-0.02em] text-accent" aria-live="polite">
          {total.toLocaleString("en-US")} sats
        </span>
        <span className="text-[15px] text-muted">{(total / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 })} BTC</span>
      </div>
    </Card>
  );
}

function LockCard() {
  const [months, setMonths] = useState<number>(6);
  const [key, setKey] = useState(0);
  return (
    <Card accent>
      <div className="flex items-center gap-4">
        <div key={key} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent">
          <svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path className="gk-shackle" d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="m-0 font-display text-2xl font-bold text-[var(--text)]">Lock it</h3>
          <span className="text-[15px] text-muted">Choose how long</span>
        </div>
      </div>
      <div role="group" aria-label="Lock length" className="flex flex-wrap gap-2.5">
        {LOCK_MONTHS.map((m) => (
          <Choice
            key={m}
            on={m === months}
            onClick={() => {
              setMonths(m);
              setKey((k) => k + 1);
            }}
          >
            {m} mo
          </Choice>
        ))}
      </div>
      <div className="flex flex-col gap-1 rounded-[20px] border border-app bg-[var(--bg-elev)] p-5">
        <span className="text-sm text-muted">Unlocks on</span>
        <span key={key} className="gk-tick font-display text-[32px] font-extrabold tracking-[-0.02em] text-[var(--text)]">
          {longDate(addMonths(months))}
        </span>
      </div>
      <p className="m-0 text-base leading-normal text-[var(--text-body)]">
        Nobody can open it before then. <strong className="text-accent">Not even us.</strong>
      </p>
    </Card>
  );
}

function PassItOnCard() {
  const [wait, setWait] = useState(6);
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <span className="self-start rounded-full bg-[color-mix(in_srgb,var(--brand-blue)_18%,transparent)] px-2.5 py-1 text-[13px] font-bold text-[var(--blue-text)]">
          Optional
        </span>
        <h3 className="m-0 font-display text-2xl font-bold text-[var(--text)]">Pass it on, if you want</h3>
        <p className="m-0 text-base leading-normal text-muted">
          Name someone. If you stop signing in for this long, they can claim it.
        </p>
      </div>
      <div role="group" aria-label="Waiting period" className="flex flex-wrap gap-2.5">
        {WAIT_MONTHS.map((m) => (
          <Choice key={m} on={m === wait} onClick={() => setWait(m)}>
            {m} mo
          </Choice>
        ))}
      </div>
      <div className="flex flex-col gap-3.5" aria-hidden="true">
        <div className="relative h-3 rounded-full bg-[var(--surface-2)]">
          <div className="absolute inset-y-0 left-0 w-[82%] rounded-full bg-[var(--accent)]" />
          <div className="absolute inset-y-0 left-[82%] right-0 rounded-r-full bg-[var(--warning)] opacity-85" />
        </div>
        <div className="flex justify-between text-sm text-muted">
          <span>Last sign-in</span>
          <span>Reminders</span>
          <span>They can claim</span>
        </div>
      </div>
      <p className="m-0 text-base leading-normal text-[var(--text-body)]">
        Sign in once every <strong className="text-accent">{wait} months</strong>. We remind you 7, 3 and 1 day before.
      </p>
    </Card>
  );
}

/* --------------------------------- Safety --------------------------------- */

function Safety({ locked }: { locked: boolean }) {
  const ref = useTrackInView("landing.section_viewed", "safety");
  const items: { title: string; body: ReactNode }[] = [
    {
      title: "Your key stays yours",
      body: locked
        ? "Protected by your password, on your device. Flexible savings stay spendable any time."
        : "Protected by your password, on your device. You can spend any time.",
    },
    locked
      ? { title: "Locks nobody can break", body: "Bitcoin enforces your date. Not us, not a thief, not a bad day." }
      : { title: "Only your heir can claim", body: "They need a code only you two know. We never see it." },
    { title: "Works without us", body: "If GhostKey disappears, your recovery file still reaches the money." },
    {
      title: "Open source",
      body: (
        <>
          Every line is public.{" "}
          <a href="https://github.com/Jolah1/ghostKey" target="_blank" rel="noreferrer noopener" className="text-[var(--accent-text)] underline underline-offset-2">
            Check it yourself
          </a>
          .
        </>
      ),
    },
  ];
  return (
    <section ref={ref} className="relative border-y border-app bg-[var(--bg-elev)]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-6 py-24">
        <SectionTitle className="max-w-[18ch]">Safe by design, not by promise.</SectionTitle>
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          {items.map((it) => (
            <div key={it.title} className="gk-lift flex flex-col gap-3.5 rounded-3xl border border-app bg-surface p-7">
              <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
              <h3 className="m-0 text-xl font-bold text-[var(--text)]">{it.title}</h3>
              <p className="m-0 text-base leading-relaxed text-muted">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- Questions ------------------------------- */

function Questions({ onNavigate, locked }: Props & { locked: boolean }) {
  const ref = useTrackInView("landing.section_viewed", "faq");
  const [open, setOpen] = useState<number>(-1);
  const items = FAQS.filter((f) => f.home && (locked || !f.lockedOnly));
  return (
    <section ref={ref} id="faq" className="relative mx-auto flex max-w-[860px] flex-col gap-8 px-6 py-24">
      <SectionTitle>Questions</SectionTitle>
      <div className="flex flex-col gap-3">
        {items.map((f, i) => {
          const on = open === i;
          return (
            <div
              key={f.q}
              className={`overflow-hidden rounded-[20px] border bg-surface ${on ? "border-[var(--card-outline)]" : "border-app"}`}
            >
              <h3 className="m-0">
                <button
                  type="button"
                  onClick={() => setOpen(on ? -1 : i)}
                  aria-expanded={on}
                  className="flex min-h-16 w-full items-center justify-between gap-4 px-[22px] py-[18px] text-left text-lg font-semibold text-[var(--text)]"
                >
                  {f.q}
                  <svg
                    aria-hidden="true"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    className="shrink-0 transition-transform"
                    style={{ transform: on ? "rotate(45deg)" : "none" }}
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </h3>
              {on ? <p className="m-0 px-[22px] pb-5 text-base leading-relaxed text-muted">{f.a}</p> : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onNavigate("help")}
        className="self-start text-base font-semibold text-[var(--accent-text)] underline-offset-2 hover:underline"
      >
        More questions
      </button>
    </section>
  );
}

/* -------------------------------- Final call ------------------------------ */

function FinalCTA({ onNavigate }: Props) {
  const ref = useTrackInView("landing.section_viewed", "final_cta");
  return (
    <section ref={ref} className="relative border-t border-app">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-6 py-24 text-center">
        <SectionTitle>Start your savings plan</SectionTitle>
        <p className="m-0 text-lg text-muted">About five minutes. Free.</p>
        <button
          type="button"
          className="btn btn-primary px-7 py-4 text-[17px]"
          onClick={() => {
            void api.trackEvent("landing.cta_clicked", "final_setup");
            onNavigate("setup");
          }}
        >
          Start saving <ArrowRight />
        </button>
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
      { label: "X", href: "https://x.com/ghostKeybtc", external: true },
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
              Stack sats. Build your future. A bitcoin savings plan on your own
              key, that passes to the people you choose if you stop showing up.
              Build wealth that outlives you.
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

