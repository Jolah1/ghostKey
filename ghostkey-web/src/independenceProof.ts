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

const PLACEHOLDER = "__GHOSTKEY_KIT_DATA__";

/** Mirrors KitData in src/kit/main.ts — keep in sync. */
interface KitData {
  v: 1;
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

/**
 * Build and download the proof for one vault. Throws with a
 * user-renderable message when the vault can't produce one (legacy
 * non-password vaults have no sealed xprv).
 */
export async function downloadIndependenceProof(vault: VaultView): Promise<void> {
  if (!vault.descriptor_external || !vault.descriptor_internal) {
    throw new Error(
      "This vault's wallet details aren't available yet — reload the page and try again.",
    );
  }

  // Sealed blobs: 400 on legacy (non-password) vaults.
  const blobs = await api.getSealedBlobs(vault.id);

  const data: KitData = {
    v: 1,
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

  const resp = await fetch("/independence-proof.html");
  if (!resp.ok) {
    throw new Error("Couldn't load the proof template. Try again in a moment.");
  }
  const template = await resp.text();
  if (!template.includes(PLACEHOLDER)) {
    throw new Error("The proof template looks corrupted. Try a hard reload.");
  }

  // `<` must not appear raw inside an inline <script> block — escape
  // it the standard JSON way. split/join instead of replace() so `$`
  // sequences in the data can't be misread as replacement patterns.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = template.split(PLACEHOLDER).join(json);

  const slug = (vault.label ?? vault.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ghostkey-recovery-${slug || "vault"}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
