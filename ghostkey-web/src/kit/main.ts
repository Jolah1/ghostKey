/**
 * Independence-proof kit page — runs from the downloaded file, offline.
 *
 * The page receives the vault's data via the JSON placeholder in
 * independence-proof.html (spliced in by the dashboard at download
 * time) and offers two layers:
 *
 *   1. No password needed: the watch-only descriptor pair, which
 *      Bitcoin Core can use to SEE the funds. NOTE: Sparrow, Liana,
 *      Electrum, and mobile wallets cannot — the vault is a Taproot
 *      timelock miniscript. Sparrow/Electrum/mobile have no miniscript
 *      support at all; Liana only accepts its own descriptor shape and
 *      refuses ours (verified 2026-06-14). Bitcoin Core is the one tool
 *      that opens these vaults. To just see the balance with no wallet,
 *      look up the funded deposit address on a block explorer.
 *   2. Password unlock: Argon2id + XChaCha20-Poly1305 — the exact
 *      primitives the dashboard uses (src/crypto/sealing.ts) — decrypt
 *      the owner's account xprv locally. We then splice the xprv into
 *      the descriptors so the result imports into Bitcoin Core as a
 *      SPENDING wallet.
 *
 * Constraints this file lives under:
 *   - No network calls, ever. It must work from file:// with WiFi off.
 *     (No external fonts, no CDN, no telemetry.)
 *   - No framework. Vanilla DOM keeps the inlined bundle small and
 *     auditable.
 *   - Plain words. The reader may be opening this years from now,
 *     possibly with a helper who has never heard of GhostKey. See
 *     the farmer-friendly principle in the repo docs.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { HDKey } from "@scure/bip32";
import { deriveOwnerKek, b64decode } from "../crypto/sealing";
import { bip32Versions, type Network } from "../crypto/keygen";

/** Shape of the JSON the dashboard splices into the placeholder.
 *  Mirrors buildKitData() in src/independenceProof.ts — keep in sync. */
interface KitData {
  v: 1;
  generated_at: string;
  label: string | null;
  vault_id: string;
  network: Network;
  timelock_blocks: number;
  descriptor_external: string;
  descriptor_internal: string;
  password_salt_b64: string;
  password_kdf_mem_kib: number;
  password_kdf_iters: number;
  owner_xprv_ct_b64: string;
  owner_xprv_nonce_b64: string;
}

const app = document.getElementById("app")!;

const css = `
  :root { color-scheme: dark light; }
  body { margin: 0; background: #14110e; color: #ece5da;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 36px 0 8px; }
  p  { margin: 8px 0; }
  .muted { color: #a89d8c; font-size: 14px; }
  .box { background: #1e1a15; border: 1px solid #3a332a; border-radius: 10px;
         padding: 14px 16px; margin: 12px 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px; word-break: break-all; }
  .danger { border-color: #8a4b3b; }
  .ok { color: #9fc97f; }
  .warn { color: #e0b664; }
  .err { color: #e08a74; }
  button { background: #e0b664; color: #14110e; border: 0; border-radius: 8px;
           padding: 10px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.copy { background: #3a332a; color: #ece5da; padding: 4px 10px;
                font-size: 12px; font-weight: 400; margin-top: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px;
           border-radius: 8px; border: 1px solid #3a332a; background: #14110e;
           color: #ece5da; font-size: 16px; }
  ol li { margin: 6px 0; }
  progress { width: 100%; height: 8px; }
  a { color: #e0b664; }
`;

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A labelled monospace block with a copy button. */
function copyBlock(label: string, value: string): HTMLElement {
  const node = el(`
    <div class="box">
      <p class="muted" style="margin-top:0">${esc(label)}</p>
      <p class="mono">${esc(value)}</p>
      <button class="copy" type="button">Copy</button>
    </div>
  `);
  const btn = node.querySelector("button")!;
  btn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      btn.textContent = "Copied ✓";
      window.setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  });
  return node;
}

