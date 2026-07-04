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
              save two files: your own spare key, and a file made for your
              heir with its own short unlock code. Keep the heir's file and
              its code together with your important papers, and tell your
              heir where they are.
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

          <Section title="Two files, one for each of you">
            <p>
              <strong>Your spare key</strong> is a file named something like{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">
                ghostkey-recovery-yourvault.html
              </code>
              . It opens with the same password you sign in with, and it's for
              you: if you ever lose access to GhostKey, it reaches your money.
              Your heir cannot open this one, and that's on purpose. You never
              have to write your password down.
            </p>
            <p>
              <strong>Your heir's file</strong> is named something like{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">
                ghostkey-for-ada.html
              </code>
              . It opens with a short code of five simple words, shown to you
              once at setup. Keep the file and its code together, somewhere
              your heir will look when the time comes: with your will, your
              important papers, or someone you both trust. Keeping the code
              beside the file is safe, because Bitcoin's own timer keeps the
              file powerless while you're alive and checking in.
            </p>
            <p>
              Neither file needs GhostKey, an account, or an internet
              connection to do its job. If you misplace your own spare key,
              sign in and download a fresh copy from the{" "}
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
              Your heir opens <strong>their</strong> file in any web browser
              and types the code that was kept with it. The file is a
              self-contained tool: it walks them through each step and moves
              the money right there on their device, no GhostKey involved.
              Your own spare key works the same way for you, with your
              password.
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
              <li>
                Store your heir's file and its code together, somewhere your
                heir will look.
              </li>
              <li>Tell your heir the file exists. They don't need to open or understand it now.</li>
              <li>Keep your own spare key file somewhere safe too.</li>
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
