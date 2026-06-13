/**
 * Legacy check-in portal — lookup-by-vault-id.
 *
 * Reached at #/checkin-legacy. The primary cross-device entry point
 * is now SignInPortal at #/checkin (email + password). This file
 * exists for vaults created before the password flow shipped, where
 * the only way back to the vault from another browser is its UUID
 * plus the locally-cached owner_token.
 *
 * Authentication note: the server requires a per-vault owner token on
 * `getVault`, `listEvents`, and `checkin`. We read the token from the
 * device's local vault store, keyed by the vault id the user typed.
 * If the user is checking in from a device that wasn't used at setup,
 * the token won't be in localStorage and the call will fail with 401.
 * We surface that as a specific "this device doesn't have your
 * credentials" message rather than the generic "lookup failed".
 */
import { useCallback, useMemo, useState } from "react";
import {
  Button,
  Field,
  Heartbeat,
  InlineAlert,
  StatusPill,
  friendlyEventKind,
  useTicker,
  usePolling,
} from "./ui";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";
import { statusCopy } from "./vocab";
import { getVaultOwnerToken } from "./vaultStore";

type State =
  | { kind: "empty" }
  | { kind: "looking" }
  | { kind: "loaded"; vault: VaultView; events: VaultEvent[] }
  | { kind: "not-found"; id: string }
  | { kind: "no-credentials"; id: string }
  | { kind: "error"; message: string };

export function CheckinPortal({ initialId }: { initialId?: string }) {
  const [idInput, setIdInput] = useState(initialId ?? "");
  const [state, setState] = useState<State>({ kind: "empty" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);

  const now = useTicker(1000);

  const tokenFor = useCallback(
    (id: string) => getVaultOwnerToken(id.trim()),
    [],
  );

  const lookup = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setState({ kind: "looking" });
    setActionError(null);
    const token = tokenFor(trimmed);
    if (!token) {
      setState({ kind: "no-credentials", id: trimmed });
      return;
    }
    try {
      const [v, evs] = await Promise.all([
        api.getVault(trimmed, token),
        api.listEvents(trimmed, token),
      ]);
      setState({ kind: "loaded", vault: v, events: evs });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState({ kind: "no-credentials", id: trimmed });
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        setState({ kind: "not-found", id: trimmed });
      } else {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, [tokenFor]);

  // Light polling while a vault is on screen.
  const refresh = useCallback(async () => {
    if (state.kind !== "loaded") return;
    const token = tokenFor(state.vault.id);
    if (!token) return;
    try {
      const [v, evs] = await Promise.all([
        api.getVault(state.vault.id, token),
        api.listEvents(state.vault.id, token),
      ]);
      setState({ kind: "loaded", vault: v, events: evs });
    } catch {
      /* next tick */
    }
  }, [state, tokenFor]);
  usePolling(refresh, 8000, [state.kind === "loaded" ? (state as { vault: VaultView }).vault.id : ""]);

  async function onCheckin() {
    if (state.kind !== "loaded") return;
    const token = tokenFor(state.vault.id);
    setBusy(true);
    setActionError(null);
    try {
      await api.checkin(state.vault.id, token);
      await refresh();
      setJustChecked(true);
      window.setTimeout(() => setJustChecked(false), 2400);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">Check in</p>
          <h1 className="mt-6 font-serif text-3xl md:text-5xl">
            Tap to say you're still here
          </h1>
          <p className="mx-auto mt-3 max-w-md text-muted">
            Look up your vault by ID and tap once to reset the timer.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(idInput);
          }}
          className="mt-10"
        >
          <Field label="Vault ID">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="06e81655-6995-42e8-8613-..."
                className="input font-mono text-[13px]"
                spellCheck={false}
                autoComplete="off"
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
              No vault with that ID. Double-check the ID and try again.
            </InlineAlert>
          </div>
        )}

        {state.kind === "no-credentials" && (
          <div className="mt-6">
            <InlineAlert tone="warning">
              This device doesn't have the credentials for vault{" "}
              <span className="font-mono">{state.id.slice(0, 8)}…</span>.
              <br />
              If you set this vault up with a password, sign in with
              your email and password instead.{" "}
              <a
                href="#/checkin"
                className="underline hover:text-[var(--text)]"
              >
                go to sign in
              </a>
              . For legacy vaults, check in from the browser you used
              to set the vault up; the owner token only lives on that
              device.
            </InlineAlert>
          </div>
        )}

        {state.kind === "error" && (
          <div className="mt-6">
            <InlineAlert tone="alarm">{state.message}</InlineAlert>
          </div>
        )}

        {state.kind === "loaded" && (
          <Result
            vault={state.vault}
            events={state.events}
            now={now}
            busy={busy}
            justChecked={justChecked}
            actionError={actionError}
            onCheckin={onCheckin}
          />
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
  busy,
  justChecked,
  actionError,
  onCheckin,
}: {
  vault: VaultView;
  events: VaultEvent[];
  now: Date;
  busy: boolean;
  justChecked: boolean;
  actionError: string | null;
  onCheckin: () => void;
}) {
  const cd = useMemo(
    () => countdown(parseRfc(vault.next_deadline_at), now),
    [vault.next_deadline_at, now],
  );
  const copy = statusCopy(vault.status);

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

      <div className="p-8 text-center">
        <Heartbeat onTap={busy ? undefined : onCheckin} disabled={busy || vault.status === "claimed"} />

        <h2 className="mt-6 font-serif text-2xl">
          {justChecked ? "Thanks, you're safe" : copy.long}
        </h2>
        <p className="mt-2 text-sm text-muted">
          Next reminder{" "}
          <span className="text-[var(--text)] font-medium">{cd.friendly}</span>
        </p>

        {vault.status !== "claimed" && (
          <div className="mt-6">
            <Button onClick={onCheckin} loading={busy} size="lg">
              {justChecked ? "Checked in" : "I'm still here"}
            </Button>
          </div>
        )}

        {actionError ? (
          <p className="mt-4 text-sm text-alarm" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      {events.length > 0 && (
        <div className="border-t border-app bg-surface-2/40 px-6 py-4">
          <p className="text-xs uppercase tracking-wider text-dim">
            Recent activity
          </p>
          <ul role="list" className="mt-3 space-y-2 text-sm">
            {events.slice().reverse().slice(0, 5).map((e) => (
              <li key={e.id} className="flex items-center gap-3 text-muted">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    e.kind === "checkin" || e.kind === "resolved"
                      ? "bg-ok"
                      : e.kind === "alarm"
                      ? "bg-alarm"
                      : "bg-warning"
                  }`}
                />
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
