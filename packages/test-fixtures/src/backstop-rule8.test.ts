// scripts/check-boundaries.sh rule 8 (D-18, PROJ-13): no file in
// packages/launchers or packages/service starts a process through a shell.
//
// Each case runs a copy of the REAL script in a throwaway repository under
// the OS temp directory (gate-repo.ts) holding one tracked probe file, so
// nothing is ever written into the real working tree or its index.

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";
const PROBE = "packages/service/src/rule8-probe.ts";
const RULE8 = "starts a process through a shell";

// Assembled at runtime so this file never reads as a spawn call itself.
const FORBIDDEN = ["exec", "Sync"].join("");
const SHELL_PROBE = `import { ${FORBIDDEN} } from "node:child_process";\n\nexport const listing = ${FORBIDDEN}("ls -la");\n`;
const ARGV_PROBE = `import { execFile } from "node:child_process";\n\nexecFile("ls", ["-la"], () => {});\n`;

describe("check-boundaries.sh rule 8 -- no shell spawn in launchers or service (D-18)", () => {
  const repos: GateRepo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.dispose();
  });

  function backstopWithProbe(probe: string, path: string = PROBE) {
    const repo = gateRepo([SCRIPT], { [path]: probe });
    repos.push(repo);
    return repo.run(SCRIPT);
  }

  it("fires on a bare shell-running call in packages/service", () => {
    const result = backstopWithProbe(SHELL_PROBE);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain(RULE8);
    expect(result.out).toContain(PROBE);
  }, 30_000);

  it("fires on the same call in packages/launchers", () => {
    const path = "packages/launchers/src/rule8-probe.ts";
    const result = backstopWithProbe(SHELL_PROBE, path);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain(path);
  }, 30_000);

  it("stays silent on execFile with an argv array -- the rule discriminates", () => {
    const result = backstopWithProbe(ARGV_PROBE);
    expect(result.out).not.toContain(RULE8);
    expect(result.status).toBe(0);
  }, 30_000);
});
