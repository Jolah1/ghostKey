/**
 * Recovery kit page (reached from the nav).
 *
 * Lets a signed-in owner download their spare key file. Loads the
 * active vault so the file carries the right descriptors, then hands
 * off to `downloadIndependenceProof`. Kept off the dashboard so that
 * screen stays calm.
 */
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
    setState({ kind: "busy" });
    try {
      const { downloadIndependenceProof } = await import("./independenceProof");
      await downloadIndependenceProof(vault);
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
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-md px-5 py-12 md:py-16">
        <header>
          <p className="eyebrow">Recovery kit</p>
          <h1 className="mt-4 font-serif text-3xl">Your spare key</h1>
          <p className="mt-3 text-sm text-muted">
            A backup of your key, for emergencies. Save a copy somewhere safe
            like your email or a USB stick. If you ever can't get into GhostKey,
            open it and type your password to reach your money.
          </p>
        </header>

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
                Without your password the file gives nothing away. It does show
                your balance though, so keep it private.
              </p>
            ) : null}
            {state.kind === "error" ? (
              <p className="mt-3 text-xs text-amber-200">{state.message}</p>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
