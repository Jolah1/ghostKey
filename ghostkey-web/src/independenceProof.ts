/**
 * Independence-proof download assembly.
 *
 * Takes the static kit template (built by vite.kit.config.ts into
 * /independence-proof.html — a single self-contained file), splices
 * this vault's data into its JSON placeholder, and hands the result
 * to the browser as a download. Everything happens client-side; the
 * server never sees that a proof was generated and never learns
 * anything it didn't already store.
 *
 * What goes into the file:
 *   - the descriptor pair (public; lets any wallet SEE the funds)
 *   - the owner's xprv ciphertext + Argon2id parameters, exactly as
 *     the server stores them — still locked under the sign-in
 *     password. The file adds NO new secrets and weakens nothing:
 *     anyone who steals it is in the same position as someone who
 *     stole the server's database row.
 */
import { api, type VaultView } from "./api";
import { sealUnderPassword } from "./crypto/sealing";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const PLACEHOLDER = "__GHOSTKEY_KIT_DATA__";

/** Mirrors KitData in src/kit/main.ts — keep in sync. */
interface KitData {
  v: 1;
  /** "owner": the owner's recovery kit, sealed under their sign-in
   *  password. "heir": the heir envelope, sealed under a one-off
   *  passphrase the owner keeps with the file. The two differ only in
   *  the kit page's wording and which spend branch the signer takes —
   *  the `*_xprv_*` fields below carry whichever party's account xprv
   *  matches `role`. */
  role: "owner" | "heir";
  generated_at: string;
  label: string | null;
  vault_id: string;
  network: string;
  timelock_blocks: number;
  descriptor_external: string;
  descriptor_internal: string;
  password_salt_b64: string;
  password_kdf_mem_kib: number;
  password_kdf_iters: number;
  owner_xprv_ct_b64: string;
  owner_xprv_nonce_b64: string;
}

/** Fetch the static kit template (built by vite.kit.config.ts into a
 *  single self-contained file) and sanity-check the data placeholder is
 *  present. */
async function fetchTemplate(): Promise<string> {
  const resp = await fetch("/independence-proof.html");
  if (!resp.ok) {
    throw new Error("Couldn't load the recovery template. Try again in a moment.");
  }
  const template = await resp.text();
  if (!template.includes(PLACEHOLDER)) {
    throw new Error("The recovery template looks corrupted. Try a hard reload.");
  }
  return template;
}

/** Splice a vault's data into the template's JSON placeholder.
 *  `<` is escaped the standard JSON way so it can't break out of the
 *  inline <script>; split/join (not replace) so `$` in the data can't
 *  be misread as a replacement pattern. */
function spliceKit(template: string, data: KitData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return template.split(PLACEHOLDER).join(json);
}

/** Turn an arbitrary label into a short filesystem-safe slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Hand an HTML string to the browser as a download. */
function triggerDownload(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Build and download the proof for one vault. Throws with a
 * user-renderable message when the vault can't produce one (legacy
 * non-password vaults have no sealed xprv).
 */
export async function downloadIndependenceProof(
  vault: VaultView,
  ownerToken: string,
): Promise<void> {
  if (!vault.descriptor_external || !vault.descriptor_internal) {
    throw new Error(
      "This vault's wallet details aren't available yet. Reload the page and try again.",
    );
  }

  // Sealed blobs: 400 on legacy (non-password) vaults.
  const blobs = await api.getSealedBlobs(vault.id, ownerToken);

  const data: KitData = {
    v: 1,
    role: "owner",
    generated_at: new Date().toISOString(),
    label: vault.label ?? null,
    vault_id: vault.id,
    network: vault.network,
    timelock_blocks: vault.timelock_blocks,
    descriptor_external: vault.descriptor_external,
    descriptor_internal: vault.descriptor_internal,
    password_salt_b64: blobs.password_salt_b64,
    password_kdf_mem_kib: blobs.password_kdf_mem_kib,
    password_kdf_iters: blobs.password_kdf_iters,
    owner_xprv_ct_b64: blobs.owner_xprv_ct_b64,
    owner_xprv_nonce_b64: blobs.owner_xprv_nonce_b64,
  };

  const template = await fetchTemplate();
  const html = spliceKit(template, data);
  const slug = slugify(vault.label ?? vault.id);
  triggerDownload(html, `ghostkey-recovery-${slug || "vault"}.html`);
}

