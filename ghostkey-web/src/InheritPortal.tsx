/**
 * Inherit portal.
 *
 * For the person named as the heir. They look up the savings by ID and
 * see:
 *
 *   - Whether the owner is still active (status = ok / warning).
 *   - Whether the owner has missed a reminder (alarmed).
 *   - When the owner stopped checking in, if applicable.
 *   - A friendly "When can I claim?" countdown.
 *   - Instructions on how to actually claim (run the CLI).
 *
 * The actual claim transaction is built and broadcast by the CLI; this
 * page is purely informational.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Search,
  HandHeart,
  AlertTriangle,
  Sparkles,
  CheckCircle2,
  Clock,
  Terminal,
} from "lucide-react";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";

type State =
  | { kind: "empty" }
  | { kind: "looking" }
  | { kind: "loaded"; vault: VaultView; events: VaultEvent[] }
  | { kind: "not-found"; id: string }
  | { kind: "error"; message: string };

export function InheritPortal({ initialId }: { initialId?: string }) {
  const [idInput, setIdInput] = useState(initialId ?? "");
  const [state, setState] = useState<State>({ kind: "empty" });
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function lookup() {
    const id = idInput.trim();
    if (!id) return;
    setState({ kind: "looking" });
    try {
      const v = await api.getVault(id);
      const evs = await api.listEvents(id);
      setState({ kind: "loaded", vault: v, events: evs });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setState({ kind: "not-found", id });
      } else {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return (
    <main className="bg-cream py-12 md:py-16">
      <div className="mx-auto max-w-3xl px-5 md:px-8">
        <header className="text-center">
          <p className="badge">Inherit portal</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-5xl">
            Has the time come?
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-ink-500">
            If someone named you to inherit, look up the savings
            below. We'll tell you what's happening and when you can claim.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
          className="mt-8 card p-4"
        >
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-widest text-ink-400">
              Savings ID
            </span>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="06e81655-6995-42e8-8613-d1231a8967a8"
                className="input font-mono text-sm"
              />
              <button
                type="submit"
                disabled={!idInput.trim() || state.kind === "looking"}
                className="btn-primary shrink-0"
              >
                <Search className="h-4 w-4" /> Look up
              </button>
            </div>
          </label>
        </form>

        {state.kind === "not-found" && (
          <Card title="No savings with that ID.">
            Double-check the ID and try again. You should have received it
            from the person who set things up.
          </Card>
        )}

        {state.kind === "error" && (
          <Card title="Couldn't look that up.">
            <p className="font-mono text-xs text-ink-400">{state.message}</p>
          </Card>
        )}

        {state.kind === "loaded" && (
          <InheritStatus
            vault={state.vault}
            events={state.events}
            now={now}
          />
        )}
      </div>
    </main>
  );
}

/* --------------------------- Result rendering ----------------------------- */

function InheritStatus({
  vault,
  events,
  now,
}: {
  vault: VaultView;
  events: VaultEvent[];
  now: Date;
}) {
  const deadline = useMemo(
    () => parseRfc(vault.next_deadline_at),
    [vault.next_deadline_at],
  );
  const cd = useMemo(() => countdown(deadline, now), [deadline, now]);

  // Estimate "when can I claim?" by combining the missed-deadline
  // moment with the on-chain timelock. We don't have the on-chain
  // sweep-time from the server today, so this is an upper-bound:
  //   the soonest a claim could land is the deadline-miss timestamp +
  //   timelock_blocks × ~10 minutes.
  const timelockMs = vault.timelock_blocks * 600_000; // 10 min/block
  const earliestClaim = useMemo(
    () =>
      new Date(
        Math.max(
          deadline.getTime() + timelockMs,
          // If the owner already missed the deadline, count from "now".
          // (Bitcoin's CSV restarts from each UTXO's confirmation, not
          // from a global timer — this is an approximation for the UI.)
          now.getTime(),
        ),
      ),
    [deadline, timelockMs, now],
  );
  const claimCd = useMemo(
    () => countdown(earliestClaim, now),
    [earliestClaim, now],
  );

  switch (vault.status) {
    case "ok":
    case "warning":
      return (
        <ResultCard
          tone="ok"
          eyebrow="Not yet"
          icon={CheckCircle2}
          title="The person you'll inherit from is still active."
          body={
            <>
              They last tapped "I'm OK" recently and the next reminder is{" "}
              <strong className="text-ink">{cd.friendly}</strong>. There's
              nothing to do today.
            </>
          }
          events={events}
        />
      );

    case "alarmed":
      return (
        <ResultCard
          tone="warning"
          eyebrow="Reminder missed"
          icon={AlertTriangle}
          title="They missed a reminder."
          body={
            <>
              <p>
                The owner missed their last reminder. The waiting period
                hasn't fully run yet. Earliest you can claim is{" "}
                <strong className="text-ink">{claimCd.friendly}</strong>{" "}
                (after about{" "}
                <strong className="text-ink">
                  {vault.timelock_blocks} Bitcoin blocks
                </strong>
                ).
              </p>
              <p className="mt-3">
                If this is a false alarm — e.g. they got back on track —
                this card will go quiet again automatically.
              </p>
            </>
          }
          events={events}
          claimWhen={claimCd.pretty}
        />
      );

    case "timelock_started":
      return (
        <ResultCard
          tone="alarmed"
          eyebrow="Countdown running"
          icon={Clock}
          title="The waiting period has started."
          body={
            <>
              You'll be able to claim in{" "}
              <strong className="text-ink">{claimCd.friendly}</strong>.
            </>
          }
          events={events}
          claimWhen={claimCd.pretty}
          showHowToClaim
        />
      );

    case "claimed":
      return (
        <ResultCard
          tone="neutral"
          eyebrow="Done"
          icon={Sparkles}
          title="These savings have been passed on."
          body="These savings have already been claimed."
          events={events}
        />
      );
  }
}

