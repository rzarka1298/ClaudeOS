import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/isolate-runtime-dir.setup.ts"],
  },
});
