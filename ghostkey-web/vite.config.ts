import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// During `npm run dev`, browser requests to `/api/*` are proxied to the
// ghostkey-server bound on 127.0.0.1:8787. In production we expect the
// server to be reverse-proxied at the same origin (or CORS-allowed,
// which the server already does in dev).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // `autoUpdate` rebuilds the service worker on every deploy and
      // refreshes clients on next navigation. We don't want a stale
      // SW pinning users to an old bundle after we ship a fix, and
      // we deliberately don't prompt — for a single-vault dashboard
      // the silent update path is fine.
      registerType: "autoUpdate",
      // Don't intercept dev-mode requests. The dev server already
      // hot-reloads; layering a service worker on top causes
      // "stale module" confusion when iterating on src/.
      devOptions: { enabled: false },
      // Tell workbox what static assets to precache and how to
      // serve them when offline. Includes the icons we just
      // generated under public/ so an installed PWA cold-starts
      // without a network round-trip for the shell.
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "apple-touch-icon-180x180.png",
      ],
      manifest: {
        name: "GhostKey — Your Bitcoin lives on after you",
        short_name: "GhostKey",
        description:
          "GhostKey lets your Bitcoin live on after you. Tap once a month. If you ever stop, the people you chose can claim what's theirs.",
        // Hash-driven routing means everything lives at "/"; the
        // app reads the fragment after the URL settles.
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // Splash background on Android + iOS PWA install. Matches
        // the dark theme's `--bg` so the splash blends straight
        // into the dashboard without a white flash.
        background_color: "#000000",
        // The status-bar / OS UI tint. Matches the Bitcoin-orange
        // accent in the favicon tile.
        theme_color: "#F7931B",
        lang: "en",
        categories: ["finance", "utilities"],
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the entire app shell (HTML + JS + CSS) so an
        // installed PWA opens instantly and works offline for the
        // read-only screens. API responses are NOT cached — the
        // dashboard polls live state and we never want a stale
        // deadline or balance shown after the user reopens the
        // app a week later.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Don't aggressively cache API GETs. We could runtime-cache
        // /health with a 30s stale-while-revalidate, but the
        // dashboard's own poll already covers that — adding a SW
        // layer doubles the staleness window for no observable
        // win.
        navigateFallback: "/index.html",
        // The Anthropic / LNbits sidecars are not same-origin and
        // shouldn't be intercepted; the SW only handles requests
        // to our own origin by default.
        //
        // The zxcvbn dictionaries (~2 MB raw) are only needed on
        // the create-a-vault password step — precaching them would
        // quintuple every PWA install/update for a screen most
        // sessions never visit. They stay lazy-loaded over the
        // network instead.
        globIgnores: ["**/zxcvbn-*.js"],
        // Web push lives in its own classic script so the handlers
        // survive Workbox regenerating the SW body on every build.
        // (push-sw.js sits in public/ and is served at the root.)
        importScripts: ["push-sw.js"],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Give the zxcvbn dictionary chunks a stable name so the
        // workbox globIgnores above can exclude them from the SW
        // precache.
        manualChunks(id) {
          if (id.includes("@zxcvbn-ts")) return "zxcvbn";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
