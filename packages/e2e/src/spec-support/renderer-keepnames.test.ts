import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Wave 2 review HIGH-1, extended to the spec-support renderer functions. wdio 9 loads
 * TypeScript through tsx (esbuild `keepNames: true`) and sends a function to the renderer as its
 * `toString()`. Any nested named function or const-bound arrow then becomes a `__name(...)` call,
 * and the renderer has no `__name`. For every function the support modules hand to
 * `browser.execute` or `browser.executeObsidian`, this test compiles it the way tsx does, takes
 * the text the renderer would receive, checks it never mentions `__name`, and defines it in a
 * clean `vm` context that has no `__name` either.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPPORT_FILES = [
  "approvals-support.ts",
  "tasks-support.ts",
  "cross-support.ts",
  "synthetic-session.ts",
  "shot-layout.ts",
];

interface EsbuildLike {
  transformSync(
    code: string,
    options: { loader: string; keepNames: boolean; format: string; target: string },
  ): { code: string };
}

function loadEsbuild(): EsbuildLike {
  const here = createRequire(import.meta.url);
  const vitePath = createRequire(here.resolve("vitest/package.json")).resolve("vite");
  return createRequire(vitePath)("esbuild") as EsbuildLike;
}

const CALL = /\.(?:execute|executeObsidian)\(\s*([A-Za-z_]\w*)\s*[,)]/g;

/** The top-level declaration of `name`: from its `function` line to the closing brace at column 0. */
function declarationOf(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  return end < 0 ? null : source.slice(start, end + 2);
}

/** The text wdio would send: the function compiled with keepNames, then `toString()`. */
function rendererText(declaration: string, name: string): string {
  const compiled = loadEsbuild().transformSync(declaration, {
    loader: "ts",
    keepNames: true,
    format: "cjs",
    target: "es2022",
  }).code;
  // The module-level `__name(fn, "fn")` statement exists where the module is loaded (tsx),
  // never inside the text sent to the renderer; give the loading scope the helper only.
  const loader = {
    __name: (fn: unknown) => fn,
    module: { exports: {} },
    exports: {},
    out: undefined as unknown,
  };
  vm.runInNewContext(`${compiled}\nout = ${name};`, loader);
  return String(loader.out);
}

interface Found {
  file: string;
  name: string;
  text: string;
}

function collect(): Found[] {
  const found: Found[] = [];
  for (const file of SUPPORT_FILES) {
    const source = readFileSync(join(HERE, file), "utf8");
    const names = new Set<string>();
    for (const match of source.matchAll(CALL)) names.add(match[1] as string);
    for (const name of names) {
      const declaration = declarationOf(source, name);
      // A name defined elsewhere (renderer-spies) is covered by renderer-spies-serialise.test.ts.
      if (declaration === null) continue;
      found.push({ file, name, text: rendererText(declaration, name) });
    }
  }
  return found;
}

describe("spec-support renderer functions survive wdio's keepNames transform", () => {
  const renderers = collect();

  it("finds the named renderer functions of the approvals and tasks support modules", () => {
    for (const file of ["approvals-support.ts", "tasks-support.ts"]) {
      expect(renderers.filter((entry) => entry.file === file).length, file).toBeGreaterThan(0);
    }
  });

  it("sends no function that mentions the esbuild __name helper", () => {
    const offenders = renderers.filter((entry) => /\b__name\b/.test(entry.text));
    expect(offenders.map((entry) => `${entry.file}:${entry.name}`)).toEqual([]);
  });

  it("defines every renderer function in a clean context that has no __name", () => {
    for (const entry of renderers) {
      const clean = vm.createContext({});
      const defined = vm.runInContext(`(${entry.text})`, clean);
      expect(typeof defined, `${entry.file}:${entry.name}`).toBe("function");
      expect(vm.runInContext("typeof __name", clean)).toBe("undefined");
    }
  });
});

/** The first argument of a call: from just after its `(` to the top-level comma or closing paren. */
function firstArgument(code: string, from: number): string {
  const stack: string[] = [];
  let index = from;
  while (index < code.length) {
    const char = code[index] as string;
    const top = stack.at(-1);
    if (top === "'" || top === '"') {
      if (char === "\\") index += 1;
      else if (char === top) stack.pop();
    } else if (top === "`") {
      if (char === "\\") index += 1;
      else if (char === "`") stack.pop();
      else if (char === "$" && code[index + 1] === "{") {
        stack.push("${");
        index += 1;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      stack.push(char);
    } else if (char === "/" && code[index + 1] === "/") {
      index = code.indexOf("\n", index);
      if (index < 0) break;
    } else if (char === "/" && code[index + 1] === "*") {
      index = code.indexOf("*/", index) + 1;
    } else if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]" || char === "}") {
      if (stack.length === 0) return code.slice(from, index);
      stack.pop();
    } else if (char === "," && stack.length === 0) {
      return code.slice(from, index);
    }
    index += 1;
  }
  return code.slice(from);
}

describe("inline renderer functions in the specs and support modules", () => {
  const files = [
    ...SUPPORT_FILES.map((file) => join(HERE, file)),
    ...[
      "approvals-core",
      "approvals-lifecycle",
      "cross-cutting",
      "notification-look",
      "synthetic-session",
      "tasks-core",
      "tasks-scale",
      "tasks-views",
    ].map((name) => join(HERE, "..", "..", "specs", `${name}.e2e.ts`)),
  ];

  it("compiles none of them to a call of the missing __name helper", () => {
    const offenders: string[] = [];
    let inspected = 0;
    for (const file of files) {
      const code = loadEsbuild().transformSync(readFileSync(file, "utf8"), {
        loader: "ts",
        keepNames: true,
        format: "esm",
        target: "es2022",
      }).code;
      for (const match of code.matchAll(/\.(?:execute|executeObsidian)\(/g)) {
        const argument = firstArgument(code, (match.index as number) + match[0].length).trim();
        // A bare name is a module-level function, covered by the test above.
        if (/^[A-Za-z_]\w*$/.test(argument)) continue;
        inspected += 1;
        if (/\b__name\(/.test(argument)) offenders.push(`${file}: ${argument.slice(0, 50)}`);
      }
    }
    expect(inspected).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("control: the scanner does flag a nested helper in an inline function", () => {
    const sample =
      "await browser.execute((n: number) => { const twice = (x: number) => x * 2; return twice(n); }, 4);";
    const code = loadEsbuild().transformSync(sample, {
      loader: "ts",
      keepNames: true,
      format: "esm",
      target: "es2022",
    }).code;
    const at = code.indexOf(".execute(") + ".execute(".length;
    expect(firstArgument(code, at)).toMatch(/__name\(/);
  });
});
