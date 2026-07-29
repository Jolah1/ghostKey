/**
 * Spend panel for the recovery kit (issue #93).
 *
 * Lets the owner move their Bitcoin straight from the unlocked kit, with
 * no Bitcoin Core and no GhostKey. The signing happens locally in wasm
 * (the secret key never leaves the page); only two clearly-marked steps
 * touch the network, against a lookup service the kit picks from a short
 * list, or one the reader names:
 *
 *   1. "Find my coins" — derive the vault's addresses and ask the explorer
 *      which have unspent coins, fetching the funding transactions.
 *   2. "Broadcast" — publish the finished, signed transaction.
 *
 * The signing step in between is offline. The rest of the kit makes no
 * network calls at all; this panel is the one opt-in online surface.
 */
import { el, esc, copyBlock } from "./dom";
import { deriveAddresses, signSweep, type FundingInput } from "./signer";
import type { Network } from "../crypto/keygen";

interface SpendParams {
  /** "owner" spends the always-available branch; "heir" spends the
   *  timelocked branch (only valid once the coins have sat untouched
   *  for the vault's waiting period). */
  role: "owner" | "heir";
  network: Network;
  descriptorExternal: string;
  descriptorInternal: string;
  timelockBlocks: number;
  accountXprv: string;
}

/** Public Esplora mirrors per network, in the order we try them.
 *
 *  There is more than one because a single host is a single point of
 *  failure standing between someone and an inheritance. The owner who
 *  reported this could not reach mempool.space "most times", and the kit
 *  gave up on the first refusal. Every entry below was checked to answer
 *  `/blocks/tip/height` and to send `Access-Control-Allow-Origin: *`,
 *  which is what lets a page opened from `file://` read the reply at all.
 *
 *  Regtest has no public indexer, so the owner must supply one.
 *
 *  Signet keeps a single entry on purpose. A GhostKey signet vault may
 *  live on Mutinynet, which is a *different* signet chain: a mirror of
 *  the ordinary one would answer "no coins here" rather than fail, and a
 *  confident wrong answer is worse than a visible error. Whoever adds to
 *  this line has to solve that first.
 */
const EXPLORER_MIRRORS: Record<Network, readonly string[]> = {
  bitcoin: [
    // blockstream.info leads on evidence, not preference. The owner who
    // reported this could not reach mempool.space "most times" and moved
    // real money only after replacing it by hand. Order costs nothing
    // when a host is up, and is the whole game when one is not.
    "https://blockstream.info/api",
    "https://mempool.space/api",
    "https://mempool.emzy.de/api",
    "https://mempool.bitaroo.net/api",
  ],
  testnet: ["https://blockstream.info/testnet/api", "https://mempool.space/testnet/api"],
  signet: ["https://mempool.space/signet/api"],
  regtest: [],
};

/** What the reader is owed before they use any of the above.
 *
 *  The server refuses to do this: `default_esplora_urls` returns nothing
 *  for mainnet because a public indexer "sees every script pubkey we ask
 *  about". The kit asks anyway, because the alternative is an heir who
 *  cannot reach their money at all. That is a defensible trade, but only
 *  if it is stated rather than hidden. */
export const EXPLORER_DISCLOSURE =
  "Finding your coins uses an outside service, which will see this vault's addresses and balance. Nothing else on this page uses the internet.";

/** The collapsed section holding the two technical fields.
 *
 *  Named once and used in both the summary and the failure messages that
 *  send people to it. Two copies of a label drift apart, and a message
 *  pointing at a heading that no longer exists is worse than no message.
 *
 *  The wording is an invitation to skip. A reader recovering an
 *  inheritance should not have to learn what an explorer API is to move
 *  their own money, and since the kit now walks a list of hosts by
 *  itself, they no longer have to. */
export const ADVANCED_LABEL = "Settings most people don't need";

/** Shown inside the collapsed section, next to the explorer field. */
export const EXPLORER_OWN_NODE_HINT =
  "If you run your own Bitcoin node, put its address here instead. Left alone, the kit tries public services until one answers.";

/** The prefilled value: the first mirror we would try anyway. */
function defaultExplorer(network: Network): string {
  return EXPLORER_MIRRORS[network][0] ?? "";
}

