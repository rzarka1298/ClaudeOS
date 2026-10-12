import { describe, expect, it } from "vitest";
import { changedProductFiles, isRunCurrent } from "./staleness.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";

function check(changed: string[] | null, recorded: string | undefined = A, now: string = B) {
  return isRunCurrent({
    recordedHead: recorded,
    currentHead: now,
    changedFiles: changed,
    recordedClean: true,
    currentClean: true,
  });
}

describe("isRunCurrent (Test 4)", () => {
  it("is current when the recorded HEAD is the present HEAD, whatever the file list", () => {
    expect(check(["packages/service/src/x.ts"], A, A)).toEqual({ current: true });
  });

  it("is current when only planning documents, the e2e package or docs changed", () => {
    expect(
      check([
        ".planning/phases/06/06-UAT.md",
        ".planning/STATE.md",
        "packages/e2e/src/report.ts",
        "packages/e2e/package.json",
        "docs/adr/0020-x.md",
        "README.md",
        "CHANGELOG.md",
      ]),
    ).toEqual({ current: true });
  });

  it("is current for an empty change list", () => {
    expect(check([])).toEqual({ current: true });
  });

  it("is stale when a file under another package changed, and names the file", () => {
    const result = check(["packages/plugin/src/main.ts", ".planning/STATE.md"]);
    expect(result).toEqual({
      current: false,
      reason: "product code changed since the run",
      files: ["packages/plugin/src/main.ts"],
    });
  });

  it("is stale for scripts, root manifests, the lockfile and tool configuration", () => {
    for (const file of [
      "scripts/check-privacy.sh",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "eslint.config.mjs",
      "tsconfig.base.json",
      "tsconfig.json",
      "turbo.json",
      "biome.json",
      "vitest.config.ts",
      "packages/plugin/styles.css",
      "packages/service/README.md",
    ]) {
      const result = check([file]);
      expect(result.current, file).toBe(false);
    }
  });

  it("does not treat a path that merely contains an exempt folder name as exempt", () => {
    expect(check(["packages/service/.planning/x.md"]).current).toBe(false);
    expect(check(["packages/plugin/packages/e2e/x.ts"]).current).toBe(false);
    expect(check(["scripts/docs/run.sh"]).current).toBe(false);
  });

  it("caps the file names it returns", () => {
    const many = Array.from({ length: 40 }, (_, index) => `packages/service/src/f${index}.ts`);
    const result = check(many);
    expect(result.current).toBe(false);
    if (!result.current) expect(result.files.length).toBe(10);
  });

  it("is stale with reason 'unknown HEAD' when the recorded HEAD is missing", () => {
    for (const recorded of [undefined, "", "unknown"]) {
      const result = isRunCurrent({
        recordedHead: recorded,
        currentHead: B,
        changedFiles: [],
        recordedClean: true,
        currentClean: true,
      });
      expect(result).toEqual({ current: false, reason: "unknown HEAD", files: [] });
    }
  });

  it("is stale when the present HEAD or the change list cannot be known", () => {
    expect(check([], A, "unknown")).toEqual({ current: false, reason: "unknown HEAD", files: [] });
    expect(check(null)).toEqual({ current: false, reason: "changes unknown", files: [] });
  });
});

describe("changedProductFiles", () => {
  it("returns only the files that count as product code, in order", () => {
    expect(
      changedProductFiles([
        "docs/a.md",
        "packages/domain/src/a.ts",
        "turbo.json",
        "./scripts/x.sh",
      ]),
    ).toEqual(["packages/domain/src/a.ts", "turbo.json", "scripts/x.sh"]);
  });
});
