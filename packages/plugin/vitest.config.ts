import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// JSX transform: Vitest 4's default oxc transform reads `tsconfig.json`'s
// `jsx`/`jsxImportSource` directly (this package's tsconfig already sets
// `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`), so no separate
// esbuild/oxc JSX option is needed here — setting one produces a
// "both esbuild and oxc options were set" warning for no effect.
export default defineConfig({
  test: {
    environment: "jsdom",
    // Excludes compiled dist/**.test.js so a built package doesn't run its
    // own tests twice (once from src, once from the tsc -b output).
    exclude: ["**/node_modules/**", "**/dist/**"],
    // jsdom 30 ships no `window.matchMedia`, so any module subscribing to a
    // media query cannot execute without a stand-in. Same rationale as the
    // `obsidian` alias below: ONE shared, reviewable double rather than a
    // per-test stub that can drift. See `src/test-support/jsdom-setup.ts`.
    setupFiles: ["./src/test-support/jsdom-setup.ts"],
  },
  resolve: {
    // The `obsidian` package is types-only (`"main": ""`) -- the real
    // implementation comes from the Obsidian application at runtime, and
    // `esbuild.config.mjs` externalises it from the bundle for exactly that
    // reason. So any module importing an obsidian VALUE has nothing to load
    // under a test runner. This alias points those imports at one shared,
    // reviewable stand-in; see `src/test-support/obsidian-stub.ts`.
    //
    // Test-time only: `tsc -b` still resolves `obsidian` to the real
    // `obsidian.d.ts`, so the stub can never become the type source of
    // truth, and the production bundle never sees this file.
    alias: {
      obsidian: fileURLToPath(new URL("./src/test-support/obsidian-stub.ts", import.meta.url)),
    },
  },
});
