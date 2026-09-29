import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Process-spawn + socket-poll integration tests legitimately take
    // longer than vitest's 5s default; the e2e skeleton test starts a
    // real service subprocess several times.
    testTimeout: 20000,
    hookTimeout: 20000,
    // visual/ holds Playwright specs (plan 03-09), run by `pnpm exec playwright
    // test`, never by vitest: vitest would execute test.skip() at module scope
    // and fail the whole package.
    exclude: ["**/node_modules/**", "**/dist/**", "visual/**"],
    // Every test file gets a throwaway CCC_RUNTIME_DIR (never the real one).
    setupFiles: ["./src/isolate-runtime-dir.setup.ts"],
  },
});