function ResultCard({
  tone,
  eyebrow,
  icon: Icon,
  title,
  body,
  events,
  claimWhen,
  showHowToClaim,
}: {
  tone: "ok" | "warning" | "alarmed" | "neutral";
  eyebrow: string;
  icon: typeof CheckCircle2;
  title: string;
  body: React.ReactNode;
  events: VaultEvent[];
  claimWhen?: string;
  showHowToClaim?: boolean;
}) {
  const band =
    tone === "ok"
      ? "bg-emerald-50"
      : tone === "warning"
        ? "bg-amber-50"
        : tone === "alarmed"
          ? "bg-red-50"
          : "bg-cream";
  const accent =
    tone === "ok"
      ? "text-ok"
      : tone === "warning"
        ? "text-warning"
        : tone === "alarmed"
          ? "text-alarmed"
          : "text-ink-400";
  return (
    <section className="mt-8 card overflow-hidden p-0">
      <div className={`flex items-center gap-3 px-6 py-3 ${band}`}>
        <Icon className={`h-5 w-5 ${accent}`} strokeWidth={2.25} />
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-500">
          {eyebrow}
        </p>
        {claimWhen && (
          <p className="ml-auto font-mono text-sm font-semibold text-ink">
            {claimWhen}
          </p>
        )}
      </div>

      <div className="px-6 py-8 md:px-10">
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
          {title}
        </h2>
        <div className="mt-4 max-w-prose text-base leading-relaxed text-ink-500">
          {body}
        </div>

        {showHowToClaim && <HowToClaim />}
      </div>

      <History events={events} />
    </section>
  );
}

function HowToClaim() {
  return (
    <div className="mt-6 rounded-2xl border border-bitcoin/20 bg-bitcoin-50/70 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-bitcoin-900">
        <Terminal className="h-4 w-4" /> When the countdown ends, how to claim
      </div>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-bitcoin-900">
        <li>Open the GhostKey app on your computer with your heir profile.</li>
        <li>
          Run{" "}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
            ghostkey --profile heir claim --to &lt;your-address&gt;
          </code>
          .
        </li>
        <li>
          The app will build, sign, and broadcast a transaction that moves
          the savings to an address you control. There's nothing else to do.
        </li>
      </ol>
    </div>
  );
}

function History({ events }: { events: VaultEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="border-t border-ink/5 bg-cream/50 px-6 py-4 md:px-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">
        Recent activity
      </p>
      <ol className="mt-3 space-y-2">
        {events
          .slice()
          .reverse()
          .slice(0, 6)
          .map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-3 text-xs text-ink-500"
            >
              <span className="font-medium text-ink">{friendlyKind(e.kind)}</span>
              <span className="ml-auto font-mono text-ink-300">
                {e.created_at.slice(0, 19).replace("T", " ")}
              </span>
            </li>
          ))}
      </ol>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6 card p-5">
      <div className="flex items-start gap-3">
        <HandHeart className="mt-0.5 h-5 w-5 text-ink-400" />
        <div>
          <p className="font-semibold">{title}</p>
          <div className="mt-1 text-sm text-ink-500">{children}</div>
        </div>
      </div>
    </div>
  );
}

function friendlyKind(kind: string): string {
  switch (kind) {
    case "registered": return "Created";
    case "checkin":    return "Said I'm OK";
    case "warning":    return "Reminder soon";
    case "alarm":      return "Missed reminder";
    case "resolved":   return "Back to safe";
    default:           return kind;
  }
}