/** A page a person can actually open, for a transaction we just sent.
 *
 *  The kit used to print a bare 64-character transaction id and stop.
 *  That is a fine answer for someone who knows it goes in an explorer's
 *  search box, and no answer at all for the reader this file is written
 *  for: they have just sent their inheritance somewhere and have nothing
 *  to click to see that it arrived.
 *
 *  Esplora deployments serve the human pages at the root and the API
 *  under `/api`, so dropping that one segment is the whole conversion,
 *  and it works for the self-hosted case too. Anything not shaped that
 *  way returns `null`, and the caller shows the plain id rather than
 *  inventing a link that 404s. */
export function explorerTxUrl(apiBase: string, txid: string): string | null {
  const base = apiBase.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  if (!/^[0-9a-f]{64}$/i.test(txid.trim())) return null;
  const web = base.replace(/\/api$/, "");
  if (web === base) return null;
  return `${web}/tx/${txid.trim().toLowerCase()}`;
}

/** Which explorers to try, given what is in the box.
 *
 *  A host we do not already publish is used ALONE. Falling back from a
 *  private Esplora to a public mirror would hand strangers the addresses
 *  that person went out of their way to keep off public infrastructure,
 *  silently, at the one moment they are not watching.
 *
 *  A host that IS on our list keeps its fallback, and goes first. Those
 *  hosts are ones this kit would have contacted anyway, so trying the
 *  others discloses nothing new — and the reader who typed one did so
 *  because the default was failing them, which is precisely when giving
 *  up after one host is the wrong answer. */
export function explorerCandidates(network: Network, typed: string): string[] {
  const cleaned = typed.trim().replace(/\/+$/, "");
  const mirrors = EXPLORER_MIRRORS[network];
  if (!cleaned) return [...mirrors];
  if (!mirrors.includes(cleaned)) return [cleaned];
  return [cleaned, ...mirrors.filter((m) => m !== cleaned)];
}

/** Whether a reply means "use this host", "try the next one", or "this
 *  host answered and the answer was no". */
export type ExplorerVerdict = "usable" | "try-another" | "answered";

export function classifyStatus(status: number): ExplorerVerdict {
  if (status >= 200 && status < 300) return "usable";
  // Overloaded or broken hosts are worth stepping past. A 4xx is a real
  // answer about the request, so the next mirror would say the same.
  if (status === 429 || status >= 500) return "try-another";
  return "answered";
}

/** One explorer that didn't work out. `reachable` is the distinction the
 *  old message threw away: whether the request got out of the building. */
export type ExplorerFailure = { url: string; reason: string; reachable: boolean };

/** What to tell the reader when no explorer worked.
 *
 *  The old text said "Check the address and your internet" for every
 *  failure, so a host that answered with a plain HTTP error sent people
 *  to inspect a working WiFi connection. Naming the wrong cause during a
 *  recovery costs hours that the reader may not have. */
export function explorerFailureMessage(failures: ExplorerFailure[]): string {
  if (failures.length === 0)
    return `No lookup service to try. Open "${ADVANCED_LABEL}" and enter one.`;
  const answered = failures.filter((f) => f.reachable);
  if (answered.length === 0) {
    const tried = failures.length === 1 ? "the lookup service" : `all ${failures.length} lookup services`;
    return `Couldn't reach ${tried}. The request never left this device, so this is the connection here, not your vault. Check your internet and try again. If it keeps failing, open "${ADVANCED_LABEL}" and put a different address in the box.`;
  }
  const first = answered[0];
  return `The lookup service answered, but refused the request (${first.reason}). Your connection is fine. Open "${ADVANCED_LABEL}" and check the address there is right for this vault's network.`;
}

/** Marker text in the errors this module throws for itself, used to tell
 *  "the host answered and said no" apart from "the wire went dead". */
const ANSWERED_MARKERS = ["explorer returned", "could not fetch transaction"];

/** What to say when the scan dies after a host had already answered once.
 *
 *  By this point a working explorer has been found, so "check the
 *  address" is no longer sensible advice. The raw message is kept: the
 *  bug that started all of this was diagnosed from a reader quoting
 *  "Failed to fetch" verbatim. */
export function scanFailureMessage(message: string): string {
  if (ANSWERED_MARKERS.some((m) => message.includes(m))) {
    return `The block explorer answered with an error (${message}). Your connection is fine. Try again, or put a different explorer in the box above.`;
  }
  return `Lost contact with the block explorer partway through (${message}). Nothing was spent, so it is safe to try again once your connection is back.`;
}

/** Result of probing one host: it answered with a status, or the request
 *  never got out. */
export type ProbeResult = { status: number } | { unreachable: string };

/** Walk the candidates in order and return the first usable one.
 *
 *  `probe` is injected so the choosing logic is testable without a
 *  network: the whole point of this function is what it does when hosts
 *  are down, which is the case a live test cannot stage on demand. */
