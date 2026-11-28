/**
 * Use this vault in another wallet (#387).
 *
 * The vault's public descriptors, for Liana (one multipath descriptor;
 * the new format only) and Bitcoin Core (any format). They let another
 * wallet see the savings and their addresses, which is what proves the
 * money isn't trapped in GhostKey. They can't spend: that still needs the
 * key. Before anything shows, this device checks the export is the vault
 * it pinned (#378): the same addresses, not just the server's word.
 */
import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Route } from "./App";
import { ApiError, api } from "./api";
import { PageShell } from "./PageShell";
import { Button } from "./ui";
import { useActiveVault } from "./useActiveVault";
import { sameVault, trustedDescriptors } from "./vaultUpgrade";

type Export = Awaited<ReturnType<typeof api.getExport>>;

/** `tr(K/<0;1>/*,...)#sum` -> the receive and change halves, for checking. */
export function splitMultipath(d: string): { external: string; internal: string } {
  const bare = d.replace(/#[a-z0-9]+$/, "");
  return { external: bare.replaceAll("/<0;1>/*", "/0/*"), internal: bare.replaceAll("/<0;1>/*", "/1/*") };
}

function CopyBox({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-[var(--text-body)]">{label}</span>
      <pre
        data-testid={testId}
        className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[14px] border border-app bg-[var(--bg-elev)] p-3 font-mono text-xs text-[var(--text)]"
      >
        {text}
      </pre>
      <Button
        variant="ghost"
        className="min-h-11 self-start px-4 text-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // The text is on screen to select by hand.
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function ExportPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const { activeId, ownerToken, vault, loading } = useActiveVault();
  const [data, setData] = useState<Export | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId || !ownerToken || !vault) return;
    let live = true;
    api
      .getExport(activeId, ownerToken)
      .then((x) => {
        if (!live) return;
        // The vault this device pinned, and the one being exported, must
        // give the same addresses.
        const mine = trustedDescriptors(activeId, vault, vault.network);
        const theirs = { external: x.descriptor_external, internal: x.descriptor_internal };
        const ok =
          mine != null &&
          sameVault(mine, theirs, x.network) &&
          (!x.liana_descriptor || sameVault(mine, splitMultipath(x.liana_descriptor), x.network));
        if (ok) setData(x);
        else setError("This doesn't match your vault, so it isn't shown. Please contact support.");
      })
      .catch((e) => live && setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeId, ownerToken, vault]);

  const qr = useMemo(() => {
    if (!data?.liana_descriptor) return null;
    const q = qrcode(0, "L");
    q.addData(data.liana_descriptor);
    q.make();
    return q.createDataURL(3, 8);
  }, [data]);

  const coreCommands = data
    ? `createwallet "ghostkey-watch" true true "" false true\nimportdescriptors '${data.core_import}'`
    : "";

  return (
    <PageShell title="Use this vault in another wallet" onNavigate={onNavigate} onBack={() => onNavigate("recovery")} backLabel="Back">
      <div className="flex flex-col gap-6">
        <p className="m-0 rounded-[16px] border border-[var(--card-outline)] bg-surface p-4 text-base text-[var(--text-body)]">
          <strong className="text-[var(--text)]">This lets another wallet see your savings, not spend them.</strong> Spending
          still needs your key, which stays in GhostKey and your recovery file.
        </p>

        {loading || (!data && !error) ? <p className="m-0 text-sm text-muted">Loading…</p> : null}
        {error ? (
          <p className="m-0 text-sm text-alarm" role="alert">
            {error}
          </p>
        ) : null}

        {data ? (
          <>
            <section aria-labelledby="liana-h" className="flex flex-col gap-3">
              <h2 id="liana-h" className="m-0 text-lg font-bold text-[var(--text)]">
                Liana
              </h2>
              {data.liana_descriptor ? (
                <>
                  <ol className="m-0 flex flex-col gap-1 pl-5 text-[15px] text-[var(--text-body)]">
                    <li>In Liana, add a wallet and choose to import an existing one.</li>
                    <li>Paste this, or scan the code.</li>
                  </ol>
                  <CopyBox label="Wallet descriptor" text={data.liana_descriptor} testId="liana-descriptor" />
                  {qr ? (
                    <img
                      src={qr}
                      alt="QR code of the wallet descriptor"
                      className="w-full max-w-[320px] self-center rounded-[12px] bg-white p-2"
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    className="min-h-11 self-start px-4 text-sm"
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([data.liana_descriptor! + "\n"], { type: "text/plain" }));
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "ghostkey-vault-descriptor.txt";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download as a file
                  </Button>
                </>
              ) : data.format === "legacy" ? (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-[15px] text-[var(--text-body)]">
                    Liana can&apos;t open this older vault format. Move to the new format first, then come back.
                  </p>
                  <Button className="min-h-11 self-start px-4 text-sm" onClick={() => onNavigate("upgrade")}>
                    Move to the new format
                  </Button>
                </div>
              ) : (
                <p className="m-0 text-[15px] text-[var(--text-body)]">
                  Liana can&apos;t open a locked goal. Bitcoin Core can.
                </p>
              )}
            </section>

            <section aria-labelledby="core-h" className="flex flex-col gap-3">
              <h2 id="core-h" className="m-0 text-lg font-bold text-[var(--text)]">
                Bitcoin Core
              </h2>
              <ol className="m-0 flex flex-col gap-1 pl-5 text-[15px] text-[var(--text-body)]">
                <li>Open Window, then Console (or use bitcoin-cli).</li>
                <li>Run these two lines. The second one looks back through the chain, which can take a while.</li>
              </ol>
              <CopyBox label="Commands" text={coreCommands} testId="core-commands" />
            </section>
          </>
        ) : null}
      </div>
    </PageShell>
  );
}
