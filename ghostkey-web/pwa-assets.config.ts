/**
 * Config for `@vite-pwa/assets-generator`.
 *
 * Rasterises `public/favicon.svg` (the ghost-on-orange tile) into the
 * PNG sizes a Progressive Web App actually needs:
 *
 *   - 192px / 512px PNG — the two icons the spec requires for "Add
 *     to home screen" on Android Chrome and the install dialog on
 *     desktop Chrome / Edge.
 *   - 512px maskable PNG — Android adaptive icons crop to the
 *     largest inscribed circle, so we keep a safe zone. The SVG
 *     already has 1px of padding around the rounded tile, which
 *     the preset extends into the full maskable safe zone.
 *   - 180px PNG (`apple-touch-icon`) — the only iOS asks for; iOS
 *     PWAs read this when the user "Add to Home Screen"s.
 *
 * Generated assets land in `public/` and are referenced by the
 * manifest declared in `vite.config.ts`. Regenerate with:
 *
 *     npm run pwa:icons
 *
 * after editing the source SVG. The PNGs are checked into git so
 * `npm run build` works without an extra step in CI.
 */
import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    // Apple touch icon size — iOS uses 180×180 as the canonical
    // home-screen icon since iOS 14+. The preset already targets
    // this size, but spell it out to be explicit.
    apple: { sizes: [180], padding: 0.0, resizeOptions: { background: "#F7931B" } },
  },
  images: ["public/favicon.svg"],
});
