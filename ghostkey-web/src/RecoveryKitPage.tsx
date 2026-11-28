/**
 * Recovery kit page (reached from the nav).
 *
 * Lets a signed-in owner download their spare key file. Loads the
 * active vault so the file carries the right descriptors, then hands
 * off to `downloadIndependenceProof`. Kept off the dashboard so that
 * screen stays calm.
 */
import { PageShell } from "./PageShell";
import { useEffect, useState } from "react";

import { Button } from "./ui";
import { ApiError, api, type VaultView } from "./api";
import { getActiveVaultId, getVaultOwnerToken } from "./vaultStore";
import type { Route } from "./App";

interface Props {
  onNavigate: (r: Route) => void;
}

export function RecoveryKitPage({ onNavigate }: Props) {
  const [vault, setVault] = useState<VaultView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    const id = getActiveVaultId();
    if (!id) {
      setLoadError("none");
      return;
    }
    api
      .getVault(id, getVaultOwnerToken(id))
      .then(setVault)
      .catch((e) =>
        setLoadError(e instanceof ApiError ? e.message : String(e)),
      );
  }, []);

  async function onDownload() {
    if (!vault) return;
    const ownerToken = getVaultOwnerToken(vault.id);
    if (!ownerToken) {
      setState({ kind: "error", message: "Sign in again before downloading your recovery file." });
      return;
    }
    setState({ kind: "busy" });
    try {
      const { downloadIndependenceProof } = await import("./independenceProof");
      await downloadIndependenceProof(vault, ownerToken);
      setState({ kind: "done" });
    } catch (e) {
      setState({
        kind: "error",
        message:
          e instanceof ApiError && e.status === 400
            ? "This vault was made before recovery files existed, so one can't be created for it."
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }

  return (
    <PageShell
      title="Your spare key"
      intro="It reaches your money even without GhostKey. Keep it offline, like on a USB stick or a printout, in more than one place."
      onNavigate={onNavigate}
    >

        {loadError === "none" ? (
          <div className="mt-8">
            <p className="text-sm text-muted">
              Sign in to your vault first, then come back here.
            </p>
            <div className="mt-4">
              <Button onClick={() => onNavigate("checkin")}>Sign in</Button>
            </div>
          </div>
        ) : loadError ? (
          <p className="mt-8 text-sm text-alarm">{loadError}</p>
        ) : !vault ? (
          <p className="mt-8 text-sm text-muted">Loading your vault…</p>
        ) : (
          <div className="mt-8">
            <Button onClick={() => void onDownload()} disabled={state.kind === "busy"}>
              {state.kind === "busy"
                ? "Preparing"
                : state.kind === "done"
                  ? "Saved. Download again"
                  : "Download recovery file"}
            </Button>
            {state.kind === "done" ? (
              <p className="mt-3 text-xs text-dim">
                Saved. Keep it somewhere you'll still have access to in years to
                come. Without your password the file gives nothing away, but it
                does show your balance, so keep it private.
              </p>
            ) : null}
            {state.kind === "error" ? (
              <p className="mt-3 text-sm text-alarm">{state.message}</p>
            ) : null}
          </div>
        )}

        <section className="mt-10 rounded-[20px] border border-app bg-surface p-5" aria-labelledby="gone-h">
          <h2 id="gone-h" className="m-0 text-base font-bold text-[var(--text)]">
            If GhostKey is gone
          </h2>
          <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
            {["Open the file in any browser, even offline.", "Type your password.", "Send the bitcoin to any wallet."].map((t, i) => (
              <li key={t} className="flex items-center gap-3 text-[15px] text-[var(--text-body)]">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-sm font-bold">
                  {i + 1}
                </span>
                {t}
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => onNavigate("recovery-guide")}
            className="mt-4 text-[15px] font-semibold text-[var(--accent-text)] underline underline-offset-2"
          >
            Read the full guide
          </button>
        </section>

        <button
          type="button"
          onClick={() => onNavigate("export")}
          data-testid="export-link"
          className="mt-5 flex w-full items-center gap-3 rounded-[20px] border border-app bg-surface px-4 py-4 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold text-[var(--text)]">Use this vault in another wallet</span>
            <span className="block text-sm text-[var(--text-body)]">See your savings in Liana or Bitcoin Core too.</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-lg text-dim">
            ›
          </span>
        </button>
    </PageShell>
  );
}
