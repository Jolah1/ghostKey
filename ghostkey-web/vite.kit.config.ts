/**
 * Build config for the independence-proof kit page.
 *
 * Separate from the main vite.config.ts on purpose: the kit must be a
 * SINGLE self-contained HTML file (all JS inlined) so the owner can
 * keep it on a USB stick or in an email and open it from file:// with
 * no server, no internet, and no GhostKey. vite-plugin-singlefile
 * inlines everything, which would be wrong for the main app bundle —
 * hence the second config.
 *
 * Output lands in public/ so the main build (and the dev server)
 * serves it as a static asset at /independence-proof.html. The
 * dashboard fetches it, splices the vault's data into the
 * __GHOSTKEY_KIT_DATA__ placeholder, and hands it to the user as a
 * download. The generated file is gitignored; `npm run build` chains
 * this build before the main one.
 */
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    rollupOptions: {
      input: "independence-proof.html",
    },
    outDir: "public",
    emptyOutDir: false,
    // The kit is one inlined file; chunk-size warnings don't apply.
    chunkSizeWarningLimit: 2048,
  },
});