/* -------------------------------------------------------------------------- *
 *  Heir envelope (block A)                                                   *
 *                                                                            *
 *  The owner-stored fallback for "GhostKey is gone before the heir ever      *
 *  claims." Built once, at setup, because that is the only moment the        *
 *  owner's browser holds the heir's xprv. It seals that xprv under a         *
 *  one-off passphrase (NOT the owner's sign-in password) so the owner can    *
 *  hand the file down without sharing their account password, and the heir   *
 *  branch is timelocked so the file is inert until the owner is truly gone.  *
 * -------------------------------------------------------------------------- */

export interface HeirEnvelopeParams {
  vaultId: string;
  label: string | null;
  network: string;
  timelockBlocks: number;
  descriptorExternal: string;
  descriptorInternal: string;
  heirName: string;
  /** The heir's account xprv, live in memory only at setup time. */
  heirXprv: string;
  /** Optional KDF progress callback (Argon2id seal runs ~1-3s). */
  onProgress?: (pct: number) => void;
}

export interface HeirEnvelope {
  /** Suggested download filename. */
  filename: string;
  /** The self-contained HTML, with the heir xprv sealed inside. */
  html: string;
  /** The passphrase that unlocks it. Show once; the owner keeps it
   *  with the file. We never persist it. */
  passphrase: string;
}

/**
 * Build (but do not download) a heir envelope. Returns the assembled
 * HTML plus the passphrase to show the owner. The caller decides when
 * to trigger the download (e.g. a button on the setup success screen)
 * via {@link downloadHeirEnvelope}.
 */
export async function buildHeirEnvelope(p: HeirEnvelopeParams): Promise<HeirEnvelope> {
  const passphrase = generatePassphrase();
  const sealed = await sealUnderPassword(
    passphrase,
    new TextEncoder().encode(p.heirXprv),
    p.onProgress,
  );

  const data: KitData = {
    v: 1,
    role: "heir",
    generated_at: new Date().toISOString(),
    label: p.label,
    vault_id: p.vaultId,
    network: p.network,
    timelock_blocks: p.timelockBlocks,
    descriptor_external: p.descriptorExternal,
    descriptor_internal: p.descriptorInternal,
    password_salt_b64: sealed.password_salt_b64,
    password_kdf_mem_kib: sealed.password_kdf_mem_kib,
    password_kdf_iters: sealed.password_kdf_iters,
    owner_xprv_ct_b64: sealed.blob.ct,
    owner_xprv_nonce_b64: sealed.blob.nonce,
  };

  const template = await fetchTemplate();
  const html = spliceKit(template, data);
  const slug = slugify(p.heirName || p.label || "heir");
  return {
    filename: `ghostkey-for-${slug || "heir"}.html`,
    html,
    passphrase,
  };
}

/** Trigger the browser download for a pre-built envelope. */
export function downloadHeirEnvelope(env: HeirEnvelope): void {
  triggerDownload(env.html, env.filename);
}

/**
 * A short, writable passphrase: five words from the BIP39 wordlist,
 * hyphen-joined. ~55 bits of entropy, hardened by the Argon2id seal —
 * unbruteforceable in practice for a timelocked secret, while still
 * being something a person can copy onto paper. Uses the platform
 * CSPRNG with rejection sampling to avoid modulo bias.
 */
function generatePassphrase(words = 5): string {
  const n = wordlist.length; // 2048
  const max = Math.floor(0x100000000 / n) * n;
  const out: string[] = [];
  const buf = new Uint32Array(1);
  while (out.length < words) {
    crypto.getRandomValues(buf);
    if (buf[0] >= max) continue; // reject to keep the distribution uniform
    out.push(wordlist[buf[0] % n]);
  }
  return out.join("-");
}
