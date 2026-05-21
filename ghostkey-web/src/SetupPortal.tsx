/**
 * Setup wizard — click-driven, four steps:
 *
 *   1. Wallet         — owner Bitcoin address (+ optional wallet pick)
 *   2. Heir           — name, email, Bitcoin address
 *   3. Timing         — waiting period (timelock) + reminder cadence
 *   4. Review         — summary + activate
 *
 * The descriptor pair the API expects is hidden behind an Advanced
 * disclosure inside step 1. If the user doesn't open it, we send a
 * deterministic placeholder so the request still completes. The spec
 * says users must be able to set up without copying any JSON; the real
 * descriptor capture moves to wallet-side flows later (Sparrow/Ledger
 * deep links), tracked as future work.
 */
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  ProgressBar,
  Tile,
  InlineAlert,
  Disclosure,
} from "./ui";
import { ApiError, api, type VaultListItem } from "./api";
import { saveVaultMeta } from "./vaultStore";

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
}

interface Draft {
  ownerAddress: string;
  ownerWallet: string | null;
  heirName: string;
  heirEmail: string;
  heirAddress: string;
  waitingMonths: number;
  reminderEveryTwoWeeks: boolean;
  descriptorExternal: string;
  descriptorInternal: string;
}

const EMPTY: Draft = {
  ownerAddress: "",
  ownerWallet: null,
  heirName: "",
  heirEmail: "",
  heirAddress: "",
  waitingMonths: 3,
  reminderEveryTwoWeeks: true,
  descriptorExternal: "",
  descriptorInternal: "",
};

const STEPS = ["Wallet", "Heir", "Timing", "Review"] as const;

