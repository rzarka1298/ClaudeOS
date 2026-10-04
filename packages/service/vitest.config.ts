import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Every test file gets a throwaway CCC_RUNTIME_DIR (never the real one).
    setupFiles: ["./src/test-support/isolate-runtime-dir.ts"],
  },
});
