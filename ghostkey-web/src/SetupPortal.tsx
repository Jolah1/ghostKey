/**
 * Setup portal — Tando-style restyle of the v1 4-step wizard.
 *
 * Steps:
 *   1. Name + Bitcoin network
 *   2. Reminder cadence, grace, waiting period
 *   3. Paste descriptor pair from CLI's vault.json
 *   4. Review + POST /vaults
 *
 * The wizard is intentionally still a wizard rather than a one-screen
 * form: a non-technical user is more comfortable with one decision per
 * screen than a long page of inputs.
 */
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  AlertTriangle,
  Sparkles,
  Heart,
  Terminal,
} from "lucide-react";
import { ApiError, api, type VaultListItem } from "./api";

type Network = "regtest" | "testnet" | "signet" | "bitcoin";

interface Draft {
  label: string;
  network: Network;
  checkinPeriodSecs: number;
  gracePeriodSecs: number;
  timelockBlocks: number;
  descriptorExternal: string;
  descriptorInternal: string;
}

const DEFAULT: Draft = {
  label: "",
  network: "regtest",
  checkinPeriodSecs: 7 * 86_400,
  gracePeriodSecs: 86_400,
  timelockBlocks: 1008,
  descriptorExternal: "",
  descriptorInternal: "",
};

const STEPS = [
  { n: 1, key: "name",      label: "Name it" },
  { n: 2, key: "timing",    label: "Reminders" },
  { n: 3, key: "addresses", label: "Technical bits" },
  { n: 4, key: "review",    label: "Review" },
] as const;

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
}

