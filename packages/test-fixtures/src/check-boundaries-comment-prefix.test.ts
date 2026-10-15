// Wave 1+2 review, MAJOR 4 (plan 07-02): the backstop's comment-line skip treated a line that
// STARTS with a block-comment opener as a comment even when code follows the closing marker, so
// `/* note */ export const g = globalThis.fetch;` passed rule 17 (and rules 11 to 14 and 16, which
// share the helper). Also from the review minors: rule 17 now catches a `.constructor` property
// read without a call and an `import` split from its parenthesis across lines, and it scans the
// test files of the untrusted folder too (a non-test module named `x.test.ts` must not escape).
//
// Choice on the `.test.` exemption: the other rules keep exempting `*.test.*` files (their tests
// legitimately name the forbidden things); rule 17 does not, because nothing under the untrusted
// folder, tests included, needs an I/O name, and the fixtures below prove the real folder is clean.
//
// Forbidden literals are assembled at run time so this file is not itself a backstop hit.
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };
const NOTE = "/* note */ ";

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function backstop(files: Record<string, string>) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, ...files });
  repos.push(repo);
  return repo.run(SCRIPT);
}

const MINT = `approval${"/"}mint${"/"}`;
const EXEC = `executors${"/"}`;

const CASES: ReadonlyArray<
  readonly [rule: string, description: string, path: string, source: string]
> = [
  [
    "11",
    "imports the approval minter",
    "packages/service/src/foo.ts",
    `import { t } from "./${MINT}mint-token.js";\n`,
  ],
  [
    "12",
    "imports an executor",
    "packages/service/src/foo.ts",
    `import { t } from "./${EXEC}index.js";\n`,
  ],
  ["13", "calls process.kill", "packages/service/src/foo.ts", `process${"."}kill(1, 0);\n`],
  ["14", "calls .terminate", "packages/service/src/foo.ts", `await s${"."}terminate(t, r);\n`],
  [
    "16",
    "names a Codex credential or config file",
    "packages/service/src/foo.ts",
    `export const f = ".codex/auth${"."}json";\n`,
  ],
  [
    "17",
    "names an I/O primitive",
    "packages/service/src/untrusted/probe.ts",
    "export const g = globalThis.fetch;\n",
  ],
];

