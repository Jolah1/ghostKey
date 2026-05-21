/**
 * Add-savings wizard.
 *
 * Four steps, each a single decision:
 *   1. Name it ("My retirement", "Kids' college", …)
 *   2. How often to tap "I'm OK"
 *   3. Paste the technical bits from the CLI
 *   4. Review + confirm → POST /vaults
 *
 * Step 3 is the unavoidable hard step: the server's POST /vaults
 * requires a full Taproot descriptor pair, and producing those needs
 * the offline CLI. We show clear, illustrated instructions on the page
 * so the user knows what to paste and where it comes from. Future
 * scope: add a server-side helper that derives descriptors from
 * xpubs+timelock so this step gets simpler.
 */
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Sparkles,
  Heart,
  AlertTriangle,
  X,
} from "lucide-react";
import { ApiError, api, type VaultListItem } from "./api";
import { Brand } from "./Brand";

type Network = "regtest" | "testnet" | "signet" | "bitcoin";

interface Draft {
  label: string;
  network: Network;
  /** Reminder cadence, in seconds. */
  checkinPeriodSecs: number;
  /** Grace period before alarm, in seconds. */
  gracePeriodSecs: number;
  /** Family waiting period, in blocks. */
  timelockBlocks: number;
  descriptorExternal: string;
  descriptorInternal: string;
}

const DEFAULT_DRAFT: Draft = {
  label: "",
  network: "regtest",
  checkinPeriodSecs: 7 * 86_400, // weekly
  gracePeriodSecs: 86_400,        // 1 day grace
  timelockBlocks: 1008,           // ~1 week of blocks
  descriptorExternal: "",
  descriptorInternal: "",
};

const STEPS = [
  { n: 1, key: "name", label: "Name it" },
  { n: 2, key: "timing", label: "Reminders" },
  { n: 3, key: "addresses", label: "Technical bits" },
  { n: 4, key: "review", label: "Review" },
] as const;

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
}

