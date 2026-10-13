import { describe, expect, it } from "vitest";
import { isRunCurrent } from "./staleness.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";

describe("isRunCurrent and the working tree (Wave 2 review MEDIUM-4)", () => {
  const base = { recordedHead: A, currentHead: A, changedFiles: [] as string[] };

  it("is stale when the recorded run was made on a dirty tree", () => {
    const result = isRunCurrent({ ...base, recordedClean: false, currentClean: true });
    expect(result.current).toBe(false);
    if (!result.current) expect(result.reason).toBe("the run was recorded on a dirty working tree");
  });

  it("is stale when the tree is dirty now, even at an equal HEAD", () => {
    const result = isRunCurrent({ ...base, recordedClean: true, currentClean: false });
    expect(result.current).toBe(false);
    if (!result.current) expect(result.reason).toBe("the working tree has uncommitted changes");
  });

  it("is stale when either clean flag is unknown", () => {
    expect(isRunCurrent({ ...base, currentClean: true }).current).toBe(false);
    expect(isRunCurrent({ ...base, recordedClean: true }).current).toBe(false);
  });

  it("is current when both trees are clean at an equal HEAD", () => {
    expect(isRunCurrent({ ...base, recordedClean: true, currentClean: true })).toEqual({
      current: true,
    });
  });

  it("is stale for a dirty current tree after non-product commits too", () => {
    const result = isRunCurrent({
      recordedHead: A,
      currentHead: B,
      changedFiles: ["docs/x.md"],
      recordedClean: true,
      currentClean: false,
    });
    expect(result.current).toBe(false);
  });
});

describe("product paths (Wave 3 WR-06)", () => {
  const input = (changed: string[]) => ({
    recordedHead: A,
    currentHead: B,
    changedFiles: changed,
    recordedClean: true,
    currentClean: true,
  });

  it.each([
    "packages/e2e/specs/approvals-core.e2e.ts",
    "packages/e2e/src/report.ts",
    "packages/e2e/package.json",
    ".claude/settings.json",
    ".claude/hooks/pre-tool.sh",
  ])("a change to %s makes the run stale", (file) => {
    expect(isRunCurrent(input([file])).current).toBe(false);
  });

  it.each([
    "packages/e2e/src/report.test.ts",
    ".claude/skills/x/SKILL.md",
    ".claude/worktrees/agent-1/file.ts",
    ".planning/STATE.md",
  ])("a change to %s leaves the run current", (file) => {
    expect(isRunCurrent(input([file])).current).toBe(true);
  });
});
