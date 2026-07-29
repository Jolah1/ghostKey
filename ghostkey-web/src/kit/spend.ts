/**
 * Spend panel for the recovery kit (issue #93).
 *
 * Lets the owner move their Bitcoin straight from the unlocked kit, with
 * no Bitcoin Core and no GhostKey. The signing happens locally in wasm
 * (the secret key never leaves the page); only two clearly-marked steps
 * touch the network, and only against an explorer the user chooses:
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

/** Default public explorer per network. Regtest has none — user supplies. */
function defaultExplorer(network: Network): string {
  switch (network) {
    case "bitcoin":
      return "https://mempool.space/api";
    case "testnet":
      return "https://blockstream.info/testnet/api";
    case "signet":
      return "https://mempool.space/signet/api";
    default:
      return "";
  }
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
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
          <label class="muted" style="flex:1;min-width:120px">Fee (sat/vByte)
            <input data-fee type="number" min="1" value="5" aria-label="Fee rate"
                   style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
                          border:1px solid #3a332a;background:#14110e;color:#ece5da" />
          </label>
          <label class="muted" style="flex:3;min-width:200px">Block explorer (its API address)
            <input data-explorer type="text" aria-label="Explorer API base"
                   style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
                          border:1px solid #3a332a;background:#14110e;color:#ece5da" />
          </label>
        </div>
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

  async function onFind() {
    setFeedback({ kind: "idle" });
    out.textContent = "";
    signWrap.hidden = true;
    const base = explorerBase();
    if (!base) {
      showError("Enter the API address of a block explorer first.");
      return;
    }
    findBtn.disabled = true;
    setFeedback({ kind: "busy", status: "Looking up your addresses…" });
    try {
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
      showError(`Couldn't reach the explorer. Check the address and your internet. (${(e as Error).message})`);
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
          bcOut.innerHTML = `Sent. Transaction id: <span class="mono">${esc(body || txid)}</span>`;
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