export function AddVaultWizard({ onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
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
    <div className="min-h-full bg-paper">
      {/* Header */}
      <header className="border-b-4 border-ink bg-paper">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-6 py-4">
          <Brand size="sm" />
          <button
            onClick={onCancel}
            className="neo-button !px-3 !py-2 text-xs"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" /> Cancel
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8 md:py-12">
        <Stepper current={step} />

        <div className="mt-10 neo-card p-6 md:p-8 animate-slide-up">
          {step === 0 && (
            <StepName draft={draft} onChange={patch} />
          )}
          {step === 1 && (
            <StepTiming draft={draft} onChange={patch} />
          )}
          {step === 2 && (
            <StepAddresses draft={draft} onChange={patch} />
          )}
          {step === 3 && <StepReview draft={draft} />}

          {error && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border-4 border-red bg-red/10 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red" />
              <p className="text-sm font-medium text-red">{error}</p>
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 flex items-center justify-between gap-3">
            {step > 0 ? (
              <button
                onClick={prev}
                disabled={busy}
                className="neo-button text-sm"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            ) : (
              <span />
            )}
            {step < STEPS.length - 1 && (
              <button onClick={next} className="neo-button-lime text-sm">
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            )}
            {step === STEPS.length - 1 && (
              <button
                onClick={submit}
                disabled={busy}
                className="neo-button-lime text-sm"
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
        </div>
      </main>
    </div>
  );
}

/* ------------------------------ Stepper ------------------------------ */

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center justify-between gap-3">
      {STEPS.map((s, i) => {
        const state =
          i < current ? "done" : i === current ? "current" : "pending";
        return (
          <li
            key={s.key}
            className="flex flex-1 items-center gap-3 last:flex-none"
          >
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-full neo-border font-display text-sm font-bold ${
                state === "done"
                  ? "bg-lime"
                  : state === "current"
                    ? "bg-lime shadow-neo-sm"
                    : "bg-paper text-muted-foreground"
              }`}
            >
              {state === "done" ? (
                <Check className="h-4 w-4" strokeWidth={3} />
              ) : (
                s.n
              )}
            </span>
            <span
              className={`hidden text-xs font-bold uppercase tracking-widest md:inline ${
                state === "pending" ? "text-muted-foreground" : "text-ink"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="flex-1 border-t-4 border-ink/20" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------ Step 1 ------------------------------ */

function StepName({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-3xl font-bold leading-tight md:text-4xl">
        Give your savings a name.
      </h2>
      <p className="mt-3 text-muted-foreground">
        Something memorable, in your own words. You can have more than one
        pot — for example one for your partner and one for your kids.
      </p>

      <div className="mt-8 space-y-5">
        <Field
          label="What should we call these savings?"
          hint="Examples: 'Family rainy day fund', 'Kids' college', 'Mom's gift'"
        >
          <input
            type="text"
            autoFocus
            maxLength={120}
            value={draft.label}
            placeholder="Family rainy day fund"
            onChange={(e) => onChange({ label: e.target.value })}
            className="neo-input"
          />
        </Field>
        <Field
          label="Which Bitcoin network?"
          hint="Use 'regtest' or 'testnet' until you've practiced. Pick 'bitcoin' only when you're ready for real money."
        >
          <select
            value={draft.network}
            onChange={(e) =>
              onChange({ network: e.target.value as Network })
            }
            className="neo-input"
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

/* ------------------------------ Step 2 ------------------------------ */

function StepTiming({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-3xl font-bold leading-tight md:text-4xl">
        How often should we remind you?
      </h2>
      <p className="mt-3 text-muted-foreground">
        Pick a rhythm that fits your life. Weekly is a good starting point.
      </p>

      <div className="mt-8 space-y-5">
        <Field
          label="Tap 'I'm OK' every"
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
          label="Family's waiting period after you stop tapping"
          hint="Once you stop completely, your family must wait this many Bitcoin blocks before they can claim. A Bitcoin block is about 10 minutes."
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

/* ------------------------------ Step 3 ------------------------------ */

function StepAddresses({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-3xl font-bold leading-tight md:text-4xl">
        Paste the technical bits.
      </h2>
      <p className="mt-3 text-muted-foreground">
        Run the GhostKey app on your computer first to create your
        password (the seed phrase) and the matching public addresses.
        Then open the file it created and paste the two lines below.
      </p>

      <div className="mt-6 neo-card bg-cyan p-4">
        <p className="text-xs font-bold uppercase tracking-widest">
          Where to find this
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm">
          <li>
            On your computer, run:{" "}
            <code className="font-mono">ghostkey ... make-vault ...</code>
          </li>
          <li>
            Open the file{" "}
            <code className="font-mono">.ghostkey/&lt;profile&gt;/vault.json</code>
          </li>
          <li>
            Copy the values of <code className="font-mono">descriptor_external</code>{" "}
            and <code className="font-mono">descriptor_internal</code> below.
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
            className="neo-input font-mono text-xs leading-snug"
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
            className="neo-input font-mono text-xs leading-snug"
          />
        </Field>
      </div>
    </div>
  );
}

/* ------------------------------ Step 4 ------------------------------ */

function StepReview({ draft }: { draft: Draft }) {
  return (
    <div>
      <h2 className="font-display text-3xl font-bold leading-tight md:text-4xl">
        Looks good?
      </h2>
      <p className="mt-3 text-muted-foreground">
        Have a quick look and tap "Create my savings" to set it live.
      </p>

      <dl className="mt-8 divide-y-2 divide-ink/10 border-y-4 border-ink">
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
          k="Family waiting period"
          v={`${draft.timelockBlocks} blocks (≈ ${prettyDuration(draft.timelockBlocks * 600)})`}
        />
      </dl>
    </div>
  );
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between py-3 text-sm">
      <dt className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {k}
      </dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

/* ------------------------------ Bits ------------------------------ */

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
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <div className="mt-2">{children}</div>
      {hint && (
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      )}
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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {presets.map((p) => {
        const selected = p.value === value;
        return (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.value)}
            className={`neo-button !px-3 !py-3 text-xs ${
              selected ? "bg-lime" : ""
            }`}
          >
            {p.label}
          </button>
        );
      })}
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
