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
  },
});
