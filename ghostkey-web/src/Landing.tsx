/**
 * Landing page. Always rendered at the top-level route `landing`.
 *
 * Sections in order:
 *  - Hero with animated cascading words and a "shadow" call-to-action.
 *  - Feature cards ("How it works") — three cards, soft shadows.
 *  - "Why trust this" two-column band.
 *  - FAQ accordion.
 *  - Final CTA + footer.
 */
import { useState } from "react";
import {
  ArrowRight,
  ShieldCheck,
  Heart,
  HandHeart,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { brand, explain, heroWords } from "./vocab";
import type { Route } from "./App";

interface Props {
  onNavigate: (r: Route) => void;
}

export function Landing({ onNavigate }: Props) {
  return (
    <main className="bg-cream">
      <Hero onNavigate={onNavigate} />
      <Features />
      <WhyTrust />
      <FAQ />
      <CallToAction onNavigate={onNavigate} />
      <Footer />
    </main>
  );
}

/* ---------------------------------- Hero ---------------------------------- */

function Hero({ onNavigate }: Props) {
  return (
    <section className="relative overflow-x-clip bg-swoosh">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 md:grid-cols-12 md:px-8 md:py-24 lg:py-28">
        <div className="md:col-span-7">
          <p className="badge animate-fade-up">
            For everyone with someone to inherit
          </p>

          <h1 className="mt-6 break-words font-display text-4xl font-bold leading-[0.95] tracking-tighter sm:text-5xl md:text-7xl lg:text-8xl">
            {heroWords.map((w, i) => (
              <span
                key={i}
                className={`block animate-word-in anim-delay-${i + 1} ${
                  w.color === "bitcoin" ? "text-bitcoin" : "text-ink"
                }`}
                style={{ perspective: "800px" }}
              >
                {w.text}
              </span>
            ))}
          </h1>

          <p className="mt-8 max-w-xl text-lg leading-relaxed text-ink-500 animate-fade-up anim-delay-5 md:text-xl">
            {brand.longTagline}
          </p>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row animate-fade-up anim-delay-5">
            <button
              onClick={() => onNavigate("setup")}
              className="btn-primary !px-6 !py-3 text-base"
            >
              Set up savings
              <ArrowRight className="h-5 w-5" />
            </button>
            <a href="#how" className="btn-ghost !px-6 !py-3 text-base">
              How does it work?
            </a>
          </div>
        </div>

        {/* Decorative card stack — illustrative, not interactive. */}
        <div className="md:col-span-5">
          <HeroIllustration />
        </div>
      </div>
    </section>
  );
}

function HeroIllustration() {
  // Stable flex stack — no absolute positioning, so the cards can't
  // overlap or escape their container even on narrow viewports. Each
  // card has a small cosmetic tilt that's intentionally tiny (≤2deg)
  // so it reads as "playful" without breaking neighboring layout.
  return (
    <div className="mx-auto w-full max-w-sm space-y-4 md:max-w-md">
      <article
        className="card -rotate-1 p-5 animate-fade-up"
        style={{ animationDelay: "0.4s" }}
      >
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">
          Savings
        </p>
        <p className="mt-1.5 font-display text-xl font-semibold">
          Rainy day fund
        </p>
        <p className="mt-2 font-mono text-2xl tabular-nums text-bitcoin">
          ₿ 0.50
        </p>
        <div className="mt-3 flex items-center gap-2 text-xs text-ink-400">
          <span className="h-2 w-2 rounded-full bg-ok" />
          All good
        </div>
      </article>

      <article
        className="card rotate-1 p-5 animate-fade-up"
        style={{ animationDelay: "0.55s" }}
      >
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">
          Next reminder
        </p>
        <p className="mt-1.5 font-display text-2xl font-semibold">in 4 days</p>
        <p className="mt-2 text-sm text-ink-400">
          Tap once a week and your savings stay protected.
        </p>
      </article>

      <div
        className="flex justify-center animate-fade-up"
        style={{ animationDelay: "0.7s" }}
      >
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-bitcoin/40 blur-2xl"
          />
          <div className="btn-primary cursor-default !px-6 !py-3 text-base shadow-glow">
            <Heart className="h-5 w-5" fill="currentColor" /> I'm OK today
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Features --------------------------------- */

function Features() {
  return (
    <section id="how" className="bg-white py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="badge">How it works</p>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-5xl">
            Three small habits.{" "}
            <span className="text-bitcoin">One big peace of mind.</span>
          </h2>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
          <Feature
            icon={ShieldCheck}
            title="Put money aside"
            body="Decide how much Bitcoin to set aside and name the people who would inherit it."
          />
          <Feature
            icon={Heart}
            title="Tap I'm OK"
            body="Every week (or however often you choose) just tap a button. That's it."
          />
          <Feature
            icon={HandHeart}
            title="They get what's theirs"
            body="If you ever stop tapping, the people you named can claim the money automatically."
          />
        </div>
      </div>
    </section>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <article className="card p-6 transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bitcoin-50">
        <Icon className="h-6 w-6 text-bitcoin" strokeWidth={2} />
      </div>
      <h3 className="mt-5 font-display text-xl font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
    </article>
  );
}

/* ------------------------------- Why trust -------------------------------- */

function WhyTrust() {
  return (
    <section className="bg-cream py-20 md:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 md:grid-cols-12 md:gap-16 md:px-8">
        <div className="md:col-span-5">
          <p className="badge">Why you can trust this</p>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-5xl">
            The promise lives on{" "}
            <span className="text-bitcoin">Bitcoin</span>, not on our
            website.
          </h2>
        </div>
        <div className="space-y-4 text-lg leading-relaxed text-ink-500 md:col-span-7 md:text-xl">
          <p>{explain.whyTrust}</p>
          <p>{explain.privacy}</p>
          <p className="text-sm text-ink-400">{explain.notAWill}</p>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- FAQ ----------------------------------- */

const FAQS = [
  {
    q: "What does this actually do?",
    a: "GhostKey lets you put aside Bitcoin in a way the person you've named can claim if you stop checking in. You stay in complete control while you're active.",
  },
  {
    q: "How often do I have to tap I'm OK?",
    a: "Whatever you choose during setup. Weekly is a good starting point. You can pick daily, weekly, monthly, or any custom rhythm.",
  },
  {
    q: "What happens if I miss a reminder?",
    a: "A short grace period kicks in. After that, a waiting period (also of your choosing) starts. Once it ends, the people you named can claim the money. You can still tap I'm OK any time before then to reset everything.",
  },
  {
    q: "Can the person I named claim early?",
    a: "No. The waiting period is enforced by Bitcoin itself. Until it ends, no one — not them, not us, not anyone — can move the money.",
  },
  {
    q: "Do I need a wallet?",
    a: "For setting up the savings, yes — you'll use the GhostKey app on your computer. For the website itself, a Lightning wallet like Alby is optional. It only proves your identity, not your spending power.",
  },
  {
    q: "Is this a legal will?",
    a: "No. It's a programmable way to leave Bitcoin to someone you've named. Most people use it alongside a regular will.",
  },
];

function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="bg-white py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-5 md:px-8">
        <div className="text-center">
          <p className="badge">Common questions</p>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-5xl">
            Things people ask.
          </h2>
        </div>
        <div className="mt-12 space-y-3">
          {FAQS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={item.q}
                className="card overflow-hidden p-0 transition-all"
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="font-display text-base font-semibold md:text-lg">
                    {item.q}
                  </span>
                  <ChevronDown
                    className={`h-5 w-5 text-ink-400 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                <div
                  className={`grid transition-all duration-300 ${
                    isOpen
                      ? "grid-rows-[1fr] opacity-100"
                      : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <p className="px-5 pb-5 text-sm leading-relaxed text-ink-500 md:text-base">
                      {item.a}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- CTA ------------------------------------ */

function CallToAction({ onNavigate }: Props) {
  return (
    <section className="bg-cream py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-5 text-center md:px-8">
        <h2 className="font-display text-4xl font-bold tracking-tighter md:text-6xl">
          Ready to take care of{" "}
          <span className="text-bitcoin">someone?</span>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-ink-500">
          Set up takes about 10 minutes. After that, it's one tap, once a
          week.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            onClick={() => onNavigate("setup")}
            className="btn-primary !px-6 !py-3 text-base"
          >
            Set up savings
            <ArrowRight className="h-5 w-5" />
          </button>
          <button
            onClick={() => onNavigate("checkin")}
            className="btn-outline !px-6 !py-3 text-base"
          >
            Already set up? Tap I'm OK
          </button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- Footer ---------------------------------- */

function Footer() {
  return (
    <footer className="border-t border-ink/5 bg-ink py-10 text-cream">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-5 md:flex-row md:items-center md:justify-between md:px-8">
        <div>
          <p className="font-display text-xl font-bold tracking-tight">
            {brand.name}
          </p>
          <p className="mt-1 text-sm text-cream/70">{brand.tagline}</p>
        </div>
        <p className="max-w-md text-xs text-cream/50">
          {explain.notAWill}
        </p>
      </div>
    </footer>
  );
}
