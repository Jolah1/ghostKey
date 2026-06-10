/**
 * Browser-side web push plumbing.
 *
 * The server's side of this lives in crates/ghostkey-server/src/push.rs
 * (encryption + VAPID) and the `/vaults/:id/push-subscriptions` routes.
 * This module owns the browser half:
 *
 *   - feature detection (`isPushSupported`)
 *   - turning the server's VAPID public key into the
 *     `applicationServerKey` bytes `pushManager.subscribe()` wants
 *   - subscribe / unsubscribe round-trips that keep the server's
 *     `push_subscriptions` table in sync with the browser's state
 *
 * Permission UX note: `subscribeToPush` triggers the browser's
 * notification-permission prompt. Callers must only invoke it from a
 * user gesture (the opt-in card's button), never on page load —
 * browsers punish unsolicited prompts by auto-denying.
 */

import { api } from "./api";

/** True when this browser can do web push at all. iOS Safari only
 *  exposes PushManager to *installed* (Add to Home Screen) PWAs, so
 *  this is genuinely dynamic, not a constant. */
export function isPushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Decode the server's base64url VAPID public key into the BufferSource
 *  shape `pushManager.subscribe({ applicationServerKey })` requires. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The browser's current subscription for our service worker, if any.
 *  Returns null when unsupported, no SW is registered yet, or the
 *  user never subscribed. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Full opt-in flow: permission prompt → pushManager.subscribe →
 * register the subscription with the server. Throws on denial or
 * failure; the caller turns that into farmer-friendly copy.
 */
export async function subscribeToPush(
  vaultId: string,
  ownerToken: string,
  vapidPublicKey: string,
): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("notifications were not allowed");
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // TS lib typing wants BufferSource; a fresh Uint8Array qualifies.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      .buffer as ArrayBuffer,
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    // Should be unreachable per spec; guard so a broken browser
    // can't register a row the server would forever fail to send to.
    await sub.unsubscribe();
    throw new Error("browser returned an incomplete subscription");
  }
  await api.pushSubscribe(
    vaultId,
    {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    ownerToken,
  );
}

/** Tear down both halves: the server row first (while we still know
 *  the endpoint), then the browser subscription. */
export async function unsubscribeFromPush(
  vaultId: string,
  ownerToken: string,
): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(vaultId, sub.endpoint, ownerToken);
  await sub.unsubscribe();
}
