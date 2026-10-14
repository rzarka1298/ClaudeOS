import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Process-spawn and filesystem tests legitimately take longer than the 5s default.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Pure logic only (D-03): wdio specs, the smoke and spike probes and every *.e2e.ts file
    // run through `wdio`, never through vitest, so a GUI launch can never happen in CI.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "specs/**", "smoke/**", "**/*.e2e.ts"],
    // Every test file gets a throwaway CCC_RUNTIME_DIR (never the real one).
    setupFiles: ["./src/isolate-runtime-dir.setup.ts"],
  },
});
