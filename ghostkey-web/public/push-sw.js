// Web push handlers, pulled into the Workbox-generated service worker
// via `workbox.importScripts` in vite.config.ts. Kept as a separate
// classic script (not a module) because Workbox's generated SW uses
// importScripts(), which only loads classic scripts.
//
// The payload arrives already decrypted by the browser push stack
// (the server encrypts per RFC 8291; see crates/ghostkey-server/src/
// push.rs). It's a small JSON object: { title, body, url }.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload still surfaces a notification — a silent
    // drop here would defeat the whole point of a check-in reminder.
  }
  const title = data.title || "GhostKey";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Open GhostKey to check in.",
      icon: "/pwa-192x192.png",
      badge: "/pwa-64x64.png",
      // One stable tag: a reminder retried by the server (or a
      // reminder followed by the missed-deadline alarm) replaces the
      // previous notification instead of stacking up.
      tag: "ghostkey-checkin",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Reuse an open GhostKey tab when there is one — mobile PWAs
        // especially: openWindow on top of a running app produces two
        // instances on some Android browsers.
        for (const client of clients) {
          if ("navigate" in client && "focus" in client) {
            return client.navigate(url).then((c) => (c || client).focus());
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
