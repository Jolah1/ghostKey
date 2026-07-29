/**
 * The recovery kit's spend panel, for the two ways it misled a reader.
 *
 * This page is read by someone recovering an inheritance: usually
 * grieving, usually non-technical, usually alone, and holding the only
 * copy of a key. Ambiguity here is not a cosmetic bug.
 */
import { describe, expect, it } from "vitest";

import {
  ADVANCED_LABEL,
  EXPLORER_DISCLOSURE,
  EXPLORER_OWN_NODE_HINT,
  RECIPIENT_HINT,
  RECIPIENT_LABEL,
  classifyStatus,
  explorerCandidates,
  explorerFailureMessage,
  explorerTxUrl,
  feedbackLines,
  pickExplorer,
  scanFailureMessage,
  type KitFeedback,
  type ProbeResult,
} from "./spend";

describe("the destination field label", () => {
  it("does not read as an instruction to deposit", () => {
    // It used to say "Send to this Bitcoin address", which describes
    // paying money IN. The field is where the vault's coins go OUT to.
    // Someone acting on the old wording sends funds to an address
    // instead of away from one.
    const both = `${RECIPIENT_LABEL} ${RECIPIENT_HINT}`.toLowerCase();
    expect(both).not.toContain("send to this");
    expect(RECIPIENT_LABEL.toLowerCase()).not.toMatch(/^send to/);
  });

  it("says whose wallet the address should belong to", () => {
    // "Paste an address" alone invites pasting the vault's own deposit
    // address back in, which is the mistake the old copy encouraged.
    expect(RECIPIENT_HINT.toLowerCase()).toContain("your own wallet");
  });

  it("stays plain: no jargon a non-technical reader would stall on", () => {
    const both = `${RECIPIENT_LABEL} ${RECIPIENT_HINT}`.toLowerCase();
    for (const jargon of ["utxo", "descriptor", "psbt", "recipient", "output"]) {
      expect(both).not.toContain(jargon);
    }
  });
});

describe("feedbackLines", () => {
  it("never shows an error and a status at the same time", () => {
    // The reported bug: a failed lookup rendered "Couldn't reach the
    // explorer" directly above "Looking up your addresses…", so the
    // page said the money was both unreachable and still being counted.
    const failed = feedbackLines({ kind: "error", error: "Couldn't reach the explorer." });
    expect(failed.error).toBe("Couldn't reach the explorer.");
    expect(failed.status).toBeNull();
  });

  it("stops the progress bar on failure", () => {
    // A spinner still turning under an error message reads as "it might
    // still work", so the reader waits instead of acting.
    expect(feedbackLines({ kind: "error", error: "boom" }).busy).toBe(false);
  });

  it("spins only while actually working", () => {
    expect(feedbackLines({ kind: "busy", status: "Looking up…" }).busy).toBe(true);
    expect(feedbackLines({ kind: "info", status: "Found 2 coins" }).busy).toBe(false);
    expect(feedbackLines({ kind: "idle" }).busy).toBe(false);
  });

  it("clears both lines when idle, so a retry starts clean", () => {
    const idle = feedbackLines({ kind: "idle" });
    expect(idle.error).toBeNull();
    expect(idle.status).toBeNull();
  });

  it("carries status through without an error attached", () => {
    for (const kind of ["busy", "info"] as const) {
      const f = feedbackLines({ kind, status: "working on it" } as KitFeedback);
      expect(f.status).toBe("working on it");
      expect(f.error).toBeNull();
    }
  });
});

