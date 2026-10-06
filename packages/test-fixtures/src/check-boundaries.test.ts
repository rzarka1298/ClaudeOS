// scripts/check-boundaries.sh — the literal grep backstop (ADR-0019 layer 3).
// Only the fixture-tree exclusions are pinned here: the two fixture trees
// exist to violate the rules, so the backstop skips them, and that skip must
// match their REAL paths only. A substring match let any other path that
// merely contained `lint-fixtures/` escape the scan (judge-r1 finding 9).

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";

// Rule 7 (no inline style inside packages/plugin), assembled at runtime so
// this test file is not itself a backstop hit.
const INLINE_STYLE = `export function paint(el: HTMLElement): void {\n  el${"."}style${"."}color = "red";\n}\n`;

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

/** Every repository also tracks one clean source file, so the scan is never empty. */
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };

function backstop(files: Record<string, string>) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, ...files });
  repos.push(repo);
  return repo.run(SCRIPT);
}

describe("check-boundaries.sh fixture exclusions (judge-r1 finding 9)", () => {
  it("skips the real plugin lint-fixtures tree", () => {
    const result = backstop({ "packages/plugin/lint-fixtures/inline-style.ts": INLINE_STYLE });
    expect(result.status).toBe(0);
  });

  it("skips the real boundary-violations tree", () => {
    const result = backstop({
      "packages/test-fixtures/boundary-violations/untrusted/inline-style.ts": `import "obsidian";\n${INLINE_STYLE}`,
    });
    expect(result.status).toBe(0);
  });

  it("still scans a plugin path that merely contains lint-fixtures/", () => {
    const result = backstop({
      "packages/plugin/src/not-lint-fixtures/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/not-lint-fixtures/inline-style.ts");
  });

  it("still scans a plugin path that merely contains boundary-violations/", () => {
    const result = backstop({
      "packages/plugin/src/boundary-violations/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/boundary-violations/inline-style.ts");
  });
});

// The one anchored carve-out from the token-forgery rule (D-02, T-06-01,
// judge-r1 finding 9): the engine's minter file may cast to CapabilityToken,
// no other path may. Forbidden literals are assembled at runtime so this file
// is not itself a backstop hit. Rules are named by their description text, never
// by number (M-4).
const MINTER_PATH = "packages/service/src/approval/mint/mint-token.ts";
const FORGERY_DESCRIPTION = "forges a CapabilityToken";
const TOKEN_CAST = `export const t = {} ${"as"} CapabilityToken<"x">;\n`;
const ANY_IN_MINTER = `import type { CapabilityToken } from "@ccc/domain";\nexport const loose: ${"an"}${"y"} = 1;\nexport type Kept = CapabilityToken<"x">;\n`;

describe("check-boundaries.sh minter carve-out (D-02, T-06-01)", () => {
  it("Case A, quiet: the cast in the single allowed minter path passes", () => {
    const result = backstop({ [MINTER_PATH]: TOKEN_CAST });
    expect(result.out).not.toContain(FORGERY_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("Case B, fires: the same cast at another approval path fails and names it", () => {
    const result = backstop({ "packages/service/src/approval/other.ts": TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain("packages/service/src/approval/other.ts");
  });

  it("Case C, fires (anchored at the start): a path that merely ends with the minter path fails", () => {
    const path = "packages/service/src/not-approval/mint/mint-token.ts";
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(path);
  });

  it("Case C2, fires (anchored at the start): a prefix-extended minter path fails", () => {
    const path = `packages/nested/${MINTER_PATH}`;
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(path);
  });

  it("Case D, fires (anchored at the end): a path that merely starts with the minter path fails", () => {
    const path = `${MINTER_PATH}.bak.ts`;
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(path);
  });

  it("Case D2, fires: a sibling of the minter in the same folder fails", () => {
    const path = "packages/service/src/approval/mint/mint-token-extra.ts";
    const result = backstop({ [path]: TOKEN_CAST });
    expect(result.status).toBe(1);
    expect(result.out).toContain(path);
  });

  it("Case E, fires: the any type in the minter file still fails the capability-file scan", () => {
    const result = backstop({ [MINTER_PATH]: ANY_IN_MINTER });
    expect(result.status).toBe(1);
    expect(result.out).toContain(FORGERY_DESCRIPTION);
    expect(result.out).toContain(MINTER_PATH);
  });

  it("Case F, quiet: the cast in a test file path still passes", () => {
    const result = backstop({ "packages/service/src/approval/forge.test.ts": TOKEN_CAST });
    expect(result.out).not.toContain(FORGERY_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("the rule description names the single allowed minter path", () => {
    const result = backstop({ "packages/service/src/forge.ts": TOKEN_CAST });
    expect(result.out).toContain(MINTER_PATH);
  });
});

// Confinement rules (D-03, T-06-01, T-06-02, T-06-15): nothing outside an
// allow-list imports the approval minter or an executor, calls process.kill, or
// calls .terminate. Each rule has cases that fire on a planted violation and
// cases that stay quiet on its allow-listed path, so a rule that silently
// stopped matching fails here (ADR-0019 history). Rules are named by their
// description text, never by number (M-4). Every forbidden literal is assembled
// at runtime so this file is not itself a backstop hit.
const MINTER_IMPORT_DESCRIPTION = "imports the approval minter";
const EXECUTOR_IMPORT_DESCRIPTION = "imports an executor";
const PROCESS_KILL_DESCRIPTION = "calls process.kill";
const TERMINATE_CALL_DESCRIPTION = "calls .terminate";
const PUBLIC_DOOR_DESCRIPTION = "public door";
const ALL_CONFINEMENT_DESCRIPTIONS = [
  MINTER_IMPORT_DESCRIPTION,
  EXECUTOR_IMPORT_DESCRIPTION,
  PROCESS_KILL_DESCRIPTION,
  TERMINATE_CALL_DESCRIPTION,
] as const;

const MINT_FOLDER = `approval${"/"}mint${"/"}`;
const EXECUTORS_FOLDER = `executors${"/"}`;
const importFrom = (specifier: string): string =>
  `import { thing } from "${specifier}";\nexport const used = thing;\n`;
const MINTER_IMPORT = importFrom(`./${MINT_FOLDER}mint-token.js`);
const EXECUTOR_IMPORT = importFrom(`./${EXECUTORS_FOLDER}index.js`);
const PROCESS_KILL = `export function stop(pid: number): void {\n  process${"."}kill(pid, 0);\n}\n`;
const TERMINATE_CALL = `export async function end(s: S, t: T, r: string): Promise<void> {\n  await s${"."}terminate(t, r);\n}\n`;

/** The confinement descriptions present in a run's output. */
function firedDescriptions(out: string): string[] {
  return ALL_CONFINEMENT_DESCRIPTIONS.filter((d) => out.includes(d));
}

describe("check-boundaries.sh minter import confinement (T-06-01, T-06-15)", () => {
  it("fires on a minter import outside the approval folder, and only that rule", () => {
    const path = "packages/service/src/foo.ts";
    const result = backstop({ [path]: MINTER_IMPORT });
    expect(result.status).toBe(1);
    expect(firedDescriptions(result.out)).toEqual([MINTER_IMPORT_DESCRIPTION]);
    expect(result.out).toContain(path);
  });

  it("fires on an export-from, a side-effect import and a dynamic import of the minter", () => {
    const exportFrom = backstop({
      "packages/service/src/a.ts": `export * from "../${MINT_FOLDER}mint-token.js";\n`,
    });
    const sideEffect = backstop({
      "packages/service/src/b.ts": `import "./${MINT_FOLDER}mint-token.js";\n`,
    });
    const dynamic = backstop({
      "packages/service/src/c.ts": `const m = await import("./${MINT_FOLDER}mint-token.js");\nexport { m };\n`,
    });
    for (const result of [exportFrom, sideEffect, dynamic]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(MINTER_IMPORT_DESCRIPTION);
    }
  });

  it("fires on a dynamic import whose specifier is a template literal (review MAJOR-1)", () => {
    const BT = "`";
    const path = "packages/service/src/routes/x.ts";
    const plain = backstop({
      [path]: `const m = await import(${BT}../${MINT_FOLDER}mint-token.js${BT});\nexport { m };\n`,
    });
    const interpolated = backstop({
      "packages/service/src/routes/y.ts": `const m = await import(${BT}../${MINT_FOLDER}${"$"}{"mint-token"}.js${BT});\nexport { m };\n`,
    });
    for (const result of [plain, interpolated]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(MINTER_IMPORT_DESCRIPTION);
    }
    expect(plain.out).toContain(path);
  });

  it("fires on a template-literal executor import (review MAJOR-1)", () => {
    const BT = "`";
    const result = backstop({
      "packages/service/src/routes/z.ts": `const m = await import(${BT}../${EXECUTORS_FOLDER}index.js${BT});\nexport { m };\n`,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain(EXECUTOR_IMPORT_DESCRIPTION);
  });

  it("fires when the public door (approval/index.ts) references the minter (review MAJOR-2)", () => {
    const path = "packages/service/src/approval/index.ts";
    const result = backstop({ [path]: `export * from "./mint${"/"}mint-token.js";\n` });
    expect(result.status).toBe(1);
    expect(result.out).toContain(PUBLIC_DOOR_DESCRIPTION);
    expect(result.out).toContain(path);
  });

  it("is quiet for the public door when it only re-exports engine files", () => {
    const result = backstop({
      "packages/service/src/approval/index.ts": `export * from "./engine.js";\n`,
    });
    expect(result.out).not.toContain(PUBLIC_DOOR_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("fires on a multi-line import whose specifier is on the closing line", () => {
    const result = backstop({
      "packages/service/src/multi.ts": `import {\n  one,\n  two,\n} from "./${MINT_FOLDER}mint-token.js";\nexport { one, two };\n`,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain(MINTER_IMPORT_DESCRIPTION);
  });

  it("fires from a plugin file and from an executors file (only the approval folder is allowed)", () => {
    const plugin = backstop({ "packages/plugin/src/p.ts": MINTER_IMPORT });
    const executor = backstop({ "packages/service/src/executors/e.ts": MINTER_IMPORT });
    for (const result of [plugin, executor]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(MINTER_IMPORT_DESCRIPTION);
    }
  });

  it("is quiet for the same import inside packages/service/src/approval/", () => {
    const result = backstop({ "packages/service/src/approval/engine.ts": MINTER_IMPORT });
    expect(result.out).not.toContain(MINTER_IMPORT_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("stays anchored: a look-alike or nested approval folder is not the allowed one", () => {
    for (const path of [
      "packages/service/src/approval-extra/engine.ts",
      "packages/service/src/not-approval/engine.ts",
      "packages/other/packages/service/src/approval/engine.ts",
    ]) {
      const result = backstop({ [path]: MINTER_IMPORT });
      expect(result.status).toBe(1);
      expect(result.out).toContain(MINTER_IMPORT_DESCRIPTION);
      expect(result.out).toContain(path);
    }
  });

  it("is quiet for the import text in a comment and in a test file", () => {
    const comment = backstop({
      "packages/service/src/doc.ts": `// import { thing } from "./${MINT_FOLDER}mint-token.js";\n/*\n * from "./${MINT_FOLDER}mint-token.js"\n */\nexport const x = 1;\n`,
    });
    const test = backstop({ "packages/service/src/foo.test.ts": MINTER_IMPORT });
    for (const result of [comment, test]) {
      expect(result.out).not.toContain(MINTER_IMPORT_DESCRIPTION);
      expect(result.status).toBe(0);
    }
  });

  it("is quiet for an unrelated approval import and for the specifier text outside an import", () => {
    const result = backstop({
      "packages/service/src/ok.ts": `${importFrom("./approval/index.js")}export const note = "see ${MINT_FOLDER}";\n`,
    });
    expect(result.out).not.toContain(MINTER_IMPORT_DESCRIPTION);
    expect(result.status).toBe(0);
  });
});

describe("check-boundaries.sh executor import confinement (T-06-02, T-06-15)", () => {
  it("fires on an executor import from a route file, and only that rule", () => {
    const path = "packages/service/src/routes.ts";
    const result = backstop({ [path]: EXECUTOR_IMPORT });
    expect(result.status).toBe(1);
    expect(firedDescriptions(result.out)).toEqual([EXECUTOR_IMPORT_DESCRIPTION]);
    expect(result.out).toContain(path);
  });

  it("fires on an export-from, a side-effect import and a dynamic import of an executor", () => {
    const exportFrom = backstop({
      "packages/service/src/a.ts": `export { thing } from "../${EXECUTORS_FOLDER}index.js";\n`,
    });
    const sideEffect = backstop({
      "packages/service/src/b.ts": `import "./${EXECUTORS_FOLDER}index.js";\n`,
    });
    const dynamic = backstop({
      "packages/service/src/c.ts": `const m = await import("./${EXECUTORS_FOLDER}index.js");\nexport { m };\n`,
    });
    for (const result of [exportFrom, sideEffect, dynamic]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(EXECUTOR_IMPORT_DESCRIPTION);
    }
  });

  it("fires from the approval folder and from a plugin file (only the root and the folder itself are allowed)", () => {
    const approval = backstop({ "packages/service/src/approval/engine.ts": EXECUTOR_IMPORT });
    const plugin = backstop({ "packages/plugin/src/p.ts": EXECUTOR_IMPORT });
    for (const result of [approval, plugin]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(EXECUTOR_IMPORT_DESCRIPTION);
    }
  });

  it("is quiet in the composition root file", () => {
    const result = backstop({ "packages/service/src/main.ts": EXECUTOR_IMPORT });
    expect(result.out).not.toContain(EXECUTOR_IMPORT_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("is quiet inside the executors folder itself", () => {
    const result = backstop({
      "packages/service/src/executors/x.ts": importFrom(`../${EXECUTORS_FOLDER}y.js`),
    });
    expect(result.out).not.toContain(EXECUTOR_IMPORT_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("stays anchored: other main.ts files and look-alike folders are not allowed", () => {
    for (const path of [
      "packages/service/src/claude/main.ts",
      "packages/service/src/main.ts.bak.ts",
      "packages/service/src/executors-extra/x.ts",
      "packages/other/packages/service/src/executors/x.ts",
      "packages/other/packages/service/src/main.ts",
    ]) {
      const result = backstop({ [path]: EXECUTOR_IMPORT });
      expect(result.status).toBe(1);
      expect(result.out).toContain(EXECUTOR_IMPORT_DESCRIPTION);
      expect(result.out).toContain(path);
    }
  });

  it("is quiet for the import text in a comment and in a test file", () => {
    const comment = backstop({
      "packages/service/src/doc.ts": `// import { thing } from "./${EXECUTORS_FOLDER}index.js";\nexport const x = 1;\n`,
    });
    const test = backstop({ "packages/service/src/routes.test.ts": EXECUTOR_IMPORT });
    for (const result of [comment, test]) {
      expect(result.out).not.toContain(EXECUTOR_IMPORT_DESCRIPTION);
      expect(result.status).toBe(0);
    }
  });

  it("is quiet for a look-alike specifier that only contains the folder name", () => {
    const result = backstop({
      "packages/service/src/ok.ts": importFrom("./not-executors/index.js"),
    });
    expect(result.out).not.toContain(EXECUTOR_IMPORT_DESCRIPTION);
    expect(result.status).toBe(0);
  });
});

describe("check-boundaries.sh process.kill confinement (T-06-02)", () => {
  it("fires on a call in a service file, and only that rule", () => {
    const path = "packages/service/src/foo.ts";
    const result = backstop({ [path]: PROCESS_KILL });
    expect(result.status).toBe(1);
    expect(firedDescriptions(result.out)).toEqual([PROCESS_KILL_DESCRIPTION]);
    expect(result.out).toContain(path);
  });

  it("fires in other packages, through globalThis and with a space before the paren", () => {
    const collectors = backstop({ "packages/collectors/src/x.ts": PROCESS_KILL });
    const viaGlobal = backstop({
      "packages/service/src/g.ts": `globalThis${"."}process${"."}kill(1, 0);\n`,
    });
    const spaced = backstop({ "packages/service/src/s.ts": `process${"."}kill (1, 0);\n` });
    for (const result of [collectors, viaGlobal, spaced]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(PROCESS_KILL_DESCRIPTION);
    }
  });

  it("is quiet in the Claude services folder", () => {
    const result = backstop({ "packages/service/src/claude/services.ts": PROCESS_KILL });
    expect(result.out).not.toContain(PROCESS_KILL_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("stays anchored: a look-alike or nested claude folder is not the allowed one", () => {
    for (const path of [
      "packages/service/src/claude-extra/services.ts",
      "packages/service/src/other/claude/services.ts",
      "packages/other/packages/service/src/claude/services.ts",
    ]) {
      const result = backstop({ [path]: PROCESS_KILL });
      expect(result.status).toBe(1);
      expect(result.out).toContain(PROCESS_KILL_DESCRIPTION);
      expect(result.out).toContain(path);
    }
  });

  it("is quiet for the call in a comment and in a test file", () => {
    const comment = backstop({
      "packages/service/src/doc.ts": `// process${"."}kill(pid, 0) checks existence\nexport const x = 1;\n`,
    });
    const test = backstop({ "packages/service/src/foo.test.ts": PROCESS_KILL });
    for (const result of [comment, test]) {
      expect(result.out).not.toContain(PROCESS_KILL_DESCRIPTION);
      expect(result.status).toBe(0);
    }
  });

  it("is quiet for an injected kill callback and for another object's kill method", () => {
    const result = backstop({
      "packages/service/src/ok.ts": `export const a = (deps: D, pid: number) => deps${"."}kill(pid, 0);\nexport const b = (subprocess: P) => subprocess${"."}kill();\n`,
    });
    expect(result.out).not.toContain(PROCESS_KILL_DESCRIPTION);
    expect(result.status).toBe(0);
  });
});

describe("check-boundaries.sh terminate-call confinement (T-06-02)", () => {
  it("fires on a dotted call in a service file, and only that rule", () => {
    const path = "packages/service/src/foo.ts";
    const result = backstop({ [path]: TERMINATE_CALL });
    expect(result.status).toBe(1);
    expect(firedDescriptions(result.out)).toEqual([TERMINATE_CALL_DESCRIPTION]);
    expect(result.out).toContain(path);
  });

  it("fires on an optional-chained call, from the approval folder and from a plugin file", () => {
    const chained = backstop({
      "packages/service/src/c.ts": `export const f = (s: S) => s?${"."}terminate(t, r);\n`,
    });
    const approval = backstop({ "packages/service/src/approval/engine.ts": TERMINATE_CALL });
    const plugin = backstop({ "packages/plugin/src/p.ts": TERMINATE_CALL });
    for (const result of [chained, approval, plugin]) {
      expect(result.status).toBe(1);
      expect(result.out).toContain(TERMINATE_CALL_DESCRIPTION);
    }
  });

  it("is quiet inside the executors folder", () => {
    const result = backstop({
      "packages/service/src/executors/force-terminate-operation.ts": TERMINATE_CALL,
    });
    expect(result.out).not.toContain(TERMINATE_CALL_DESCRIPTION);
    expect(result.status).toBe(0);
  });

  it("stays anchored: a look-alike or nested executors folder is not the allowed one", () => {
    for (const path of [
      "packages/service/src/executors-extra/x.ts",
      "packages/service/src/other/executors/x.ts",
      "packages/other/packages/service/src/executors/x.ts",
    ]) {
      const result = backstop({ [path]: TERMINATE_CALL });
      expect(result.status).toBe(1);
      expect(result.out).toContain(TERMINATE_CALL_DESCRIPTION);
      expect(result.out).toContain(path);
    }
  });

  it("is quiet for the call in a comment and in a test file", () => {
    const comment = backstop({
      "packages/service/src/doc.ts": `// await s${"."}terminate(t, r) is gated\nexport const x = 1;\n`,
    });
    const test = backstop({ "packages/service/src/foo.test.ts": TERMINATE_CALL });
    for (const result of [comment, test]) {
      expect(result.out).not.toContain(TERMINATE_CALL_DESCRIPTION);
      expect(result.status).toBe(0);
    }
  });

  it("is quiet for a method definition named terminate (no leading dot), as in Phase 5", () => {
    const result = backstop({
      "packages/service/src/claude/terminate-executor.ts": `export class T {\n  async terminate(token: Tok, runId: string): Promise<void> {\n    void token;\n    void runId;\n  }\n}\nexport interface I {\n  terminate(token: Tok, runId: string): Promise<void>;\n}\n`,
    });
    expect(result.out).not.toContain(TERMINATE_CALL_DESCRIPTION);
    expect(result.status).toBe(0);
  });
});

describe("check-boundaries.sh confinement rules and the fixture trees", () => {
  it("never trips on the boundary-violations fixture tree, whatever it plants", () => {
    const result = backstop({
      "packages/test-fixtures/boundary-violations/untrusted/all.ts": `${MINTER_IMPORT}${EXECUTOR_IMPORT}${PROCESS_KILL}${TERMINATE_CALL}`,
    });
    expect(firedDescriptions(result.out)).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("fires all four confinement rules at once when all four are planted in one service file", () => {
    const result = backstop({
      "packages/service/src/everything.ts": `${MINTER_IMPORT}${EXECUTOR_IMPORT}${PROCESS_KILL}${TERMINATE_CALL}`,
    });
    expect(result.status).toBe(1);
    expect(firedDescriptions(result.out)).toEqual([...ALL_CONFINEMENT_DESCRIPTIONS]);
  });
});
