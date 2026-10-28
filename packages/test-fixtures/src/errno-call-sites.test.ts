// The three readers 09-07 moved onto the shared errno helper stay on it (FIX2B E1).
//
// packages/domain/src/errno.test.ts proves the helper; nothing proved the call sites still use it, so a
// future edit could quietly duck-type `"code" in error` again and drift from the helper's rules (string
// code only, message never read). This pins the three sites by source.
//
// Out of scope here, listed in the FIX2B report as follow-ups: the other duck-typed errno readers
// across the service (for example the local `errnoOf` in packages/service/src/projects/command-runner.ts,
// which returns a string and defaults rather than null).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const CALL_SITES = [
  "packages/service/src/diagnostics/vault-probe.ts",
  "packages/plugin/src/view/tasks-forms-copy.ts",
  "packages/plugin/src/view/approval-detail.tsx",
] as const;

/** What is wrong with `source` as a user of the shared errno helper; empty when it is fine. */
function errnoSiteProblems(source: string): string[] {
  const problems: string[] = [];
  // Comments are stripped so prose that mentions the old pattern does not count as code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/import\s*\{[^}]*\berrnoOf\b[^}]*\}\s*from\s*"@ccc\/domain(\/errno\.js)?"/.test(code)) {
    problems.push("does not import errnoOf from @ccc/domain");
  }
  if (!/\berrnoOf\(/.test(code)) problems.push("never calls errnoOf");
  if (/["']code["']\s+in\s/.test(code)) problems.push('duck-types `"code" in`');
  return problems;
}

describe("FIX2B E1: the 09-07 errno call sites use the shared helper", () => {
  it.each(CALL_SITES)("%s imports and calls errnoOf and no longer duck-types `code`", (path) => {
    expect(errnoSiteProblems(readFileSync(join(REPO_ROOT, path), "utf8")), path).toEqual([]);
  });

  it("the checker flags a missing import, a missing call and a duck-typed reader", () => {
    const ok = 'import { errnoOf } from "@ccc/domain/errno.js";\nconst c = errnoOf(e);\n';
    expect(errnoSiteProblems(ok)).toEqual([]);
    expect(
      errnoSiteProblems('import { errnoOf, type ProbeOutcome } from "@ccc/domain";\nerrnoOf(e);'),
    ).toEqual([]);
    expect(errnoSiteProblems("const c = errnoOf(e);")).toEqual([
      "does not import errnoOf from @ccc/domain",
    ]);
    expect(errnoSiteProblems('import { errnoOf } from "@ccc/domain";')).toEqual([
      "never calls errnoOf",
    ]);
    expect(errnoSiteProblems(`${ok}if ("code" in error) {}`)).toEqual(['duck-types `"code" in`']);
    // A comment that mentions the old pattern is not code.
    expect(errnoSiteProblems(`${ok}// was: "code" in error\n`)).toEqual([]);
  });
});