describe("choosing a block explorer", () => {
  it("tries several mainnet mirrors, not one", () => {
    // The owner who reported this could not reach mempool.space "most
    // times", and one unreachable host stood between them and a vault.
    const list = explorerCandidates("bitcoin", "");
    expect(list.length).toBeGreaterThan(1);
    // blockstream leads because it is the one that actually answered for
    // the owner who was stuck, and moved real money.
    expect(list[0]).toBe("https://blockstream.info/api");
    expect(new Set(list).size).toBe(list.length);
    for (const url of list) expect(url.startsWith("https://")).toBe(true);
  });

  it("uses a typed-in explorer ALONE and never falls back to public ones", () => {
    // Someone who points the kit at their own node has deliberately kept
    // these addresses off public infrastructure. Falling back would undo
    // that silently, at the moment they are least likely to notice.
    expect(explorerCandidates("bitcoin", "https://my-own-node.local/api")).toEqual([
      "https://my-own-node.local/api",
    ]);
  });

  it("ignores a trailing slash rather than treating it as a new host", () => {
    expect(explorerCandidates("bitcoin", "https://blockstream.info/api/")).toEqual(
      explorerCandidates("bitcoin", "https://blockstream.info/api"),
    );
  });

  it("keeps the fallback when the reader picks one of OUR public hosts", () => {
    // This is the case that stranded the owner: they typed a public
    // mirror by hand because the default was failing. Dropping the
    // fallback there would punish exactly the person already in trouble.
    // Nothing new is disclosed, since every host tried is one this kit
    // would have contacted anyway.
    const list = explorerCandidates("bitcoin", "https://mempool.space/api");
    expect(list[0]).toBe("https://mempool.space/api");
    expect(list.length).toBeGreaterThan(1);
    expect(list).toContain("https://blockstream.info/api");
    expect(new Set(list).size).toBe(list.length);
  });

  it("still uses a host of the reader's OWN alone", () => {
    const list = explorerCandidates("bitcoin", "https://my-node.local/api");
    expect(list).toEqual(["https://my-node.local/api"]);
  });

  it("has nothing to offer on regtest, so the reader is asked", () => {
    expect(explorerCandidates("regtest", "")).toEqual([]);
  });

  it("keeps signet on one host, because a mirror would answer wrongly", () => {
    // A GhostKey signet vault may be on Mutinynet. An ordinary signet
    // mirror would report "no coins" instead of failing, and a confident
    // wrong answer sends the reader away believing the vault is empty.
    expect(explorerCandidates("signet", "")).toHaveLength(1);
  });
});

describe("classifyStatus", () => {
  it("moves past hosts that are overloaded or broken", () => {
    for (const s of [429, 500, 502, 503]) expect(classifyStatus(s)).toBe("try-another");
  });

  it("treats a 4xx as a real answer, since the next mirror would agree", () => {
    for (const s of [400, 404]) expect(classifyStatus(s)).toBe("answered");
  });

  it("accepts any 2xx", () => {
    for (const s of [200, 204]) expect(classifyStatus(s)).toBe("usable");
  });
});

describe("pickExplorer", () => {
  const probeReturning = (byUrl: Record<string, ProbeResult>) => {
    const asked: string[] = [];
    const probe = async (base: string): Promise<ProbeResult> => {
      asked.push(base);
      return byUrl[base] ?? { unreachable: "Failed to fetch" };
    };
    return { probe, asked };
  };

  it("steps past an unreachable host and uses the next one", async () => {
    const { probe, asked } = probeReturning({
      "https://down.example/api": { unreachable: "Failed to fetch" },
      "https://up.example/api": { status: 200 },
    });
    const got = await pickExplorer(["https://down.example/api", "https://up.example/api"], probe);
    expect(got).toEqual({ base: "https://up.example/api" });
    expect(asked).toHaveLength(2);
  });

  it("stops at the first host that works, contacting no others", async () => {
    // Each host tried learns the vault's addresses, so trying more than
    // necessary is a disclosure, not just wasted time.
    const { probe, asked } = probeReturning({
      "https://up.example/api": { status: 200 },
      "https://other.example/api": { status: 200 },
    });
    await pickExplorer(["https://up.example/api", "https://other.example/api"], probe);
    expect(asked).toEqual(["https://up.example/api"]);
  });

  it("reports every failure when nothing works, keeping reachability", async () => {
    const { probe } = probeReturning({
      "https://a.example/api": { unreachable: "Failed to fetch" },
      "https://b.example/api": { status: 503 },
    });
    const got = await pickExplorer(["https://a.example/api", "https://b.example/api"], probe);
    expect("failures" in got).toBe(true);
    if (!("failures" in got)) return;
    expect(got.failures.map((f) => f.reachable)).toEqual([false, true]);
  });
});

describe("explorerFailureMessage", () => {
  it("blames the connection only when nothing got out", () => {
    const msg = explorerFailureMessage([
      { url: "https://a.example/api", reason: "Failed to fetch", reachable: false },
      { url: "https://b.example/api", reason: "Failed to fetch", reachable: false },
    ]);
    expect(msg.toLowerCase()).toContain("internet");
    expect(msg).toContain("never left this device");
    // It must not imply the vault or its addresses are at fault.
    expect(msg.toLowerCase()).not.toContain("your vault is");
  });

  it("does NOT blame the connection when a host answered", () => {
    // The old copy said "Check the address and your internet" for every
    // failure, sending people to inspect a working connection while the
    // real answer was sitting in the HTTP status.
    const msg = explorerFailureMessage([
      { url: "https://a.example/api", reason: "error 400", reachable: true },
    ]);
    expect(msg).toContain("answered");
    expect(msg).toContain("400");
    expect(msg).toContain("Your connection is fine");
  });

  it("says something useful even with nothing to report", () => {
    expect(explorerFailureMessage([])).not.toBe("");
  });
});

