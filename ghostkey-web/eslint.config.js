// Flat config: typescript-eslint recommended + react-hooks + jsx-a11y.
// Scope is correctness and accessibility, not formatting — there is no
// style ruleset here on purpose (the codebase has its own conventions
// and tsc already enforces types in `npm run build`).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  // src/kit/wasm/ is generated wasm-bindgen glue — vendored, not ours to lint.
  { ignores: ["dist/", "dev-dist/", "public/", "*.config.ts", "src/kit/wasm/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The API layer round-trips untyped JSON; `any` at those
      // boundaries is deliberate and visible in code review.
      "@typescript-eslint/no-explicit-any": "off",
      // `catch (e) {}` with an intentionally unused binding is fine.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `<ul role="list">` is NOT redundant here: Safari/VoiceOver
      // strips list semantics from lists styled with
      // `list-style: none` (all of ours, via the Tailwind preflight);
      // the explicit role restores them.
      "jsx-a11y/no-redundant-roles": "off",
      // Fetch-on-mount with a synchronous loading flag
      // (`useEffect(() => { void load(); }, [...])`) is the codebase's
      // idiom; the extra render it costs is deliberate. Revisit if we
      // adopt the React Compiler.
      "react-hooks/set-state-in-effect": "off",
    },
  },
);
