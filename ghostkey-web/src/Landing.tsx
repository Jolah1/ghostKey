/**
 * First-run landing screen.
 *
 * Shown when the server reports zero registered vaults. Big friendly
 * hero, three "how it works" cards, and a single CTA that drops into
 * the Add-vault wizard. This is the doorway for a non-technical
 * family member who has never seen the app before.
 */
import {
  HandHeart,
  Heart,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { Brand } from "./Brand";
import { brand, explain } from "./vocab";

interface Props {
  onAddVault: () => void;
}

export function Landing({ onAddVault }: Props) {
  return (
    <div className="bg-paper">
      {/* Top nav */}
      <header className="border-b-4 border-ink bg-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Brand />
          <button
            onClick={onAddVault}
            className="neo-button-lime hidden md:inline-flex"
          >
            <Sparkles className="h-4 w-4" /> Set one up
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b-4 border-ink">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24 lg:py-28">
          <span className="neo-badge bg-cyan animate-slide-up">
            <Heart className="h-3.5 w-3.5" /> For families, not techies
          </span>

          <h1 className="mt-6 max-w-4xl font-display text-5xl font-bold leading-[0.95] tracking-tight md:text-7xl lg:text-8xl">
            Save Bitcoin for the people you love —{" "}
            <span className="bg-lime px-2">no lawyer needed.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground md:text-xl">
            {brand.longTagline}
          </p>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={onAddVault}
              className="neo-button-lime text-base"
            >
              <Sparkles className="h-5 w-5" />
              Set up my first savings
              <ArrowRight className="h-5 w-5" />
            </button>
            <a
              href="#how-it-works"
              className="neo-button text-base"
            >
              How does it work?
            </a>
          </div>
        </div>

        {/* Decorative tilted badges, hidden on mobile so they never crowd the headline. */}
        <div
          aria-hidden
          className="pointer-events-none absolute right-10 top-12 hidden md:block tilt-right"
        >
          <div className="neo-card bg-pink p-6 w-56">
            <p className="font-display text-xs font-bold uppercase tracking-widest">
              Today
            </p>
            <p className="mt-1 font-display text-2xl font-bold">
              "I'm OK"
            </p>
            <p className="mt-2 text-xs text-ink/70">
              Tap once a week and your family stays safe.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        className="border-b-4 border-ink bg-paper"
      >
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              How it works
            </p>
            <h2 className="mt-2 font-display text-4xl font-bold leading-tight md:text-5xl">
              Three small habits. One big peace of mind.
            </h2>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            <Step
              n={1}
              accent="bg-lime"
              icon={ShieldCheck}
              title="Put money aside"
              body="You decide how much Bitcoin to set aside, and pick who would inherit it."
            />
            <Step
              n={2}
              accent="bg-cyan"
              icon={Heart}
              title={`Tap "I'm OK"`}
              body="Every week (or however often you choose), just tap a button. That's it."
              tilt="tilt-right"
            />
            <Step
              n={3}
              accent="bg-pink"
              icon={HandHeart}
              title="Family is protected"
              body="If you ever stop tapping, the people you named can claim the money — automatically."
              tilt="tilt-left"
            />
          </div>
        </div>
      </section>

      {/* Why trust */}
      <section className="neo-section-lime border-b-4 border-ink">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest">
                Why you can trust this
              </p>
              <h2 className="mt-2 font-display text-4xl font-bold leading-tight md:text-5xl">
                The promise lives on Bitcoin, not on our website.
              </h2>
            </div>
            <div className="space-y-4 text-lg leading-relaxed md:text-xl">
              <p>{explain.whyTrust}</p>
              <p>{explain.privacy}</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b-4 border-ink bg-paper">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24 text-center">
          <h2 className="font-display text-4xl font-bold leading-tight md:text-6xl">
            Ready to take care of your family?
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Setting up takes about 10 minutes. After that, it's one tap, once a
            week.
          </p>
          <button
            onClick={onAddVault}
            className="neo-button-lime mt-10 text-base"
          >
            <Sparkles className="h-5 w-5" />
            Set up my first savings
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>
      </section>

      <footer className="bg-ink text-paper">
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm">
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div>
              <p className="font-display text-lg font-bold uppercase tracking-tight">
                {brand.name}
              </p>
              <p className="mt-1 text-paper/70">{brand.tagline}</p>
            </div>
            <p className="text-xs uppercase tracking-widest text-paper/60">
              Not a legal will. Programmable Bitcoin custody continuity.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

interface StepProps {
  n: number;
  title: string;
  body: string;
  icon: LucideIcon;
  accent: string;
  tilt?: string;
}

function Step({ n, title, body, icon: Icon, accent, tilt }: StepProps) {
  return (
    <article
      className={`neo-card p-6 ${tilt ?? ""} animate-slide-up`}
    >
      <div className="flex items-start justify-between">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-xl neo-border ${accent}`}
        >
          <Icon className="h-6 w-6" strokeWidth={2.5} />
        </div>
        <span className="font-display text-5xl font-bold text-ink/10">
          {n}
        </span>
      </div>
      <h3 className="mt-6 font-display text-2xl font-bold leading-tight">
        {title}
      </h3>
      <p className="mt-2 text-base leading-relaxed text-muted-foreground">
        {body}
      </p>
    </article>
  );
}
