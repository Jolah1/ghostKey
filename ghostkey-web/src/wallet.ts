/**
 * WebLN / Alby integration for Lightning-based identity.
 *
 * Spec: https://www.webln.dev/
 *
 * What we use it for:
 *   - Detect a browser-injected Lightning wallet.
 *   - Ask the wallet for the user's identity (node alias / public key)
 *     so the UI can show "you are signed in as @alice".
 *   - Sign messages later when we need to prove the visitor is the
 *     same person who set up a vault.
 *
 * Important: this does NOT give the website spending power over the
 * vault's Bitcoin. It is identity-only.
 *
 * Browsers without WebLN (most of them) get a graceful fallback path:
 * the rest of the app works without a connected wallet, and the
 * "Connect wallet" button explains how to install one.
 */

// Minimal WebLN provider surface as exposed by Alby and others.
// We deliberately don't depend on `webln-types` to keep the bundle tiny.
export interface WebLNProvider {
  enable(): Promise<void>;
  getInfo(): Promise<{
    node?: {
      alias?: string;
      pubkey?: string;
      color?: string;
    };
  }>;
  signMessage?(message: string): Promise<{
    message: string;
    signature: string;
  }>;
  /** Some providers return verifyMessage as well. */
  verifyMessage?(
    signature: string,
    message: string,
  ): Promise<{ valid: boolean; pubkey?: string }>;
}

declare global {
  interface Window {
    webln?: WebLNProvider;
  }
}

export interface WalletIdentity {
  alias: string;
  pubkey: string;
}

export class WalletError extends Error {
  constructor(public kind: "not-installed" | "rejected" | "unsupported" | "failed", message: string) {
    super(message);
    this.name = "WalletError";
  }
}

/** Is a WebLN provider injected into this page? */
export function hasProvider(): boolean {
  return typeof window !== "undefined" && !!window.webln;
}

/**
 * Request permission to use the wallet and return the visitor's
 * Lightning identity.
 */
export async function connect(): Promise<WalletIdentity> {
  if (!hasProvider()) {
    throw new WalletError(
      "not-installed",
      "No Lightning wallet detected. Install Alby (or any WebLN provider) to continue.",
    );
  }
  const provider = window.webln!;
  try {
    await provider.enable();
  } catch (e) {
    throw new WalletError(
      "rejected",
      e instanceof Error ? e.message : "Wallet refused to connect.",
    );
  }
  let info;
  try {
    info = await provider.getInfo();
  } catch (e) {
    throw new WalletError(
      "failed",
      e instanceof Error ? e.message : "Couldn't read wallet info.",
    );
  }
  const pubkey = info.node?.pubkey ?? "";
  const alias = info.node?.alias ?? (pubkey ? pubkey.slice(0, 12) : "anonymous");
  if (!pubkey) {
    throw new WalletError(
      "unsupported",
      "Wallet didn't share an identity (no node pubkey).",
    );
  }
  return { alias, pubkey };
}

/**
 * Ask the connected wallet to sign a message. Used in future flows to
 * tie a vault registration to a specific Lightning identity.
 */
export async function signMessage(message: string): Promise<string> {
  if (!hasProvider()) {
    throw new WalletError("not-installed", "No wallet to sign with.");
  }
  const provider = window.webln!;
  if (!provider.signMessage) {
    throw new WalletError(
      "unsupported",
      "Your wallet doesn't support signing messages.",
    );
  }
  const result = await provider.signMessage(message);
  return result.signature;
}
