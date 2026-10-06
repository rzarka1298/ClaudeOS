// scripts/check-boundaries.sh rules 8, 9 and 10 (05-16 merge reconcile). Phase 4's
// shell rule is rule 8; Phase 5's interrupt-signal and token-forgery rules are
// 9 and 10 after the renumber. Each rule must fire on a planted violation, name
// its own description (so a swapped number or body shows up), stay quiet on the
// allowed neighbour, and the script must still count all ten.

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function backstop(files: Record<string, string>) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, ...files });
  repos.push(repo);
  return repo.run(SCRIPT);
}

// Assembled at runtime so this file is not itself a backstop hit.
const SHELL_EXEC = `import { ${"exec"} } from "node:child_process";\n${"exec"}("ls " + dir);\n`;
const SIGINT_KILL = `process.${"kill"}(pid, "${"SIGINT"}");\n`;
const TOKEN_CAST = `export const t = {} ${"as"} CapabilityToken<"x">;\n`;

const RULE8 = "starts a process through a shell";
const RULE9 = "sends the interrupt signal";
const RULE10 = "forges a CapabilityToken";

describe("check-boundaries.sh rules 8, 9 and 10", () => {
  it("counts ten rules and passes on a clean tree", () => {
    const result = backstop({});
    expect(result.status).toBe(0);
    expect(result.out).toContain("checked 10 rules");
  });

  it("rule 8 fires on a shell-string exec in packages/service, and only rule 8", () => {
    const result = backstop({ "packages/service/src/run-it.ts": SHELL_EXEC });
    expect(result.status).toBe(1);
    expect(result.out).toContain(RULE8);
    expect(result.out).not.toContain(RULE9);
    expect(result.out).not.toContain(RULE10);
    expect(result.out).toContain("packages/service/src/run-it.ts");
  });

  it("rule 8 fires on a shell option set to true in packages/launchers", () => {
    const result = backstop({
      "packages/launchers/src/spawn-it.ts": `spawn("ls", [], { ${"shell"}: true });\n`,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain(RULE8);
  });

  it("rule 8 allows execFile with shell: false and a RegExp .exec( call", () => {
    const result = backstop({
      "packages/service/src/ok.ts": `execFile("ls", [], { ${"shell"}: false });\nconst m = /a/.exec(s);\n`,
    });
    expect(result.status).toBe(0);
  });

  it("rule 9 fires on sending the interrupt signal in packages/service, and only rule 9", () => {
    const result = backstop({ "packages/service/src/stop.ts": SIGINT_KILL });
    expect(result.status).toBe(1);
    expect(result.out).toContain(RULE9);
    expect(result.out).not.toContain(RULE8);
    expect(result.out).not.toContain(RULE10);
  });

  it("rule 9 allows receiving the interrupt signal in the shutdown handler", () => {
    const result = backstop({
      "packages/service/src/shutdown.ts": `process.on("${"SIGINT"}", () => stop());\n`,
    });
    expect(result.status).toBe(0);
  });

  it("rule 10 fires on a CapabilityToken cast in a non-test file, and only rule 10", () => {
    const result = backstop({ "packages/service/src/forge.ts": TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(RULE10);
    expect(result.out).not.toContain(RULE8);
    expect(result.out).not.toContain(RULE9);
  });

  it("rule 10 exempts the same cast in a test file", () => {
    const result = backstop({ "packages/service/src/forge.test.ts": TOKEN_CAST });
    expect(result.status).toBe(0);
  });
});
