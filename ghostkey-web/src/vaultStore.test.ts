import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLocalUnlock,
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  hasLockedVaultCredential,
  lockVaultCredential,
  saveVaultCredentialLock,
  saveVaultMeta,
  sessionExpired,
  SESSION_TIMEOUT_MS,
  touchSession,
  unlockVaultCredentials,
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
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: memoryStorage(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the usable token with ciphertext after ten minutes", () => {
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
    expect(
      lockVaultCredential("vault-1", {
        passwordSalt: "salt",
        memKiB: 64,
        iters: 3,
        ownerTokenBlob: { v: 1, ct: "ciphertext", nonce: "nonce" },
        ownerEmailHash: "hash",
        validated: true,
      }),
    ).toBe(true);
    expect(getActiveVaultId()).toBe("vault-1");
    expect(getVaultOwnerToken("vault-1")).toBeNull();
    expect(hasLockedVaultCredential("vault-1")).toBe(true);
    expect(getVaultMeta("vault-1")?.ownerTokenLock?.ownerTokenBlob.ct).toBe(
      "ciphertext",
    );
    expect(unlockVaultCredentials({ "vault-1": "owner-token" })).toBe(true);
    expect(getVaultOwnerToken("vault-1")).toBe("owner-token");
    // The live token must survive a same-tab reload (the heir switcher
    // reloads the page), so it lives in sessionStorage — never in the
    // at-rest localStorage store.
    expect(localStorage.getItem("gk:vaults")).not.toContain("owner-token");
    expect(sessionStorage.getItem("gk:liveOwnerTokens")).toContain(
      "owner-token",
    );
  });

  it("offers a local unlock for a pre-lock vault holding only a live token", () => {
    expect(canLocalUnlock("vault-none")).toBe(false);
    saveVaultMeta({
      id: "vault-token-only",
      label: "Existing vault",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-07-21T00:00:00Z",
      ownerToken: "live-token",
    });
    // No encrypted blob yet, only the live token: still unlockable locally
    // because sign-in seeds the blob from the server bundle.
    expect(canLocalUnlock("vault-token-only")).toBe(true);

    saveVaultMeta({
      id: "vault-wallet",
      label: "Wallet vault",
      owner: { address: "xpub661MyMwAqRbcFexample" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-07-21T00:00:00Z",
      ownerToken: "wallet-owner-token",
    });
    expect(canLocalUnlock("vault-wallet")).toBe(false);

    // Once locked (token replaced by its ciphertext) it stays unlockable.
    lockVaultCredential("vault-token-only", {
      passwordSalt: "salt",
      memKiB: 64,
      iters: 3,
      ownerTokenBlob: { v: 1, ct: "ciphertext", nonce: "nonce" },
      ownerEmailHash: "hash",
      validated: true,
    });
    expect(getVaultOwnerToken("vault-token-only")).toBeNull();
    expect(canLocalUnlock("vault-token-only")).toBe(true);
    expect(canLocalUnlock(null)).toBe(false);
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

  it("never deletes a live token until its encrypted replacement is validated", () => {
    saveVaultMeta({
      id: "vault-migrate",
      label: "Existing vault",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-07-21T00:00:00Z",
      ownerToken: "live-token",
    });
    const candidate = {
      passwordSalt: "salt",
      memKiB: 64,
      iters: 3,
      ownerTokenBlob: { v: 1 as const, ct: "ciphertext", nonce: "nonce" },
      ownerEmailHash: "hash",
    };

    expect(saveVaultCredentialLock("vault-migrate", candidate)).toBe(true);
    expect(lockVaultCredential("vault-migrate", candidate)).toBe(false);
    expect(getVaultOwnerToken("vault-migrate")).toBe("live-token");

    expect(unlockVaultCredentials({ "vault-migrate": "live-token" })).toBe(
      true,
    );
    const validated = getVaultMeta("vault-migrate")!.ownerTokenLock!;
    expect(validated.validated).toBe(true);
    expect(lockVaultCredential("vault-migrate", validated)).toBe(true);
    expect(getVaultOwnerToken("vault-migrate")).toBeNull();
  });
});
