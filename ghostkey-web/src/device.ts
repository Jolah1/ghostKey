/**
 * Keeping GhostKey working on this device.
 *
 * 1. `keepDeviceData` asks the browser to keep GhostKey's saved data
 *    (your locked sign-in pass) instead of clearing it when space runs
 *    low. Without it, a browser can quietly forget the device, and the
 *    next sign-in looks like a brand-new device (an email link). Installed
 *    apps are usually granted this without a prompt.
 *
 * 2. `watchForUpdates` keeps an installed app current. The service worker
 *    already downloads each new version and takes over at once, but the
 *    open page kept running the old code until it was fully closed and
 *    reopened. Now it checks for a new version when the app opens, when
 *    it comes back to the screen, and hourly, and reloads at a safe
 *    moment: when the app comes back to the screen or when you move to
 *    another page, never while you're typing.
 */

export function keepDeviceData(): void {
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* not supported: nothing to do */
  }
}

const HOUR_MS = 60 * 60 * 1000;

export function watchForUpdates(): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // A first-ever install also changes the controller; that isn't an
  // update and needs no reload.
  let hadController = Boolean(sw.controller);
  let updateReady = false;

  const reloadSoon = () => {
    if (!updateReady) return;
    updateReady = false;
    window.location.reload();
  };

  sw.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    updateReady = true;
    // Already in the background: reload now, so it's fresh on return.
    if (document.visibilityState === "hidden") reloadSoon();
  });
  // Safe moments to swap in the new version.
  window.addEventListener("hashchange", reloadSoon);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reloadSoon();
  });

  window.addEventListener("load", () => {
    sw.register("/sw.js", { scope: "/" })
      .then((reg) => {
        const check = () => void reg.update().catch(() => undefined);
        window.setInterval(check, HOUR_MS);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
      })
      .catch(() => undefined);
  });
}
