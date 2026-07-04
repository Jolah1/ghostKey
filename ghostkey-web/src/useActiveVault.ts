/**
 * Bootstraps the active vault for the secondary "tool" pages (heir
 * message, practice run, emergency, reminders) that used to be cards on
 * the dashboard.
 *
 * Each page needs the same handful of things the dashboard already
 * derives: the active vault id + local metadata, the owner token, the
 * server-side vault view (for status / lnurl_panic / trusted contact),
 * and the push VAPID key from /health. This hook fetches them once so
 * every tool page stays a thin wrapper around its existing card.
 */
import { useEffect, useMemo, useState } from "react";

import { api, type VaultView } from "./api";
import {
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  type VaultMeta,
} from "./vaultStore";

export interface ActiveVault {
  activeId: string | null;
  meta: VaultMeta | null;
  ownerToken: string | null;
  vault: VaultView | null;
  /** VAPID public key from /health, or null when push isn't configured. */
  pushKey: string | null;
  loading: boolean;
}

export function useActiveVault(): ActiveVault {
  const activeId = useMemo(() => getActiveVaultId(), []);
  const meta = useMemo(
    () => (activeId ? getVaultMeta(activeId) : null),
    [activeId],
  );
  const ownerToken = useMemo(
    () => (activeId ? getVaultOwnerToken(activeId) : null),
    [activeId],
  );

  const [vault, setVault] = useState<VaultView | null>(null);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!activeId) {
      setLoading(false);
      return;
    }
    Promise.all([
      api.getVault(activeId, ownerToken).catch(() => null),
      api
        .health()
        .then((h) => h.push_public_key ?? null)
        .catch(() => null),
    ]).then(([v, pk]) => {
      if (!alive) return;
      setVault(v);
      setPushKey(pk);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [activeId, ownerToken]);

  return { activeId, meta, ownerToken, vault, pushKey, loading };
}
