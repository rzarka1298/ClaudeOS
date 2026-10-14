// scripts/check-boundaries.sh rules 8, 9, 10 and 17 (05-16 merge reconcile, plan
// 07-02). Phase 4's shell rule is rule 8; Phase 5's interrupt-signal and
// token-forgery rules are 9 and 10 after the renumber; rule 17 keeps I/O names
// out of the untrusted summariser folder (ADR-0014). Each rule must fire on a
// planted violation, name its own description (so a swapped number or body
// shows up), stay quiet on the allowed neighbour, and the script must count
// every rule: seventeen in all (the Phase 6 confinement rules 11 to 15 and the
// Phase 05.1 Codex rule 16 are exercised in check-boundaries.test.ts and the
// codex gate tests).

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
  it("counts seventeen rules and passes on a clean tree", () => {
    const result = backstop({});
    expect(result.status).toBe(0);
    expect(result.out).toContain("checked 17 rules");
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

// Rule 17 (plan 07-02, ADR-0014, RSRCH-07): the compiler layer leaves the
// ES2022 names (globalThis, eval, Function, Reflect, a computed dynamic import)
// available, so a grep rule over the untrusted folder is the layer that keeps
// them out. Probe sources are assembled from parts so this file is not itself a
// hit of any other rule, and are written only into a temporary gate repo.
const RULE17 = "names an I/O primitive";
const UNTRUSTED_PROBE = "packages/service/src/untrusted/probe.ts";

const RULE17_FIRE_CASES: ReadonlyArray<readonly [name: string, source: string]> = [
  ["a node: specifier", 'import "node:fs";\n'],
  ["a single-quoted node: specifier", "import { x } from 'node:path';\n"],
  ["fetch(", "export const x = fetch(url);\n"],
  ["dynamic import(", "export const y = await import(spec);\n"],
  ["dynamic import with a space before the paren", "export const y = await import (spec);\n"],
  ["require(", 'export const z = require("x");\n'],
  ["process", "export const e = process.env.X;\n"],
  ["child_process", 'import { spawn } from "child_process";\n'],
  ["globalThis", "export const g = globalThis.fetch;\n"],
  ["eval(", 'export const v = eval("1");\n'],
  ["indirect eval", 'export const v = (0, eval)("1");\n'],
  ["new Function(", 'export const f = new Function("return 1");\n'],
  ["indirect Function", 'export const f = (0, Function)("return 1");\n'],
  ["Reflect", 'export const r = Reflect.get(o, "k");\n'],
  ["XMLHttpRequest", "export const a = new XMLHttpRequest();\n"],
  ["WebSocket", "export const b = new WebSocket(u);\n"],
  ["EventSource", "export const c = new EventSource(u);\n"],
  ["a .constructor( call", 'export const k = (() => 1).constructor("return 1")();\n'],
  ["a bracketed constructor access", 'export const k = (() => 1)["constructor"]("return 1");\n'],
];

describe("check-boundaries.sh rule 17 (untrusted folder I/O names)", () => {
  for (const [name, source] of RULE17_FIRE_CASES) {
    it(`fires on ${name} in a non-test file under packages/service/src/untrusted/, and only rule 17`, () => {
      const result = backstop({ [UNTRUSTED_PROBE]: source });
      expect(result.status).toBe(1);
      expect(result.out).toContain(RULE17);
      expect(result.out).toContain("ADR-0014");
      expect(result.out).toContain(UNTRUSTED_PROBE);
      expect(result.out).not.toContain(RULE8);
      expect(result.out).not.toContain(RULE9);
      expect(result.out).not.toContain(RULE10);
    });
  }

  it("fires in a nested subfolder and in a .mjs file of the folder", () => {
    const nested = backstop({
      "packages/service/src/untrusted/deep/inner.ts": "export const e = process.env.X;\n",
    });
    expect(nested.status).toBe(1);
    expect(nested.out).toContain(RULE17);
    const mjs = backstop({
      "packages/service/src/untrusted/probe.mjs": "export const e = process.env.X;\n",
    });
    expect(mjs.status).toBe(1);
    expect(mjs.out).toContain(RULE17);
  });

  it("stays quiet for identifiers that merely contain the letters, and for domain type imports", () => {
    const result = backstop({
      [UNTRUSTED_PROBE]: [
        'import type { NoteId } from "@ccc/domain";',
        "const processed = refetchCount;",
        "const processing = 1;",
        "const fetcher = 1;",
        "const refetched = refetch(x);",
        "const retrieval = 1;",
        "const evaluated = 2;",
        "class Functional {}",
        "const Reflector = 3;",
        "const importer = 4;",
        "const required = 5;",
        "const subprocess = 6;",
        "const nodes: { node: number } = { node: 1 };",
        "export const constructorName = 7;",
        "export class Holder { constructor(readonly id: NoteId | null) {} }",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.out).not.toContain(RULE17);
  });

  it("stays quiet for comment lines naming the primitives", () => {
    const result = backstop({
      [UNTRUSTED_PROBE]: [
        "// process node:fs fetch(x) require(y) globalThis eval(z) child_process",
        "/* Function( Reflect XMLHttpRequest WebSocket EventSource import( */",
        " * process.env and globalThis are not available here",
        "export const ok = 1;",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.out).not.toContain(RULE17);
  });

  it("does not report a file outside the untrusted folder, nor a look-alike sibling folder", () => {
    const result = backstop({
      "packages/service/src/other.ts": "export const e = process.env.X;\n",
      "packages/service/src/untrusted-extra/probe.ts": "export const e = process.env.X;\n",
      "packages/service/src/not-untrusted/probe.ts": "export const e = process.env.X;\n",
    });
    expect(result.status).toBe(0);
    expect(result.out).not.toContain(RULE17);
  });

  it("exempts test files of the folder, as the other rules do", () => {
    const result = backstop({
      "packages/service/src/untrusted/probe.test.ts":
        "export const e = process.env.X;\nawait import(spec);\n",
    });
    expect(result.status).toBe(0);
    expect(result.out).not.toContain(RULE17);
  });
});
