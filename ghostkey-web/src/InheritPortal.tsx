/**
 * Inherit portal.
 *
 * For the person named to inherit. They look up the vault by ID and
 * see what's happening. The actual claim transaction is built and
 * broadcast off-site (today, via the CLI). This page is purely
 * informational.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Button,
  Field,
  InlineAlert,
  StatusPill,
  friendlyEventKind,
  useTicker,
} from "./ui";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";
import { statusCopy } from "./vocab";

type State =
  | { kind: "empty" }
  | { kind: "looking" }
  | { kind: "loaded"; vault: VaultView; events: VaultEvent[] }
  | { kind: "not-found"; id: string }
  | { kind: "error"; message: string };

export function InheritPortal({ initialId }: { initialId?: string }) {
  const [idInput, setIdInput] = useState(initialId ?? "");
  const [state, setState] = useState<State>({ kind: "empty" });
  const now = useTicker(1000);

  const lookup = useCallback(async () => {
    const id = idInput.trim();
    if (!id) return;
    setState({ kind: "looking" });
    try {
      const [v, evs] = await Promise.all([
        api.getVault(id),
        api.listEvents(id),
      ]);
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
  }, [idInput]);

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">Inherit</p>
          <h1 className="mt-6 font-serif text-3xl md:text-5xl">
            Someone left you something
          </h1>
          <p className="mx-auto mt-3 max-w-md text-muted">
            If someone named you, look up the vault below. We'll tell you what's
            happening and when you can claim.
          </p>
        </header>

        <form
          onSubmit={(e) => { e.preventDefault(); void lookup(); }}
          className="mt-10"
        >
          <Field label="Vault ID">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="06e81655-6995-42e8-8613-..."
                spellCheck={false}
                autoComplete="off"
                className="input font-mono text-[13px]"
              />
              <Button
                type="submit"
                disabled={!idInput.trim() || state.kind === "looking"}
                loading={state.kind === "looking"}
              >
                Look up
              </Button>
            </div>
          </Field>
        </form>

        {state.kind === "not-found" && (
          <div className="mt-6">
            <InlineAlert tone="warning">
              No vault with that ID. You should have received the ID from the
              person who set things up.
            </InlineAlert>
          </div>
        )}
        {state.kind === "error" && (
          <div className="mt-6">
            <InlineAlert tone="alarm">{state.message}</InlineAlert>
          </div>
        )}

        {state.kind === "loaded" && (
          <Result vault={state.vault} events={state.events} now={now} />
        )}
      </div>
    </main>
  );
}

/* --------------------------------- Result --------------------------------- */

function Result({
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

  // Soonest claim is deadline + timelock blocks at ~10 min/block.
  const earliestClaim = useMemo(
    () =>
      new Date(
        Math.max(
          deadline.getTime() + vault.timelock_blocks * 600_000,
          now.getTime(),
        ),
      ),
    [deadline, vault.timelock_blocks, now],
  );
  const claimCd = useMemo(
    () => countdown(earliestClaim, now),
    [earliestClaim, now],
  );

  const copy = statusCopy(vault.status);

  const headline =
    vault.status === "ok" || vault.status === "warning"
      ? "They're still here"
      : vault.status === "alarmed"
      ? "A reminder was missed"
      : vault.status === "timelock_started"
      ? "The waiting period has started"
      : "This has been claimed";

  const body =
    vault.status === "ok" || vault.status === "warning" ? (
      <>
        They tapped recently. The next reminder is{" "}
        <strong className="text-[var(--text)]">{cd.friendly}</strong>. There's
        nothing for you to do today.
      </>
    ) : vault.status === "alarmed" ? (
      <>
        They missed their last reminder. The waiting period hasn't fully run yet.
        The earliest you can claim is{" "}
        <strong className="text-[var(--text)]">{claimCd.friendly}</strong>.
        If they tap back in, this card will go quiet again on its own.
      </>
    ) : vault.status === "timelock_started" ? (
      <>
        You'll be able to claim in{" "}
        <strong className="text-[var(--text)]">{claimCd.friendly}</strong>.
      </>
    ) : (
      <>This vault has already been claimed.</>
    );

  return (
    <section className="mt-8 card overflow-hidden p-0">
      <div
        className="flex items-center justify-between gap-3 border-b border-app px-6 py-3"
        style={{
          background:
            copy.tone === "ok" ? "var(--ok-tint)"
            : copy.tone === "warning" ? "var(--warning-tint)"
            : copy.tone === "alarm" ? "var(--alarm-tint)"
            : "var(--surface-2)",
        }}
      >
        <p className="text-xs uppercase tracking-wider text-muted">
          {vault.label ?? "Vault"}
        </p>
        <StatusPill tone={copy.tone} label={copy.label} />
      </div>

      <div className="px-6 py-8 md:px-10">
        <h2 className="font-serif text-3xl md:text-4xl">{headline}</h2>
        <p className="mt-4 max-w-prose text-muted">{body}</p>

        {vault.status === "timelock_started" && <HowToClaim />}
      </div>

      {events.length > 0 && (
        <div className="border-t border-app bg-surface-2/40 px-6 py-4 md:px-10">
          <p className="text-[11px] uppercase tracking-wider text-dim">
            Recent activity
          </p>
          <ul role="list" className="mt-3 space-y-2 text-sm">
            {events.slice().reverse().slice(0, 6).map((e) => (
              <li key={e.id} className="flex items-center gap-3 text-muted">
                <span className="flex-1 text-[var(--text)]">
                  {friendlyEventKind(e.kind)}
                </span>
                <span className="font-mono text-[11px] text-dim">
                  {e.created_at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function HowToClaim() {
  return (
    <div
      className="mt-6 rounded-xl border border-app p-4"
      style={{ background: "var(--accent-tint)" }}
    >
      <p className="text-xs uppercase tracking-wider text-accent font-medium">
        How to claim
      </p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-[var(--text)]">
        <li>Open the GhostKey app on your computer.</li>
        <li>
          Run{" "}
          <code className="rounded bg-bg-elev px-1.5 py-0.5 font-mono text-xs font-semibold">
            ghostkey claim --to &lt;your-address&gt;
          </code>
          .
        </li>
        <li>
          The app builds, signs, and broadcasts the transaction for you.
        </li>
      </ol>
    </div>
  );
}
