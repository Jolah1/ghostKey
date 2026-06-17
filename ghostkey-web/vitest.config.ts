import { defineConfig } from "vitest/config";

// Unit tests live next to the code in src/. The Playwright e2e suite
// under e2e/ uses its own runner (`npm run e2e`) and must be excluded
// here, or vitest tries to execute its test.beforeAll hooks and fails.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