export async function pickExplorer(
  candidates: string[],
  probe: (base: string) => Promise<ProbeResult>,
): Promise<{ base: string } | { failures: ExplorerFailure[] }> {
  const failures: ExplorerFailure[] = [];
  for (const base of candidates) {
    const result = await probe(base);
    if ("unreachable" in result) {
      failures.push({ url: base, reason: result.unreachable, reachable: false });
      continue;
    }
    if (classifyStatus(result.status) === "usable") return { base };
    failures.push({ url: base, reason: `error ${result.status}`, reachable: true });
  }
  return { failures };
}

/** How many addresses per keychain to scan, and how many consecutive
 *  empties before we stop (gap limit). */
const SCAN_COUNT = 30;
const GAP_LIMIT = 20;

type EsploraUtxo = {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
};

/** Label for the destination field.
 *
 *  It used to read "Send to this Bitcoin address", which describes a
 *  DEPOSIT. The field is the opposite: it is where the vault's coins are
 *  sent OUT to. A reader who acts on the old wording sends money to an
 *  address instead of away from one, and in a recovery kit the reader is
 *  usually grieving, non-technical, and alone. */
export const RECIPIENT_LABEL = "Where should the money go?";

export const RECIPIENT_HINT =
  "Paste an address from your own wallet. The Bitcoin in the vault will be sent there.";

/** What the panel is currently telling the reader.
 *
 *  A union rather than two independent lines, so "it failed" and "it is
 *  still working" cannot be on screen together. */
export type KitFeedback =
  | { kind: "idle" }
  | { kind: "busy"; status: string }
  | { kind: "info"; status: string }
  | { kind: "error"; error: string };

export function feedbackLines(f: KitFeedback): {
  error: string | null;
  status: string | null;
  busy: boolean;
} {
  switch (f.kind) {
    case "idle":
      return { error: null, status: null, busy: false };
    case "busy":
      return { error: null, status: f.status, busy: true };
    case "info":
      return { error: null, status: f.status, busy: false };
    case "error":
      // The point of the whole exercise: an error clears the status and
      // stops the progress bar.
      return { error: f.error, status: null, busy: false };
  }
}

