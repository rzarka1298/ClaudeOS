import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Excludes compiled dist/**.test.js so a built package doesn't run its
    // own tests twice (once from src, once from the tsc -b output).
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
