import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Audit (04-09 Tasks 2-3): the ADR-07 record, the ADR-0011 supersession note
// and the owner spike record had no automated check.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("audit: ADR-0024 records ADR-07 (D-17, D-48, PR-01)", () => {
  const adr = read("docs/adr/0024-launchers-and-project-actions.md");

  it("carries the ADR-07 marker and every required section", () => {
    expect(adr).toContain("satisfies: ADR-07");
    for (const heading of [
      "## Mechanisms",
      "## Quoting rule",
      "## Script lifecycle",
      "## Adapter interface",
      "## Permission matrix",
      "## Error taxonomy",
      "## claude-cli:// considered and not chosen",
      "## Residual risks",
    ]) {
      expect(adr).toContain(heading);
    }
  });

  it("names the open -b / -R mechanisms, the three ports, bundle-ID targeting and the proof test", () => {
    expect(adr).toContain("open -b");
    expect(adr).toContain("open -R");
    expect(adr).toMatch(/Bundle ID versus name/);
    for (const port of ["TerminalLauncher", "ProjectLookup", "LaunchGuard"]) {
      expect(adr).toContain(port);
    }
    const proof = "packages/service/src/projects/terminal-handoff.proof.test.ts";
    expect(adr).toContain(proof);
    expect(existsSync(join(repoRoot, proof))).toBe(true);
  });

  it("ADR-0011 is marked superseded in part by ADR-0024", () => {
    expect(read("docs/adr/0011-launcher-generated-script.md")).toMatch(
      /Superseded in part by ADR-0024/,
    );
  });
});

describe("audit: the owner spike outcome is recorded (PR-04, PR-10, D-46)", () => {
  const spike = read(".planning/phases/04-projects-launchers/04-09-SPIKE.md");

  it("has an outcome line for A1, A2, A3, A6 and A11", () => {
    for (const id of ["A1", "A2", "A3", "A6", "A11"]) {
      expect(spike).toMatch(new RegExp(`## ${id} —[^\\n]*\\n+\\*\\*Outcome: [a-z]`));
    }
  });

  it("holds no absolute home path (outcomes only)", () => {
    expect(spike).not.toMatch(/\/Users\/|\/private\/var\//);
  });
});
