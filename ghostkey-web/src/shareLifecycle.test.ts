import { describe, expect, it } from "vitest";
import { shareRemovable, vaultCloseState } from "./Dashboard";

describe("shareRemovable", () => {
  it("allows removing a share the heir hasn't touched", () => {
    for (const status of ["unfunded", "ok", "warning", "alarmed", "frozen"]) {
      expect(shareRemovable(status)).toBe(true);
    }
  });

  it("refuses once a claim is live or done", () => {
    for (const status of ["timelock_started", "claiming", "claimed"]) {
      expect(shareRemovable(status)).toBe(false);
    }
  });

  it("leaves an unknown status removable, since the server decides", () => {
    expect(shareRemovable(undefined)).toBe(true);
  });
});

describe("vaultCloseState", () => {
  const claimed = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, "claimed"]));

  it("offers closing when a single share is left, claimed or not", () => {
    expect(vaultCloseState([{ id: "a" }], { a: "ok" }).canClose).toBe(true);
    expect(vaultCloseState([{ id: "a" }], claimed("a")).canClose).toBe(true);
  });

  it("never offers closing while a claim is in flight", () => {
    // The heir is holding a live link. Closing would delete it.
    for (const status of ["timelock_started", "claiming"]) {
      expect(vaultCloseState([{ id: "a" }], { a: status }).canClose).toBe(
        false,
      );
      expect(
        vaultCloseState([{ id: "a" }, { id: "b" }], {
          a: "claimed",
          b: status,
        }).canClose,
      ).toBe(false);
    }
  });

  it("stays hidden while any heir still has a live share", () => {
    const state = vaultCloseState(
      [{ id: "a" }, { id: "b" }],
      { a: "claimed", b: "ok" },
    );
    expect(state.allClaimed).toBe(false);
    expect(state.canClose).toBe(false);
  });

  it("offers closing once every heir has claimed", () => {
    const state = vaultCloseState(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      claimed("a", "b", "c"),
    );
    expect(state.allClaimed).toBe(true);
    expect(state.canClose).toBe(true);
  });

  it("treats a share we couldn't fetch as not claimed", () => {
    // Losing one status fetch must not make a live vault look finished.
    const state = vaultCloseState(
      [{ id: "a" }, { id: "b" }],
      { a: "claimed" },
    );
    expect(state.allClaimed).toBe(false);
    expect(state.canClose).toBe(false);
  });

  it("doesn't offer closing a vault with no shares", () => {
    expect(vaultCloseState([], {})).toEqual({
      allClaimed: false,
      canClose: false,
    });
  });
});