export function SetupPortal({ onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  }

  function next() {
    setError(null);
    if (step === 0 && !draft.label.trim()) {
      setError("Give your savings a friendly name first.");
      return;
    }
    if (step === 1) {
      if (draft.checkinPeriodSecs < 60) {
        setError("Reminders must be at least 1 minute apart.");
        return;
      }
      if (draft.timelockBlocks < 1 || draft.timelockBlocks > 65535) {
        setError("The waiting period must be between 1 and 65,535 blocks.");
        return;
      }
    }
    if (step === 2) {
      if (
        !draft.descriptorExternal.trim() ||
        !draft.descriptorInternal.trim()
      ) {
        setError("Paste both lines from your vault.json file.");
        return;
      }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function prev() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const resp = await api.createVault({
        label: draft.label,
        network: draft.network,
        descriptor_external: draft.descriptorExternal.trim(),
        descriptor_internal: draft.descriptorInternal.trim(),
        timelock_blocks: draft.timelockBlocks,
        checkin_period_secs: draft.checkinPeriodSecs,
        grace_period_secs: draft.gracePeriodSecs,
        owner_contact: null,
        heir_contact: null,
      });
      onCreated({
        id: resp.id,
        label: resp.label,
        status: resp.status,
        next_deadline_at: resp.next_deadline_at,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-cream py-12 md:py-16">
      <div className="mx-auto max-w-2xl px-5 md:px-8">
        <header className="mb-8 text-center">
          <p className="badge">Step {step + 1} of {STEPS.length}</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Set up savings
          </h1>
          <p className="mt-2 text-ink-500">
            One decision per screen. Takes about 10 minutes.
          </p>
        </header>

        <Stepper current={step} />

        <section className="mt-8 card p-6 md:p-8">
          {step === 0 && <StepName draft={draft} onChange={patch} />}
          {step === 1 && <StepTiming draft={draft} onChange={patch} />}
          {step === 2 && <StepAddresses draft={draft} onChange={patch} />}
          {step === 3 && <StepReview draft={draft} />}

          {error && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-bitcoin/30 bg-bitcoin-50 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-bitcoin-800" />
              <p className="text-sm text-bitcoin-900">{error}</p>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between gap-3">
            {step > 0 ? (
              <button
                onClick={prev}
                disabled={busy}
                className="btn-outline"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            ) : (
              <button onClick={onCancel} className="btn-ghost">
                Cancel
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button onClick={next} className="btn-primary">
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={busy}
                className="btn-primary"
              >
                {busy ? (
                  <>
                    <Heart className="h-4 w-4 animate-pulse" /> Creating…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Create my savings
                  </>
                )}
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/* --------------------------------- Stepper -------------------------------- */

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const state =
          i < current ? "done" : i === current ? "current" : "pending";
        return (
          <li
            key={s.key}
            className="flex flex-1 items-center gap-2 last:flex-none"
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all ${
                state === "done"
                  ? "bg-bitcoin text-white"
                  : state === "current"
                    ? "bg-bitcoin text-white shadow-glow"
                    : "border border-ink/15 bg-white text-ink-400"
              }`}
            >
              {state === "done" ? <Check className="h-4 w-4" /> : s.n}
            </span>
            <span
              className={`hidden text-xs font-medium md:inline ${
                state === "pending" ? "text-ink-400" : "text-ink"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="flex-1 border-t border-ink/10" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------- Steps ---------------------------------- */

function StepName({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
        Give your savings a name.
      </h2>
      <p className="mt-2 text-ink-500">
        Something memorable, in your own words.
      </p>

      <div className="mt-6 space-y-5">
        <Field
          label="What should we call these savings?"
          hint="Examples: 'Rainy day fund', 'Kids' college', 'Co-founder buyout'"
        >
          <input
            type="text"
            autoFocus
            maxLength={120}
            value={draft.label}
            placeholder="Rainy day fund"
            onChange={(e) => onChange({ label: e.target.value })}
            className="input"
          />
        </Field>
        <Field
          label="Which Bitcoin network?"
          hint="Practice on 'regtest' or 'testnet'. Pick 'bitcoin' only when you're ready for real money."
        >
          <select
            value={draft.network}
            onChange={(e) =>
              onChange({ network: e.target.value as Network })
            }
            className="input"
          >
            <option value="regtest">Regtest (practice)</option>
            <option value="testnet">Testnet (practice)</option>
            <option value="signet">Signet (practice)</option>
            <option value="bitcoin">Bitcoin (real money)</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function StepTiming({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
        How often should we remind you?
      </h2>
      <p className="mt-2 text-ink-500">
        Pick a rhythm that fits your life. Weekly is a good starting point.
      </p>

      <div className="mt-6 space-y-5">
        <Field
          label="Tap I'm OK every"
          hint="If you miss a reminder, the grace period starts."
        >
          <PresetGroup
            value={draft.checkinPeriodSecs}
            onChange={(v) => onChange({ checkinPeriodSecs: v })}
            presets={[
              { label: "Daily", value: 86_400 },
              { label: "Weekly", value: 7 * 86_400 },
              { label: "Every 2 weeks", value: 14 * 86_400 },
              { label: "Monthly", value: 30 * 86_400 },
            ]}
          />
        </Field>

        <Field
          label="Grace period after a missed reminder"
          hint="A short cushion so you don't trip the alarm if you're a few hours late."
        >
          <PresetGroup
            value={draft.gracePeriodSecs}
            onChange={(v) => onChange({ gracePeriodSecs: v })}
            presets={[
              { label: "1 hour", value: 3_600 },
              { label: "6 hours", value: 21_600 },
              { label: "1 day", value: 86_400 },
              { label: "3 days", value: 3 * 86_400 },
            ]}
          />
        </Field>

        <Field
          label="Waiting period before the inheritor can claim"
          hint="Once you stop tapping completely, the person you named must wait this many Bitcoin blocks before they can claim. A block is about 10 minutes."
        >
          <PresetGroup
            value={draft.timelockBlocks}
            onChange={(v) => onChange({ timelockBlocks: v })}
            presets={[
              { label: "~1 day (144)", value: 144 },
              { label: "~1 week (1008)", value: 1008 },
              { label: "~1 month (4320)", value: 4320 },
              { label: "~3 months (12960)", value: 12960 },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

function StepAddresses({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
        Paste the technical bits.
      </h2>
      <p className="mt-2 text-ink-500">
        Run the GhostKey app on your computer first to create your
        password and matching public addresses. Then paste the two lines
        below.
      </p>

      <div className="mt-6 rounded-2xl border border-bitcoin/20 bg-bitcoin-50/70 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-bitcoin-900">
          <Terminal className="h-4 w-4" /> Where to find this
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-bitcoin-900">
          <li>
            Run{" "}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
              ghostkey ... make-vault ...
            </code>{" "}
            on your computer.
          </li>
          <li>
            Open{" "}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
              .ghostkey/&lt;profile&gt;/vault.json
            </code>
            .
          </li>
          <li>
            Copy the values of{" "}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
              descriptor_external
            </code>{" "}
            and{" "}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
              descriptor_internal
            </code>{" "}
            below.
          </li>
        </ol>
      </div>

      <div className="mt-6 space-y-5">
        <Field
          label="descriptor_external"
          hint="The first long line from vault.json. Starts with 'tr(' and ends with '/0/*)'."
        >
          <textarea
            value={draft.descriptorExternal}
            onChange={(e) =>
              onChange({ descriptorExternal: e.target.value })
            }
            rows={4}
            placeholder="tr(50929b...,or_d(pk([.../0/*)..."
            className="textarea"
          />
        </Field>
        <Field
          label="descriptor_internal"
          hint="The second long line. Same shape, ends with '/1/*)'."
        >
          <textarea
            value={draft.descriptorInternal}
            onChange={(e) =>
              onChange({ descriptorInternal: e.target.value })
            }
            rows={4}
            placeholder="tr(50929b...,or_d(pk([.../1/*)..."
            className="textarea"
          />
        </Field>
      </div>
    </div>
  );
}

function StepReview({ draft }: { draft: Draft }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
        Looks good?
      </h2>
      <p className="mt-2 text-ink-500">
        Quick look, then tap "Create my savings" to set it live.
      </p>

      <dl className="mt-6 divide-y divide-ink/5 rounded-2xl border border-ink/5 bg-cream/40">
        <ReviewRow k="Name" v={draft.label} />
        <ReviewRow k="Bitcoin network" v={draft.network} />
        <ReviewRow
          k="Remind me every"
          v={prettyDuration(draft.checkinPeriodSecs)}
        />
        <ReviewRow
          k="Grace period"
          v={prettyDuration(draft.gracePeriodSecs)}
        />
        <ReviewRow
          k="Waiting period"
          v={`${draft.timelockBlocks} blocks (≈ ${prettyDuration(draft.timelockBlocks * 600)})`}
        />
      </dl>
    </div>
  );
}

/* --------------------------------- Bits ----------------------------------- */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-400">
        {label}
      </span>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-2 text-xs text-ink-400">{hint}</p>}
    </label>
  );
}

function PresetGroup<T extends number>({
  value,
  onChange,
  presets,
}: {
  value: T;
  onChange: (v: T) => void;
  presets: { label: string; value: T }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {presets.map((p) => {
        const selected = p.value === value;
        return (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.value)}
            className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-all ${
              selected
                ? "border-bitcoin bg-bitcoin text-white shadow-glow"
                : "border-ink/15 bg-white text-ink hover:border-ink/30"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm">
      <dt className="text-xs font-semibold uppercase tracking-widest text-ink-400">
        {k}
      </dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

function prettyDuration(secs: number): string {
  if (secs >= 86_400) {
    const d = Math.round(secs / 86_400);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (secs >= 3_600) {
    const h = Math.round(secs / 3_600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (secs >= 60) {
    const m = Math.round(secs / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${secs} second${secs === 1 ? "" : "s"}`;
}
