import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveVaultId,
  getVaultOwnerToken,
  saveVaultMeta,
  sessionExpired,
  SESSION_TIMEOUT_MS,
  touchSession,
} from "./vaultStore";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("trusted-device inactivity lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks after ten minutes without deleting the trusted credential", () => {
    saveVaultMeta({
      id: "vault-1",
      label: "Family vault",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-07-21T00:00:00Z",
      ownerToken: "owner-token",
    });
    touchSession();

    vi.advanceTimersByTime(SESSION_TIMEOUT_MS - 1);
    expect(sessionExpired()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(sessionExpired()).toBe(true);
    expect(getActiveVaultId()).toBe("vault-1");
    expect(getVaultOwnerToken("vault-1")).toBe("owner-token");
  });

  it("starts a fresh ten-minute window after password unlock", () => {
    saveVaultMeta({
      id: "vault-2",
      label: "Family vault",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-07-21T00:00:00Z",
      ownerToken: "owner-token-2",
    });
    touchSession();
    vi.advanceTimersByTime(SESSION_TIMEOUT_MS);
    expect(sessionExpired()).toBe(true);

    touchSession();
    expect(sessionExpired()).toBe(false);
  });
});
