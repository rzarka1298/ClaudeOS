import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Phase 4's `launch.ts` declares `TerminalLauncher`, `ProjectLookup` and
 * `LaunchGuard` with different shapes. `index.ts` re-exports both files with
 * `export *`, so a same-named Phase 5 declaration would be an ambiguous
 * re-export (TS2308) the moment the phases merge. Phase 5's ports carry a
 * `Session` prefix until 05-16 reconciles the two files.
 */
const source = readFileSync(new URL("./ports.ts", import.meta.url), "utf8");

function declares(name: string): boolean {
  return new RegExp(`export\\s+(?:interface|type|class|const)\\s+${name}\\b`).test(source);
}

describe("Phase 5 ports do not collide with Phase 4's launch.ts names", () => {
  it("declares none of Phase 4's port names", () => {
    for (const name of [
      "TerminalLauncher",
      "ProjectLookup",
      "LaunchGuard",
      "TerminalLaunchInput",
      "ResolvedProject",
      "ProjectLookupFailure",
      "LaunchGuardInput",
      "LaunchGuardDecision",
    ]) {
      expect(declares(name), name).toBe(false);
    }
  });

  it("declares the Session-prefixed ports instead", () => {
    for (const name of ["SessionTerminalLauncher", "SessionProjectLookup", "SessionLaunchGuard"]) {
      expect(declares(name), name).toBe(true);
    }
  });
});
