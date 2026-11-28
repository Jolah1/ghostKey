/**
 * What this server can do, read once from `/health`, so a page never
 * offers something the server can't do yet. Locked goals are the first:
 * the home page and setup mention locking only once the server has it.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

interface ServerInfo {
  lockedGoals: boolean;
  network: string | null;
}

let info: ServerInfo | null = null;
let probing = false;
const listeners = new Set<(i: ServerInfo) => void>();

function probe() {
  if (probing || info) return;
  probing = true;
  api
    .health()
    .then((h) => {
      info = { lockedGoals: h.locked_goals_enabled === true, network: h.default_network ?? null };
    })
    .catch(() => {
      // Can't tell: stay quiet about anything we can't confirm.
      info = { lockedGoals: false, network: null };
    })
    .finally(() => {
      probing = false;
      if (info) listeners.forEach((l) => l(info as ServerInfo));
    });
}

function useServerInfo(): ServerInfo {
  const [state, setState] = useState<ServerInfo>(info ?? { lockedGoals: false, network: null });
  useEffect(() => {
    listeners.add(setState);
    probe();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** True only once the server confirms locked goals are live. */
export function useLockedGoals(): boolean {
  return useServerInfo().lockedGoals;
}

/** The server's Bitcoin network ("bitcoin", "signet", ...), or null while unknown. */
export function useServerNetwork(): string | null {
  return useServerInfo().network;
}

/** For tests: forget what the last probe said. */
export function resetServerInfoForTests(): void {
  info = null;
  probing = false;
}