export function buildSpendSection(params: SpendParams): HTMLElement {
  const isHeir = params.role === "heir";
  const section = el(`
    <div>
      <h2>${isHeir ? "Move your Bitcoin to your own wallet" : "Or move your Bitcoin from here"}</h2>
      <p class="muted">${
        isHeir
          ? `The only part of this page that uses the internet. It looks up
      the coins, signs the payment on this device (the secret key never
      leaves this page), and sends it to a wallet address you choose. If
      this says the coins can't be spent yet, the waiting period hasn't
      passed. Try again later.`
          : `Advanced, and the only part of this page that uses the
      internet. It looks up your coins, signs the payment on this device
      (your secret key never leaves this page), and gives you a finished
      transaction. If you'd rather not, the import method above works in
      Bitcoin Core instead.`
      }</p>
      <div class="box">
        <p class="muted" style="margin-top:0">${RECIPIENT_LABEL}</p>
        <p class="muted" style="margin-top:0;font-size:13px">${RECIPIENT_HINT}</p>
        <input data-to type="text" placeholder="bc1..." aria-label="Recipient address"
               style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
                      border:1px solid #3a332a;background:#14110e;color:#ece5da;font-size:15px" />
        <details data-advanced style="margin-top:10px">
          <summary class="muted">${ADVANCED_LABEL}</summary>
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <label class="muted" style="flex:1;min-width:120px">Fee (sat/vByte)
              <input data-fee type="number" min="1" value="5" aria-label="Fee rate"
                     style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
                            border:1px solid #3a332a;background:#14110e;color:#ece5da" />
            </label>
            <label class="muted" style="flex:3;min-width:200px">Where to look up your coins
              <input data-explorer type="text" aria-label="Explorer API base"
                     style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
                            border:1px solid #3a332a;background:#14110e;color:#ece5da" />
            </label>
          </div>
          <p class="muted" style="margin-top:8px;font-size:13px">${EXPLORER_OWN_NODE_HINT}</p>
        </details>
        <p class="muted" style="margin-top:10px;font-size:13px">${EXPLORER_DISCLOSURE}</p>
        <div style="margin-top:12px">
          <button data-find type="button">Find my coins</button>
        </div>
        <progress data-busy hidden style="margin-top:10px"></progress>
        <p class="err" data-err hidden></p>
        <p data-status hidden></p>
        <div data-sign hidden style="margin-top:10px">
          <button data-do-sign type="button">Sign the payment</button>
        </div>
        <div data-out></div>
      </div>
    </div>
  `);

  const toInput = section.querySelector("[data-to]") as HTMLInputElement;
  const feeInput = section.querySelector("[data-fee]") as HTMLInputElement;
  const explorerInput = section.querySelector("[data-explorer]") as HTMLInputElement;
  const advanced = section.querySelector("[data-advanced]") as HTMLDetailsElement;
  const findBtn = section.querySelector("[data-find]") as HTMLButtonElement;
  const busy = section.querySelector("[data-busy]") as HTMLProgressElement;
  const errLine = section.querySelector("[data-err]") as HTMLElement;
  const statusLine = section.querySelector("[data-status]") as HTMLElement;
  const signWrap = section.querySelector("[data-sign]") as HTMLElement;
  const signBtn = section.querySelector("[data-do-sign]") as HTMLButtonElement;
  const out = section.querySelector("[data-out]") as HTMLElement;

  explorerInput.value = defaultExplorer(params.network);

  let funding: FundingInput[] = [];
  let chainTip = 0;

  const explorerBase = () => explorerInput.value.trim().replace(/\/+$/, "");

  /** The only way this panel talks to the reader.
   *
   *  It exists because the two lines used to be set independently, and
   *  `showError` didn't touch the status line — so a failed lookup
   *  rendered "Couldn't reach the explorer" directly above "Looking up
   *  your addresses…", telling someone their money was both unreachable
   *  and still being counted. For a page whose only reader is a person
   *  trying to recover an inheritance, that is the worst possible
   *  moment to be ambiguous.
   *
   *  Taking `KitFeedback` makes it unrepresentable: one call sets both
   *  lines, and the type has no state carrying an error and a status at
   *  once. */
  function setFeedback(f: KitFeedback) {
    const lines = feedbackLines(f);
    errLine.textContent = lines.error ?? "";
    errLine.hidden = lines.error === null;
    statusLine.textContent = lines.status ?? "";
    statusLine.hidden = lines.status === null;
    busy.hidden = !lines.busy;
  }

  const showError = (msg: string) => setFeedback({ kind: "error", error: msg });

  async function getJson<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`explorer returned ${r.status} for ${url}`);
    return (await r.json()) as T;
  }

  /** Ask one host for the chain tip. Any thrown error means the request
   *  never left the device, which is a different problem from a host that
   *  answered badly, and the reader is told which. */
  async function probeExplorer(base: string): Promise<ProbeResult> {
    try {
      const r = await fetch(`${base}/blocks/tip/height`);
      return { status: r.status };
    } catch (e) {
      return { unreachable: (e as Error).message };
    }
  }

  async function onFind() {
    setFeedback({ kind: "idle" });
    out.textContent = "";
    signWrap.hidden = true;
    const candidates = explorerCandidates(params.network, explorerInput.value);
    if (candidates.length === 0) {
      // Same treatment as a total failure: open the section and use the
      // wording that names it. This branch had its own jargon message and
      // left the section shut, so the advice pointed at a hidden field.
      advanced.open = true;
      showError(explorerFailureMessage([]));
      return;
    }
    findBtn.disabled = true;
    setFeedback({ kind: "busy", status: "Looking for a block explorer that answers…" });
    try {
      const picked = await pickExplorer(candidates, probeExplorer);
      if ("failures" in picked) {
        // The message tells them to open this; opening it for them saves
        // a reader who has just been told their money is unreachable from
        // hunting for a heading they have never seen.
        advanced.open = true;
        showError(explorerFailureMessage(picked.failures));
        return;
      }
      // Show which one answered: the reader is entitled to know who saw
      // their addresses, and the broadcast step reuses this value.
      const base = picked.base;
      explorerInput.value = base;

      setFeedback({ kind: "busy", status: "Looking up your addresses…" });
      const { external, internal } = await deriveAddresses(
        params.descriptorExternal,
        params.descriptorInternal,
        params.network,
        SCAN_COUNT,
      );

      const utxos: EsploraUtxo[] = [];
      for (const list of [external, internal]) {
        let gap = 0;
        for (const addr of list) {
          const found = await getJson<EsploraUtxo[]>(`${base}/address/${addr}/utxo`);
          if (found.length === 0) {
            if (++gap >= GAP_LIMIT) break;
            continue;
          }
          gap = 0;
          utxos.push(...found);
        }
      }

      const confirmed = utxos.filter((u) => u.status.confirmed && u.status.block_height);
      if (confirmed.length === 0) {
        setFeedback({
          kind: "info",
          status:
            "No confirmed coins found at this vault. If you just funded it, wait for a confirmation and try again.",
        });
        return;
      }

      // Fetch each unique funding transaction once.
      const byTxid = new Map<string, number>();
      for (const u of confirmed) byTxid.set(u.txid, u.status.block_height!);
      const fundingNext: FundingInput[] = [];
      for (const [txid, height] of byTxid) {
        const r = await fetch(`${base}/tx/${txid}/hex`);
        if (!r.ok) throw new Error(`could not fetch transaction ${txid} (${r.status})`);
        fundingNext.push({ tx_hex: (await r.text()).trim(), confirmation_height: height });
      }
      chainTip = await getJson<number>(`${base}/blocks/tip/height`);
      funding = fundingNext;

      const total = confirmed.reduce((s, u) => s + u.value, 0);
      setFeedback({
        kind: "info",
        status: `Found ${confirmed.length} coin(s) totalling ${total.toLocaleString()} sats. Now put your own wallet address at the top and sign.`,
      });
      signWrap.hidden = false;
    } catch (e) {
      showError(scanFailureMessage((e as Error).message));
    } finally {
      // `busy` is owned by setFeedback now, and every exit path above
      // has called it. Only the button is re-enabled here.
      findBtn.disabled = false;
    }
  }

  async function onSign() {
    errLine.hidden = true;
    out.textContent = "";
    const recipient = toInput.value.trim();
    if (!recipient) {
      showError("Put the address of your own wallet at the top first.");
      return;
    }
    const fee = Math.max(1, Math.floor(Number(feeInput.value) || 1));
    signBtn.disabled = true;
    try {
      const result = await signSweep({
        role: params.role,
        descriptor_external: params.descriptorExternal,
        descriptor_internal: params.descriptorInternal,
        timelock_blocks: params.timelockBlocks,
        network: params.network,
        account_xprv: params.accountXprv,
        funding,
        chain_tip_height: chainTip,
        recipient,
        amount_sat: null, // drain everything
        fee_rate_sat_vb: fee,
      });
      renderSigned(result.tx_hex, result.txid, result.fee_sat);
    } catch (e) {
      showError(`Could not sign: ${(e as Error).message}`);
    } finally {
      signBtn.disabled = false;
    }
  }

  function renderSigned(txHex: string, txid: string, feeSat: number) {
    out.appendChild(
      el(`<p class="ok" style="margin-top:14px">Signed. Fee ${feeSat.toLocaleString()} sats.
      Broadcast it below, or copy it and paste into any explorer's broadcast box.</p>`),
    );
    out.appendChild(copyBlock("Signed transaction (ready to broadcast)", txHex));
    const bc = el(`
      <div>
        <button data-broadcast type="button">Broadcast now</button>
        <p data-bcout hidden style="margin-top:8px"></p>
      </div>
    `);
    out.appendChild(bc);
    const bcBtn = bc.querySelector("[data-broadcast]") as HTMLButtonElement;
    const bcOut = bc.querySelector("[data-bcout]") as HTMLElement;
    bcBtn.addEventListener("click", () => {
      void (async () => {
        bcBtn.disabled = true;
        bcOut.hidden = false;
        bcOut.className = "muted";
        bcOut.textContent = "Sending…";
        try {
          const r = await fetch(`${explorerBase()}/tx`, { method: "POST", body: txHex });
          const body = (await r.text()).trim();
          if (!r.ok) throw new Error(body || `explorer returned ${r.status}`);
          bcOut.className = "ok";
          // A link, not just an id. The reader has this second just sent
          // their money somewhere and needs to see that it arrived.
          const sentTxid = body || txid;
          const link = explorerTxUrl(explorerBase(), sentTxid);
          bcOut.innerHTML = link
            ? `Sent. <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Check it here</a>:
               <span class="mono">${esc(link)}</span>`
            : `Sent. Transaction id: <span class="mono">${esc(sentTxid)}</span>`;
        } catch (e) {
          bcOut.className = "err";
          bcOut.textContent = `Broadcast failed: ${(e as Error).message}. You can still copy the transaction above and broadcast it elsewhere.`;
          bcBtn.disabled = false;
        }
      })();
    });
  }

  findBtn.addEventListener("click", () => void onFind());
  signBtn.addEventListener("click", () => void onSign());
  return section;
}
