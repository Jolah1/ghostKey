import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { checkInAfterSignIn, fanOutCheckin } from "./checkin";

describe("fanOutCheckin", () => {
  it("keeps going after a heir refuses, and reports the tally", async () => {
    // The claimed heir sits FIRST: the bug this guards against was a
    // fan-out that stopped on the first refusal, leaving the live heirs
    // behind it with a clock nobody reset.
    const tried: string[] = [];
    const tally = await fanOutCheckin(["claimed", "live-1", "live-2"], async (id) => {
      tried.push(id);
      return id === "claimed" ? "skipped" : "checked-in";
    });

    expect(tried).toEqual(["claimed", "live-1", "live-2"]);
    expect(tally).toEqual({ checkedIn: 2, skipped: 1, hardError: null });
  });

  it("reports only the first hard error, and still tries every heir", async () => {
    const tried: string[] = [];
    const tally = await fanOutCheckin(["a", "b", "c"], async (id) => {
      tried.push(id);
      if (id === "a") return { error: "first" };
      if (id === "b") return { error: "second" };
      return "checked-in";
    });

    expect(tried).toEqual(["a", "b", "c"]);
    expect(tally).toEqual({ checkedIn: 1, skipped: 0, hardError: "first" });
  });

  it("tallies a single-heir vault that had nothing to do", async () => {
    const tally = await fanOutCheckin(["only"], async () => "skipped");
    expect(tally).toEqual({ checkedIn: 0, skipped: 1, hardError: null });
  });
});

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

describe("checkInAfterSignIn", () => {
  beforeEach(() => {
    // Node test run: give vaultStore the browser storage it expects.
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(globalThis, name, { configurable: true, value: memoryStorage() });
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    vi.restoreAllMocks();
  });

  it("checks in every vault this device has an owner key for, and shrugs off refusals", async () => {
    const meta = (id: string, ownerToken?: string) => ({
      id,
      label: "Savings",
      owner: { address: "o@example.com" },
      heir: { name: "Ada", email: "", address: "" },
      createdAt: "2026-01-01T00:00:00Z",
      ownerToken,
      groupId: null,
    });
    localStorage.setItem(
      "gk:vaults",
      JSON.stringify({ a: meta("a", "tok-a"), b: meta("b", "tok-b"), c: meta("c") }),
    );
    const calls: [string, string | null][] = [];
    vi.spyOn(api, "checkin").mockImplementation(async (id, token) => {
      calls.push([id, token]);
      if (id === "b") throw new ApiError(409, null, "fund your vault first");
      return {} as never;
    });
    await expect(checkInAfterSignIn()).resolves.toBeUndefined();
    // "c" has no owner key on this device, so it isn't tried.
    expect(calls).toEqual([
      ["a", "tok-a"],
      ["b", "tok-b"],
    ]);
  });
});