describe("scanFailureMessage", () => {
  it("separates a host's error from the wire going dead", () => {
    const answered = scanFailureMessage("explorer returned 429 for https://x/api/address/bc1q/utxo");
    expect(answered).toContain("Your connection is fine");

    const dead = scanFailureMessage("Failed to fetch");
    expect(dead.toLowerCase()).toContain("connection");
    expect(dead).not.toContain("Your connection is fine");
  });

  it("keeps the raw message, which is what made the original diagnosable", () => {
    expect(scanFailureMessage("Failed to fetch")).toContain("Failed to fetch");
  });

  it("reassures that a failed lookup spent nothing", () => {
    // The reader is mid-recovery holding the only key. "It broke" without
    // "nothing was spent" invites a panicked second attempt.
    expect(scanFailureMessage("Failed to fetch")).toContain("Nothing was spent");
  });
});

describe("the explorer disclosure", () => {
  it("says plainly what an outside service learns, in words with no jargon", () => {
    // The server refuses to use a public indexer on mainnet for exactly
    // this reason. The kit does it anyway so an heir is not stranded, and
    // that trade is only defensible if it is stated.
    const d = EXPLORER_DISCLOSURE.toLowerCase();
    expect(d).toContain("addresses");
    expect(d).toContain("balance");
    // It stays OUTSIDE the collapsed section, so it must not read as an
    // instruction about a field the reader cannot see.
    expect(d).not.toContain("here");
    for (const jargon of ["api", "esplora", "explorer"]) expect(d).not.toContain(jargon);
  });

  it("keeps the run-your-own-node advice next to the field it refers to", () => {
    expect(EXPLORER_OWN_NODE_HINT.toLowerCase()).toContain("your own");
  });
});

describe("hiding the technical fields", () => {
  it("labels the collapsed section as skippable, without jargon", () => {
    // The reader asked the real question: how would a non-technical
    // person know any of this? They should not have to. The kit walks a
    // list of hosts by itself, so the field only matters when that fails.
    const l = ADVANCED_LABEL.toLowerCase();
    for (const jargon of ["api", "explorer", "esplora", "endpoint", "url"]) {
      expect(l).not.toContain(jargon);
    }
  });

  it("points failures at that exact label, so the two cannot drift", () => {
    const unreachable = explorerFailureMessage([
      { url: "https://a/api", reason: "Failed to fetch", reachable: false },
    ]);
    const answered = explorerFailureMessage([
      { url: "https://a/api", reason: "error 400", reachable: true },
    ]);
    for (const msg of [unreachable, answered, explorerFailureMessage([])]) {
      expect(msg).toContain(ADVANCED_LABEL);
    }
  });
});

describe("explorerTxUrl", () => {
  const TXID = "2815f3dd" + "a".repeat(56);

  it("turns the API address into a page a person can open", () => {
    expect(explorerTxUrl("https://blockstream.info/api", TXID)).toBe(
      `https://blockstream.info/tx/${TXID}`,
    );
    expect(explorerTxUrl("https://mempool.space/api", TXID)).toBe(
      `https://mempool.space/tx/${TXID}`,
    );
  });

  it("keeps a network path segment, which is the whole address on signet", () => {
    expect(explorerTxUrl("https://mempool.space/signet/api", TXID)).toBe(
      `https://mempool.space/signet/tx/${TXID}`,
    );
  });

  it("works for a self-hosted Esplora, trailing slash and all", () => {
    expect(explorerTxUrl("https://my-node.local/api/", TXID)).toBe(
      `https://my-node.local/tx/${TXID}`,
    );
  });

  it("returns nothing rather than inventing a link that 404s", () => {
    // Better a bare id the reader can paste than a confident link to a
    // page that does not exist, at the moment they most need to confirm
    // their money arrived.
    expect(explorerTxUrl("https://odd-host.example/rest/v1", TXID)).toBeNull();
    expect(explorerTxUrl("not a url", TXID)).toBeNull();
    expect(explorerTxUrl("https://blockstream.info/api", "nonsense")).toBeNull();
    expect(explorerTxUrl("https://blockstream.info/api", "")).toBeNull();
    // No javascript: or data: smuggled in through the explorer field.
    expect(explorerTxUrl("javascript:alert(1)/api", TXID)).toBeNull();
  });
});
