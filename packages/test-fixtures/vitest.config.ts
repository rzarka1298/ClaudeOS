import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Process-spawn + socket-poll integration tests legitimately take
    // longer than vitest's 5s default; the e2e skeleton test starts a
    // real service subprocess several times.
    testTimeout: 20000,
    hookTimeout: 20000,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
