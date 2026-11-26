import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// During `npm run dev`, browser requests to `/api/*` are proxied to the
// ghostkey-server bound on 127.0.0.1:8787. In production we expect the
// server to be reverse-proxied at the same origin (or CORS-allowed,
// which the server already does in dev).
//
// Set DEV_PROXY_TARGET to point dev at a remote backend (e.g. the signet
// app for the live e2e) without hitting CORS — the browser still talks
// same-origin to localhost and Vite proxies server-side.
//
// Local `process` declaration so this typechecks without pulling in
// @types/node for the whole web project; Vite evaluates this file in Node.
declare const process: { env: Record<string, string | undefined> };
const DEV_PROXY_TARGET = process.env.DEV_PROXY_TARGET ?? "http://127.0.0.1:8787";

// The installed app serves pages from its offline copy of index.html, and
// that copy keeps the response headers it was saved with, including the
// Content-Security-Policy. The copy is only refetched when index.html's
// revision changes, so a header-only deploy (vercel.json) never reached
// installed apps: #451 allowed the wasm signer, but phones kept the old
// policy and sends still failed. Folding the headers into the revision
// makes any header change refresh the offline copy.
const HEADERS_REV = createHash("sha256")
  .update(JSON.stringify(JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).headers))
  .digest("hex")
  .slice(0, 16);
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
      // We register the worker ourselves (src/device.ts) so an open app
      // reloads into a new version at a safe moment, instead of running
      // old code until it's fully closed.
      injectRegister: false,
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
        name: "GhostKey: Stack sats. Build your future.",
        short_name: "GhostKey",
        description:
          "A bitcoin savings plan on your own key. Save on-chain or by Lightning, set goals, and if you ever stop signing in, the people you chose can claim it.",
        // Hash-driven routing means everything lives at "/"; the
        // app reads the fragment after the URL settles.
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // Splash background on Android + iOS PWA install. Matches
        // the dark theme's `--bg` so the splash blends straight
        // into the dashboard without a white flash.
        background_color: "#090D12",
        // The status-bar / OS UI tint. Matches the navy ground of
        // the shield icon so the installed app reads as one piece.
        theme_color: "#10151B",
        lang: "en",
        categories: ["finance", "utilities"],
        // Ask the browser to open GhostKey links (like the sign-in email)
        // in the installed app rather than a browser tab, where it can
        // (Chrome on desktop; Android when the mail app hands links on),
        // reusing the open window.
        handle_links: "preferred",
        launch_handler: { client_mode: ["navigate-existing", "auto"] },
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
        // Same idea for the non-Latin font subsets: @fontsource emits
        // one woff2 per unicode-range (cyrillic, greek, vietnamese…)
        // and the browser only ever downloads the ranges a page uses.
        // Precaching all of them would push ~250 KB of fonts the UI
        // never renders into every install. Latin + latin-ext stay.
        // The 512px icons are only fetched by the OS at install time,
        // never by the running app — no reason to precache them.
        globIgnores: [
          // The in-browser signer (ghostkey-core as wasm, ~5 MB) loads only
          // when you send, which needs the network anyway.
          "**/signer-*.js",
          "**/zxcvbn-*.js",
          "**/inter-{cyrillic,greek,vietnamese}*.woff2",
          "**/inter-tight-{cyrillic,greek,vietnamese}*.woff2",
          "**/pwa-512x512.png",
          "**/maskable-icon-512x512.png",
          // The recovery kit is a one-off download (~5 MB with the inlined
          // signer wasm), not part of the app shell. Never precache it.
          "**/independence-proof.html",
        ],
        // Web push lives in its own classic script so the handlers
        // survive Workbox regenerating the SW body on every build.
        // (push-sw.js sits in public/ and is served at the root.)
        importScripts: ["push-sw.js"],
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.map((e) =>
              e.url === "index.html" ? { ...e, revision: `${e.revision ?? ""}-h${HEADERS_REV}` } : e,
            ),
            warnings: [],
          }),
        ],
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
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        // Remote targets (fly.dev) close idle keep-alive sockets at
        // their edge. http-proxy's default agent then reuses a dead
        // socket: the request either hangs forever (a spinner that
        // never resolves) or dies as an empty-body 500 the UI can
        // only render as "500 Internal Server Error". `agent: false`
        // opens a fresh connection per request — one extra TLS
        // handshake, zero wedged sockets.
        agent: false,
        // And if the target is genuinely down or unreachable, fail
        // fast instead of letting the browser wait on a dead request.
        proxyTimeout: 30_000,
        timeout: 30_000,
        configure: (proxy) => {
          // Turn transport-level proxy failures into the JSON error
          // shape the app's API client knows how to display, instead
          // of an empty 500 (or a hang the user reads as a bug in
          // the product).
          proxy.on("error", (err, _req, res) => {
            const r = res as unknown as {
              headersSent?: boolean;
              writeHead?: (code: number, headers: Record<string, string>) => void;
              end?: (body: string) => void;
            };
            if (r.writeHead && !r.headersSent) {
              r.writeHead(502, { "content-type": "application/json" });
            }
            r.end?.(
              JSON.stringify({
                error: `dev proxy could not reach ${DEV_PROXY_TARGET}: ${err.message}. Is the server up (and DEV_PROXY_TARGET correct)?`,
              }),
            );
          });
        },
      },
    },
  },
});