function readKitData(): KitData | null {
  const raw = document.getElementById("ghostkey-kit-data")?.textContent ?? "";
  // The placeholder literal is assembled at runtime so it appears
  // exactly ONCE in the built file (inside the script tag). If it were
  // written out here verbatim, the dashboard's single-occurrence
  // replace could hit this code instead of the data slot.
  const placeholder = ["__GHOSTKEY", "_KIT_DATA__"].join("");
  if (!raw.trim() || raw.includes(placeholder)) return null;
  try {
    return JSON.parse(raw) as KitData;
  } catch {
    return null;
  }
}

function render() {
  document.head.appendChild(el(`<style>${css}</style>`));
  const data = readKitData();

  const main = el(`<main></main>`);
  app.appendChild(main);

  if (!data) {
    main.appendChild(
      el(`
      <div>
        <h1>Recovery file — template</h1>
        <p>This is the unfilled template. Download your personal copy from
        your GhostKey dashboard — it will contain your vault's details.</p>
      </div>
    `),
    );
    return;
  }

  const created = new Date(data.generated_at);
  main.appendChild(
    el(`
    <div>
      <h1>Your Bitcoin — Emergency Recovery File</h1>
      <p class="muted">Vault${data.label ? ` “${esc(data.label)}”` : ""} ·
        ${esc(data.network)} · saved ${created.toLocaleDateString()}</p>

      <div class="box">
        <p style="margin-top:0"><strong>What this file is.</strong>
        The emergency spare key for your GhostKey vault. Everything
        needed to reach your money is locked inside it with the same
        password you sign in with. Day to day you won't need it —
        your GhostKey dashboard is the place to check in and manage
        your vault. Use this file only in a true emergency, like
        losing access to your account.</p>
        <p style="margin-bottom:0"><strong>Where to keep it.</strong>
        Anywhere you like — email it to yourself, put it on a USB
        stick, keep copies in several places. Without your password
        it does not reveal your keys. It works without internet.</p>
      </div>
    </div>
  `),
  );

  /* ---- unlock section ---- */
  const unlock = el(`
    <div>
      <h2>Unlock with your password</h2>
      <p class="muted">Type the password you chose when you set up the
      vault. Unlocking happens entirely inside this page — nothing is
      sent anywhere. It takes a few seconds on purpose; that slowness
      is what makes your password hard to crack.</p>
      <div class="box">
        <input type="password" autocomplete="current-password"
               placeholder="Your vault password" aria-label="Vault password" />
        <div style="margin-top:10px">
          <button type="button">Unlock</button>
        </div>
        <progress hidden max="100" value="0" style="margin-top:10px"></progress>
        <p class="err" hidden></p>
      </div>
      <div data-result></div>
    </div>
  `);
  main.appendChild(unlock);

  const input = unlock.querySelector("input")!;
  const button = unlock.querySelector("button")!;
  const bar = unlock.querySelector("progress")!;
  const errLine = unlock.querySelector("p.err") as HTMLElement;
  const result = unlock.querySelector("[data-result]") as HTMLElement;

  async function onUnlock() {
    const password = input.value;
    if (!password) return;
    button.disabled = true;
    errLine.hidden = true;
    bar.hidden = false;
    bar.value = 0;
    try {
      const kek = await deriveOwnerKek(password, b64decode(data!.password_salt_b64), {
        memKiB: data!.password_kdf_mem_kib,
        iters: data!.password_kdf_iters,
        onProgress: (pct) => {
          bar.value = Math.round(pct * 100);
        },
      });
      let xprv: string;
      try {
        const pt = xchacha20poly1305(
          kek,
          b64decode(data!.owner_xprv_nonce_b64),
        ).decrypt(b64decode(data!.owner_xprv_ct_b64));
        xprv = new TextDecoder().decode(pt);
      } finally {
        kek.fill(0);
      }
      showUnlocked(xprv);
    } catch {
      errLine.textContent =
        "That password didn't work. Check for typos and try again — " +
        "it's the same password you use to sign in.";
      errLine.hidden = false;
    } finally {
      bar.hidden = true;
      button.disabled = false;
    }
  }
  button.addEventListener("click", () => void onUnlock());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void onUnlock();
  });

  function showUnlocked(xprv: string) {
    result.textContent = "";
    result.appendChild(
      el(`
      <div class="box danger">
        <p class="warn" style="margin-top:0"><strong>⚠ Your secret key is now
        on screen.</strong> Anyone who sees the text below can take this
        vault's Bitcoin. Close this page when you're done, and never
        send these lines to anyone you don't fully trust.</p>
      </div>
    `),
    );

    // Splice the xprv into the descriptors so they import into
    // Bitcoin Core (or another miniscript-aware wallet) as spending
    // wallets. The descriptors
    // embed the account XPUB; deriving it from the xprv tells us the
    // exact substring to replace. Falls back to bare-key display if
    // the splice doesn't match (it always should).
    let spliced = false;
    try {
      const versions = bip32Versions(data!.network);
      const xpub = HDKey.fromExtendedKey(xprv, versions).publicExtendedKey;
      if (data!.descriptor_external.includes(xpub)) {
        result.appendChild(
          el(`<h2>Your spending wallet (import this)</h2>`),
        );
        result.appendChild(
          el(`<p class="muted">This vault uses a Taproot timelock
          script, so it needs <strong>Bitcoin Core</strong> (version 26
          or newer): run <code>bitcoin-cli importdescriptors</code> with
          the line below and it can both watch and spend. Everyday
          wallets like Sparrow, Electrum, and phone wallets cannot open
          this vault, and <strong>Liana cannot either</strong> — it only
          accepts its own descriptor shape. Bitcoin Core is the surest
          tool. If you are not comfortable with it, ask a Bitcoin-savvy
          person to help: this file is all they need.</p>`),
        );
        result.appendChild(
          copyBlock(
            "Receive descriptor (with secret key)",
            data!.descriptor_external.split(xpub).join(xprv),
          ),
        );
        result.appendChild(
          copyBlock(
            "Change descriptor (with secret key)",
            data!.descriptor_internal.split(xpub).join(xprv),
          ),
        );
        spliced = true;
      }
    } catch {
      // fall through to bare key
    }

    result.appendChild(el(`<h2>Your secret key on its own</h2>`));
    result.appendChild(
      el(`<p class="muted">${
        spliced
          ? "Only needed if a wallet asks for the key separately."
          : "Give this and the watch-only descriptors below to the wallet — together they restore spending."
      } Derivation path: m/86'/${data!.network === "bitcoin" ? 0 : 1}'/0'.</p>`),
    );
    result.appendChild(copyBlock("Account secret key (xprv)", xprv));
  }

  /* ---- watch-only + help sections ---- */
  main.appendChild(
    el(`
    <div>
      <h2>Just want to check the money is there?</h2>
      <p class="muted">No password needed for this part. The simplest
      way: open a block explorer like mempool.space and search for the
      deposit address you funded. You will see the balance and every
      payment, with GhostKey nowhere in the loop. To watch the whole
      vault, import a descriptor below into Bitcoin Core (version 26 or
      newer), which understands the timelock. Ordinary wallets like
      Sparrow, and even Liana, cannot read these.</p>
    </div>
  `),
  );
  main.appendChild(copyBlock("Receive descriptor (watch-only)", data.descriptor_external));
  main.appendChild(copyBlock("Change descriptor (watch-only)", data.descriptor_internal));

  main.appendChild(
    el(`
    <div>
      <h2>Good to know</h2>
      <ol class="muted">
        <li>This vault is on the <strong>${esc(data.network)}</strong> network.</li>
        <li>The inheritance timer is part of the Bitcoin script itself:
        if ${data.timelock_blocks.toLocaleString()} blocks
        (about ${Math.round((data.timelock_blocks * 10) / 60 / 24)} days)
        pass without the money moving, your heir's key can also spend it.
        Moving the funds with your key restarts that clock.</li>
        <li>If you're stuck, any Bitcoin-savvy person can help using just
        this file — show them this page. They do not need your password
        to verify the funds exist.</li>
      </ol>
      <p class="muted">Vault reference: <span class="mono">${esc(data.vault_id)}</span></p>
    </div>
  `),
  );
}

render();
