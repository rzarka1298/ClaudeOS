import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * FIX1B B-M6: the service the harness spawns must never probe this machine's real `claude` or
 * `codex` install. Spawning needs a built service, so this pins the environment block in the
 * source: both "candidates disabled" variables are set to "1" ahead of the caller's `env`
 * override, next to the Codex home variables.
 */
describe("the service harness seals the owner's Claude and Codex installs off", () => {
  const source = readFileSync(new URL("./service-harness.ts", import.meta.url), "utf8");
  const block = /env: \{\s*\.\.\.process\.env,([\s\S]*?)\.\.\.env,/.exec(source)?.[1] ?? "";

  it("sets both disabled flags in the spawn environment", () => {
    expect(block).toMatch(/CCC_CODEX_CANDIDATES_DISABLED: "1"/);
    expect(block).toMatch(/CCC_CLAUDE_CANDIDATES_DISABLED: "1"/);
    expect(block).toMatch(/CCC_CODEX_HOME:/);
  });
});
