import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `npm run dev`, browser requests to `/api/*` are proxied to the
// ghostkey-server bound on 127.0.0.1:8787. In production we expect the
// server to be reverse-proxied at the same origin (or CORS-allowed,
// which the server already does in dev).
export default defineConfig({
  plugins: [react()],
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
