/**
 * The dashboard: hero (most-urgent vault) + grid of secondary vaults.
 *
 * Vault detail is fetched per-card and cached at this level so the hero
 * and any opened drawer share state.
 *
 * "Most urgent" is defined as the smallest `next_deadline_at` ts.
 */
import { useEffect, useState } from "react";
import { Plus, Info } from "lucide-react";
import { Brand } from "./Brand";
import { VaultHero } from "./VaultHero";
import { VaultCard } from "./VaultCard";
import { DetailDrawer } from "./DetailDrawer";
import {
  ApiError,
  api,
  type VaultListItem,
  type VaultView,
} from "./api";

interface Props {
  vaults: VaultListItem[];
  onAddVault: () => void;
  onShowLanding: () => void;
  /** Force a server poll. */
  onRefresh: () => void;
}

export function Dashboard({
  vaults,
  onAddVault,
  onShowLanding,
  onRefresh,
}: Props) {
  // Cache of per-vault detail, keyed by id.
  const [details, setDetails] = useState<Record<string, VaultView>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [openDrawerFor, setOpenDrawerFor] = useState<string | null>(null);

  // Fetch detail for any vault we don't have detail for yet, and
  // re-fetch any whose deadline/status has shifted since last seen.
  useEffect(() => {
    let alive = true;
    for (const v of vaults) {
      const cached = details[v.id];
      const stale =
        !cached ||
        cached.next_deadline_at !== v.next_deadline_at ||
        cached.status !== v.status;
      if (!stale) continue;
      api
        .getVault(v.id)
        .then((d) => {
          if (!alive) return;
          setDetails((cur) => ({ ...cur, [v.id]: d }));
          setDetailErrors((cur) => {
            const { [v.id]: _gone, ...rest } = cur;
            return rest;
          });
        })
        .catch((e) => {
          if (!alive) return;
          setDetailErrors((cur) => ({
            ...cur,
            [v.id]: e instanceof ApiError ? e.message : String(e),
          }));
        });
    }
    return () => {
      alive = false;
    };
  }, [vaults, details]);

  const sorted = [...vaults].sort((a, b) =>
    a.next_deadline_at.localeCompare(b.next_deadline_at),
  );
  const [primary, ...rest] = sorted;

  return (
    <div className="min-h-full bg-paper">
      <Header onAddVault={onAddVault} onShowLanding={onShowLanding} />

      <main className="mx-auto max-w-6xl px-6 py-8 md:py-12">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="font-display text-2xl font-bold md:text-3xl">
            Your family savings
          </h1>
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {vaults.length} pot{vaults.length === 1 ? "" : "s"}
          </p>
        </div>

        {primary && (
          <VaultHero
            summary={primary}
            detail={details[primary.id] ?? null}
            onAfterCheckin={onRefresh}
            onOpenDetails={() => setOpenDrawerFor(primary.id)}
          />
        )}

        {rest.length > 0 && (
          <section className="mt-12">
            <h2 className="font-display text-lg font-bold uppercase tracking-widest text-muted-foreground">
              Other family savings
            </h2>
            <ul className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
              {rest.map((v) => (
                <li key={v.id}>
                  <VaultCard
                    summary={v}
                    detail={details[v.id] ?? null}
                    onOpen={() => setOpenDrawerFor(v.id)}
                    onAfterCheckin={onRefresh}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {Object.entries(detailErrors).length > 0 && (
          <div className="mt-8 neo-card bg-yellow p-4">
            <p className="text-sm font-bold">
              Some details couldn't be loaded
            </p>
            <ul className="mt-1 text-xs">
              {Object.entries(detailErrors).map(([id, msg]) => (
                <li key={id}>
                  <span className="font-mono">{id.slice(0, 8)}</span>: {msg}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      {openDrawerFor && details[openDrawerFor] && (
        <DetailDrawer
          vault={details[openDrawerFor]!}
          onClose={() => setOpenDrawerFor(null)}
        />
      )}
    </div>
  );
}

function Header({
  onAddVault,
  onShowLanding,
}: {
  onAddVault: () => void;
  onShowLanding: () => void;
}) {
  return (
    <header className="border-b-4 border-ink bg-paper">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
        <Brand size="sm" />
        <div className="flex items-center gap-2">
          <button
            onClick={onShowLanding}
            className="neo-button hidden md:inline-flex !px-3 !py-2 text-xs"
            aria-label="About"
          >
            <Info className="h-4 w-4" /> About
          </button>
          <button
            onClick={onAddVault}
            className="neo-button-lime !px-3 !py-2 text-xs md:text-sm"
          >
            <Plus className="h-4 w-4" /> Add savings
          </button>
        </div>
      </div>
    </header>
  );
}
