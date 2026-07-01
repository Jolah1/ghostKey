/**
 * Public recovery guide (#/recovery-guide).
 *
 * A static, non-technical explainer for the single most important
 * promise GhostKey makes: your heir can still claim even if GhostKey
 * disappears. It's linked from the footer and from the "What if
 * GhostKey shuts down" FAQ answer.
 *
 * Not to be confused with RecoveryKitPage (#/recovery), which lets a
 * signed-in owner download their recovery file. This page explains
 * what that file is for and how it's used.
 *
 * Tone matches the rest of the app: a non-technical reader should
 * understand every line. Bitcoin terms are kept to the minimum the
 * story actually needs.
 */
import type { ReactNode } from "react";
import type { Route } from "./App";
import { api } from "./api";

interface Props {
  onNavigate: (r: Route) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted md:text-base">
        {children}
      </div>
    </section>
  );
}

export function RecoveryGuide({ onNavigate }: Props) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-16 md:py-20">
        <p className="eyebrow-tag">Recovery</p>
        <h1 className="mt-3 font-serif text-4xl md:text-5xl">
          If GhostKey ever disappears
        </h1>

        <section className="card-flat mt-8 p-5">
          <h2 className="text-sm font-semibold">The short version</h2>
          <div className="mt-1.5 space-y-2 text-sm text-muted">
            <p>
              Your heir can still claim. The rules that release your Bitcoin
              live on the Bitcoin network, not on our servers. At setup you
              download one recovery file that holds everything needed to claim
              without us. Keep it with your important papers and tell your heir
              where it is.
            </p>
          </div>
        </section>

        <div className="mt-12 space-y-10">
          <Section title="Why this works">
            <p>
              When you set up a vault, the plan is written into Bitcoin itself
              as a small spending rule: after a set waiting period with no
              check-in from you, the person you named can spend the funds. That
              rule is enforced by the Bitcoin network, which has run without
              interruption for over fifteen years.
            </p>
            <p>
              GhostKey just makes that rule easy to live with: reminders for
              you, and a guided claim for your heir. If GhostKey shut down
              tomorrow, the rule on Bitcoin would still be there, and the funds
              could still be claimed.
            </p>
          </Section>

          <Section title="The recovery file">
            <p>
              At setup you download a single file, named something like{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">
                ghostkey-recovery-yourvault.html
              </code>
              . It contains the vault's rules and your own encrypted key. It
              does not need GhostKey, an account, or an internet connection to
              do its job.
            </p>
            <p>
              Treat it like a key to a safe. Store a copy somewhere safe and
              lasting, and make sure the people who would need it know where to
              find it. If you ever misplace it, you can sign in and download a
              fresh copy from the{" "}
              <button
                type="button"
                className="underline"
                onClick={() => onNavigate("recovery")}
              >
                recovery kit page
              </button>
              .
            </p>
          </Section>

          <Section title="The normal way: GhostKey is running">
            <p>
              When the waiting period passes, the person you named gets a
              notification with a link. They open it, confirm a few details,
              and finish the claim in their browser. Nothing to install,
              nothing technical to learn.
            </p>
          </Section>

          <Section title="If GhostKey is gone">
            <p>
              Your heir opens the recovery file in any web browser. The file is
              a self-contained tool: it rebuilds the claim and signs it right
              there on their device, even with no internet, then produces a
              transaction they can broadcast to the Bitcoin network. It walks
              them through each step.
            </p>
            <p>
              For anyone who wants to verify everything independently, the vault
              uses standard Bitcoin building blocks (a Taproot script with a
              time-lock). A technically comfortable helper can reconstruct and
              broadcast the claim on their own using{" "}
              <a
                className="underline"
                href="https://bitcoincore.org/en/download/"
                target="_blank"
                rel="noreferrer noopener"
              >
                Bitcoin Core
              </a>
              , the reference Bitcoin software. This is the deepest fallback,
              and it needs no help from us.
            </p>
            <p className="text-dim">
              A note on other tools: some popular wallets don't yet understand
              this kind of time-locked vault, so we point to Bitcoin Core rather
              than promise something that might not work when it matters most.
            </p>
          </Section>

          <Section title="What to do now">
            <p>
              Three small things make all of this real:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>Download your recovery file and store it safely.</li>
              <li>Tell your heir it exists and where to find it.</li>
              <li>Keep checking in, so the clock only runs when you mean it to.</li>
            </ul>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  void api.trackEvent("recovery_guide.cta_clicked", "setup");
                  onNavigate("setup");
                }}
                className="btn btn-primary"
              >
                Set up your vault
              </button>
            </div>
          </Section>
        </div>

        <p className="mt-12 border-t border-app pt-6 text-sm text-dim">
          Questions? Email{" "}
          <a className="underline" href="mailto:support@ghostkeyapp.com">
            support@ghostkeyapp.com
          </a>
          .
        </p>
      </div>
    </main>
  );
}