describe("a closed block comment before code on the same line is not a comment line", () => {
  for (const [rule, description, path, source] of CASES) {
    it(`rule ${rule} still fires: ${NOTE}${source.trim()}`, () => {
      const result = backstop({ [path]: `${NOTE}${source}` });
      expect(result.status).toBe(1);
      expect(result.out).toContain(description);
    });

    it(`rule ${rule} still fires after two closed comments`, () => {
      const result = backstop({ [path]: `/* a */ /* b */ ${source}` });
      expect(result.status).toBe(1);
      expect(result.out).toContain(description);
    });

    it(`rule ${rule} still fires on code after the end of a multi-line comment`, () => {
      const result = backstop({ [path]: `/*\n * note\n */ ${source}` });
      expect(result.status).toBe(1);
      expect(result.out).toContain(description);
    });
  }

  it("is quiet for a line that is only comments, and for a name that only the comment holds", () => {
    const result = backstop({
      "packages/service/src/untrusted/probe.ts": [
        "/* globalThis eval( process */",
        "/* a */ /* globalThis */",
        "/* globalThis */ // eval(",
        "/* globalThis */ export const ok = 1;",
        "/**/ export const ok2 = 2;",
        "/*",
        " * process and globalThis in a doc block",
        " */",
        "export const ok3 = 3;",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
  });

  it("does not treat a generator method as a comment line", () => {
    const result = backstop({
      "packages/service/src/untrusted/probe.ts":
        "class A {\n  *items() { return globalThis.x; }\n}\n",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("names an I/O primitive");
  });
});

describe("rule 17 minors", () => {
  const PROBE = "packages/service/src/untrusted/probe.ts";

  it("fires on a .constructor property read without a call", () => {
    const result = backstop({ [PROBE]: "export const c = (() => 1).constructor;\n" });
    expect(result.status).toBe(1);
    expect(result.out).toContain("names an I/O primitive");
  });

  it("stays quiet for names that merely start with constructor and for class constructors", () => {
    const result = backstop({
      [PROBE]: [
        "export const constructorName = 7;",
        "export const o = { constructors: 1 }.constructors;",
        "export class Holder { constructor(readonly id: number) {} }",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
  });

  it("fires on an import split from its parenthesis across lines", () => {
    const result = backstop({ [PROBE]: "export const m = await import\n  (spec);\n" });
    expect(result.status).toBe(1);
    expect(result.out).toContain("names an I/O primitive");
  });

  it("scans a non-test module named like a test file", () => {
    const result = backstop({
      "packages/service/src/untrusted/helper.test.ts": "export const e = process.env.X;\n",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("names an I/O primitive");
  });

  it("still exempts test files outside the untrusted folder for the other rules", () => {
    const result = backstop({
      "packages/service/src/foo.test.ts": `process${"."}kill(1, 0);\n`,
    });
    expect(result.status).toBe(0);
  });
});

describe("rule 17 obfuscation shapes (second wave 1+2 round)", () => {
  const PROBE = "packages/service/src/untrusted/probe.ts";
  const FIRE: ReadonlyArray<readonly [name: string, source: string]> = [
    [
      "a destructured constructor",
      'const { constructor: F } = () => 0;\nexport const g = F("return 1");\n',
    ],
    [
      "a shorthand destructured constructor",
      "const { constructor } = () => 0;\nexport const g = constructor;\n",
    ],
    [
      "a computed key built by concatenation",
      'export const k = (f as object)["con" + "structor"];\n',
    ],
    ["a continuation line that starts with a star", "export const n = 1\n  * 0 || globalThis;\n"],
    [
      "an ambient declaration of fetch",
      "declare const fetch: (u: string) => Promise<unknown>;\nexport const s = fetch;\n",
    ],
    ["the bare word fetch as a value", "export const send = fetch;\n"],
    ["the word declare", "declare const x: number;\nexport const y = x;\n"],
    ["a unicode escape in an identifier", "export const glob\\u0061lThis = 1;\n"],
    ["a braced unicode escape", "export const \\u{61} = 1;\n"],
    ["getOwnPropertyDescriptor", "export const d = Object.getOwnPropertyDescriptor({}, 'a');\n"],
    ["getPrototypeOf", "export const p = Object.getPrototypeOf(() => 0);\n"],
    ["getOwnPropertyNames", "export const n = Object.getOwnPropertyNames({});\n"],
    ["setPrototypeOf", "export const s = Object.setPrototypeOf({}, null);\n"],
    ["defineProperty", "export const d = Object.defineProperty({}, 'a', { value: 1 });\n"],
    ["__proto__", "export const p = ({} as { __proto__: object }).__proto__;\n"],
    [
      "code after a string that contains a block-comment opener",
      'const glob = "src/**/*.ts";\nexport const g = globalThis.fetch;\n',
    ],
    [
      "code after a star-slash that starts a line",
      "/* open\n   no stars here\n*/ export const g = globalThis.fetch;\n",
    ],
  ];
  for (const [name, source] of FIRE) {
    it(`fires on ${name}`, () => {
      const result = backstop({ [PROBE]: source });
      expect(result.status).toBe(1);
      expect(result.out).toContain("names an I/O primitive");
    });
  }

  it("stays quiet for names that merely contain fetch or declare", () => {
    const result = backstop({
      "packages/service/src/untrusted/probe.ts":
        "export const fetcher = 1;\nexport const prefetch = 2;\nexport const declared = 3;\nexport const redeclare = 4;\n",
    });
    expect(result.status).toBe(0);
  });

  it("stays quiet for a real doc block and for class constructors", () => {
    const result = backstop({
      [PROBE]: [
        "/**",
        " * process and globalThis are not available here",
        " * 0 || globalThis",
        " */",
        "export class Holder { constructor(readonly id: number) {} }",
        "export class Other {",
        "  constructor(readonly id: number) {}",
        "}",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
  });
});