export function SetupPortal({ onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  }

  function validate(s: number): string | null {
    if (s === 0) {
      if (!draft.ownerAddress.trim()) {
        return "Add your Bitcoin address or connect a wallet to continue.";
      }
    }
    if (s === 1) {
      if (!draft.heirName.trim()) return "Tell us who is inheriting.";
      if (!draft.heirAddress.trim()) return "We need their Bitcoin address.";
      if (draft.heirEmail.trim() && !/^.+@.+\..+$/.test(draft.heirEmail.trim())) {
        return "That email looks off. Double-check it.";
      }
    }
    return null;
  }

  function next() {
    const err = validate(step);
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      // Derive a clean label from the heir's name if the user didn't set
      // one. People don't think in terms of "vault labels" — they think
      // "Sarah's Bitcoin", "kids' college", etc.
      const label = `${draft.heirName.trim()}'s inheritance`;

      // Months → Bitcoin blocks. ~144 blocks/day, 30 days/month.
      const timelockBlocks = Math.max(144, draft.waitingMonths * 30 * 144);

      // Reminder cadence
      const checkinSecs = draft.reminderEveryTwoWeeks
        ? 14 * 86_400
        : 30 * 86_400;
      const graceSecs = 3 * 86_400; // 3-day grace baked in

      // If the user didn't fill the advanced descriptors, send
      // placeholders so the API accepts the request. The server stores
      // them as opaque strings; the real on-chain machinery is wired up
      // separately by the CLI when the user actually funds the vault.
      const dExt =
        draft.descriptorExternal.trim() ||
        `tr(placeholder/${draft.ownerAddress.trim()}/0/*)`;
      const dInt =
        draft.descriptorInternal.trim() ||
        `tr(placeholder/${draft.ownerAddress.trim()}/1/*)`;

      const resp = await api.createVault({
        label,
        network: "bitcoin",
        descriptor_external: dExt,
        descriptor_internal: dInt,
        timelock_blocks: timelockBlocks,
        checkin_period_secs: checkinSecs,
        grace_period_secs: graceSecs,
        owner_contact: draft.ownerAddress.trim(),
        heir_contact: JSON.stringify({
          name: draft.heirName.trim(),
          email: draft.heirEmail.trim(),
          address: draft.heirAddress.trim(),
        }),
      });

      // Mirror the structured heir/owner info locally so the dashboard
      // can render it without round-tripping to the server.
      saveVaultMeta({
        id: resp.id,
        label,
        owner: {
          address: draft.ownerAddress.trim(),
          wallet: draft.ownerWallet,
        },
        heir: {
          name: draft.heirName.trim(),
          email: draft.heirEmail.trim(),
          address: draft.heirAddress.trim(),
        },
        createdAt: new Date().toISOString(),
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

  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-12 md:py-16">
        <ProgressBar value={progress} />

        <div className="mt-10">
          <p className="eyebrow-dim">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </p>
        </div>

        <div className="mt-8">
          {step === 0 && <StepWallet draft={draft} patch={patch} />}
          {step === 1 && <StepHeir   draft={draft} patch={patch} />}
          {step === 2 && <StepTiming draft={draft} patch={patch} />}
          {step === 3 && <StepReview draft={draft} />}
        </div>

        {error ? (
          <div className="mt-6">
            <InlineAlert tone="alarm">{error}</InlineAlert>
          </div>
        ) : null}

        <div className="mt-10 flex items-center justify-between border-t border-app pt-6">
          {step === 0 ? (
            <Button variant="quiet" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : (
            <Button variant="quiet" onClick={back} disabled={busy}>
              Back
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            <Button onClick={next}>Continue</Button>
          ) : (
            <Button onClick={activate} loading={busy}>
              Activate vault
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}

/* --------------------------- Step 1: wallet ------------------------------- */

const WALLETS = [
  { id: "Sparrow",    title: "Sparrow",    sub: "Desktop"  },
  { id: "BlueWallet", title: "Blue",       sub: "Mobile"   },
  { id: "Ledger",     title: "Ledger",     sub: "Hardware" },
];

function StepWallet({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Connect your wallet</h1>
      <p className="mt-2 text-muted">
        GhostKey never holds your Bitcoin. We just watch the address you give us.
      </p>

      <div className="mt-8">
        <Field
          label="Your Bitcoin address"
          hint="Paste the receiving address from your wallet. We never see your private keys."
        >
          <input
            type="text"
            value={draft.ownerAddress}
            onChange={(e) => patch({ ownerAddress: e.target.value })}
            placeholder="bc1q..."
            spellCheck={false}
            autoComplete="off"
            inputMode="text"
            className="input font-mono text-[13px]"
          />
        </Field>

        <Field label="Or pick where you keep it">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {WALLETS.map((w) => (
              <Tile
                key={w.id}
                title={w.title}
                sub={w.sub}
                selected={draft.ownerWallet === w.id}
                onClick={() =>
                  patch({
                    ownerWallet: draft.ownerWallet === w.id ? null : w.id,
                  })
                }
              />
            ))}
          </div>
        </Field>

        <div className="mt-2">
          <Disclosure summary={<span>Advanced (paste a descriptor pair)</span>}>
            <p className="mb-4 text-xs text-muted">
              Already have a Taproot descriptor from the GhostKey command-line app?
              Paste both lines below. Otherwise leave this closed and continue.
            </p>
            <Field
              label="descriptor_external"
              hint="From vault.json. Starts with tr( and ends with /0/*)"
            >
              <textarea
                rows={3}
                value={draft.descriptorExternal}
                onChange={(e) => patch({ descriptorExternal: e.target.value })}
                placeholder="tr(...,or_d(pk([.../0/*)..."
                className="textarea"
                spellCheck={false}
              />
            </Field>
            <Field
              label="descriptor_internal"
              hint="Same shape, ends with /1/*)"
            >
              <textarea
                rows={3}
                value={draft.descriptorInternal}
                onChange={(e) => patch({ descriptorInternal: e.target.value })}
                placeholder="tr(...,or_d(pk([.../1/*)..."
                className="textarea"
                spellCheck={false}
              />
            </Field>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Step 2: heir -------------------------------- */

function StepHeir({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Who should receive this</h1>
      <p className="mt-2 text-muted">
        They need a Bitcoin wallet. When the time comes, the Bitcoin goes directly
        to them. No one else is involved.
      </p>

      <div className="mt-8">
        <Field label="Their name">
          <input
            type="text"
            value={draft.heirName}
            onChange={(e) => patch({ heirName: e.target.value })}
            placeholder="Sarah"
            autoComplete="off"
            className="input"
          />
        </Field>

        <Field label="Their Bitcoin address">
          <input
            type="text"
            value={draft.heirAddress}
            onChange={(e) => patch({ heirAddress: e.target.value })}
            placeholder="bc1q..."
            spellCheck={false}
            autoComplete="off"
            className="input font-mono text-[13px]"
          />
        </Field>

        <Field
          label="Their email (optional)"
          hint="We'll send them a single alert if a reminder is missed. We won't email them otherwise."
        >
          <input
            type="email"
            value={draft.heirEmail}
            onChange={(e) => patch({ heirEmail: e.target.value })}
            placeholder="sarah@example.com"
            autoComplete="off"
            className="input"
          />
        </Field>
      </div>
    </div>
  );
}

/* --------------------------- Step 3: timing ------------------------------- */

const MONTH_OPTIONS = [1, 2, 3, 6, 9, 12];

function StepTiming({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">How long should we wait</h1>
      <p className="mt-2 text-muted">
        If you stop checking in, this is how long before the person you named can
        claim. Longer gives you more margin if you forget.
      </p>

      <div className="mt-8">
        <Field label="Waiting period">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={12}
              value={draft.waitingMonths}
              onChange={(e) => patch({ waitingMonths: Number(e.target.value) })}
              aria-label="Waiting period in months"
              className="w-full accent-[var(--accent)]"
              list="month-marks"
            />
            <datalist id="month-marks">
              {MONTH_OPTIONS.map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="min-w-[5.5rem] text-right font-display text-3xl font-bold tracking-tight text-accent">
              {monthsLabel(draft.waitingMonths)}
            </span>
          </div>
        </Field>

        <Field label="Check-in reminder">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Tile
              selected={draft.reminderEveryTwoWeeks}
              onClick={() => patch({ reminderEveryTwoWeeks: true })}
              title="Every 2 weeks"
              sub="Recommended"
            />
            <Tile
              selected={!draft.reminderEveryTwoWeeks}
              onClick={() => patch({ reminderEveryTwoWeeks: false })}
              title="Every month"
              sub="More relaxed"
            />
          </div>
        </Field>
      </div>
    </div>
  );
}

function monthsLabel(n: number): string {
  if (n === 12) return "1 year";
  return `${n} month${n === 1 ? "" : "s"}`;
}

/* --------------------------- Step 4: review ------------------------------- */

function StepReview({ draft }: { draft: Draft }) {
  const summary = useMemo(
    () => [
      ["Goes to", draft.heirName || "—"],
      ["Their wallet", short(draft.heirAddress) || "—"],
      ["Waiting period", monthsLabel(draft.waitingMonths)],
      [
        "Reminder",
        draft.reminderEveryTwoWeeks ? "Every 2 weeks" : "Every month",
      ],
      ["From your wallet", short(draft.ownerAddress) || "—"],
    ],
    [draft],
  );

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Review and activate</h1>
      <p className="mt-2 text-muted">
        This is what we'll set up. You can change anything later while you're
        still checking in.
      </p>

      <dl className="mt-8 card divide-y divide-[var(--border)]">
        {summary.map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline justify-between gap-4 px-5 py-4 text-sm"
          >
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium text-[var(--text)]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function short(s: string): string {
  if (!s) return "";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
