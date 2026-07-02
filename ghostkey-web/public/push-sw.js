// Web push handlers, pulled into the Workbox-generated service worker
// via `workbox.importScripts` in vite.config.ts. Kept as a separate
// classic script (not a module) because Workbox's generated SW uses
// importScripts(), which only loads classic scripts.
//
// The payload arrives already decrypted by the browser push stack
// (the server encrypts per RFC 8291; see crates/ghostkey-server/src/
// push.rs). It's a small JSON object: { title, body, url }.
//
// When `url` is a one-tap check-in link, the notification carries an
// "I'm still here" action button (#224). Tapping it completes the
// check-in straight from the notification — a POST to the same
// token-authenticated endpoint the link's page calls — without
// opening the app at all. Browsers that don't support notification
// actions (iOS) simply don't render the button; tapping the body
// still opens the check-in page, which checks in on load.

/** Parse "https://host/#/checkin-link/<vaultId>/<token>" into the
 *  parts the check-in API call needs. Null for any other URL shape,
 *  so alarm fallbacks like "#/checkin" never grow a dead button. */
function parseCheckinLink(url) {
  try {
    const u = new URL(url);
    const m = /^#\/checkin-link\/([^/]+)\/([^/]+)$/.exec(u.hash);
    if (!m) return null;
    return { vaultId: m[1], token: m[2] };
  } catch {
    return null;
  }
}

/** Focus an open GhostKey tab on `url`, or open a new one. Mobile
 *  PWAs especially: openWindow on top of a running app produces two
 *  instances on some Android browsers. */
function openUrl(url) {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((clients) => {
      for (const client of clients) {
        if ("navigate" in client && "focus" in client) {
          return client.navigate(url).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(url);
    });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload still surfaces a notification — a silent
    // drop here would defeat the whole point of a check-in reminder.
  }
  const title = data.title || "GhostKey";
  const url = data.url || "/";
  const options = {
    body: data.body || "Open GhostKey to check in.",
    icon: "/pwa-192x192.png",
    badge: "/pwa-64x64.png",
    // One stable tag: a reminder retried by the server (or a
    // reminder followed by the missed-deadline alarm) replaces the
    // previous notification instead of stacking up.
    tag: "ghostkey-checkin",
    data: { url },
  };
  if (parseCheckinLink(url)) {
    options.actions = [{ action: "checkin", title: "I'm still here" }];
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/";

  // The "I'm still here" action: check in without opening the app.
  const link = event.action === "checkin" ? parseCheckinLink(url) : null;
  if (link) {
    event.waitUntil(
      (async () => {
        let status = 0;
        try {
          // Same-origin on purpose: the SW's own origin is where the
          // app is served, and /api is proxied there (vercel.json).
          // The payload URL's host can be the "other" domain alias —
          // a cross-origin fetch from a SW would just hit CORS.
          const resp = await fetch(
            `${self.location.origin}/api/vaults/` +
              `${encodeURIComponent(link.vaultId)}` +
              `/checkin-from-link/${encodeURIComponent(link.token)}`,
            { method: "POST" },
          );
          status = resp.status;
        } catch {
          // Offline / server unreachable: fall through to the page,
          // which shows a real error instead of a silent nothing.
        }
        // 2xx = checked in now; 409 = this cycle's link was already
        // used, which means the check-in is already covered. Both are
        // good news — say so and stop.
        if ((status >= 200 && status < 300) || status === 409) {
          await self.registration.showNotification("You're checked in", {
            body:
              status === 409
                ? "This period was already covered. Nothing else to do."
                : "Done. Your countdown has been reset.",
            icon: "/pwa-192x192.png",
            badge: "/pwa-64x64.png",
            tag: "ghostkey-checkin",
          });
          return;
        }
        // Stale token, or anything unexpected: the page explains and
        // offers the working path.
        await openUrl(url);
      })(),
    );
    return;
  }

  event.waitUntil(openUrl(url));
});
