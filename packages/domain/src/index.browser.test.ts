import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as approvalCorpus from "./approval-corpus.js";
import * as browser from "./index.browser.js";
import * as full from "./index.js";
import * as pathContainment from "./path-containment.js";

/**
 * `index.browser.ts` is `index.ts` minus the documented Node-only module(s)
 * (wave-3 review). Without this, a new domain module added to one barrel and
 * forgotten in the other would silently diverge: the plugin's browser-safe
 * imports would miss it, or the browser barrel would grow a Node built-in.
 */

/** The modules `index.browser.ts`'s docblock names as genuinely Node-only. */
const NODE_ONLY_MODULES = ["./path-containment.js"];

/**
 * Test data the full barrel exports and the browser barrel deliberately leaves
 * out: the hostile-text corpus is not product code, so no browser bundle should
 * carry it (plan 06-04, D-40).
 */
const INDEX_ONLY_MODULES = ["./approval-corpus.js"];

const HERE = dirname(fileURLToPath(import.meta.url));

function reExports(file: string): string[] {
  const source = readFileSync(join(HERE, file), "utf8");
  return [...source.matchAll(/^export \* from "([^"]+)";$/gm)].map((m) => m[1] ?? "");
}

describe("the browser barrel (index.browser.ts)", () => {
  it("re-exports exactly index.ts's modules minus the Node-only ones", () => {
    const expected = reExports("index.ts").filter(
      (mod) => !NODE_ONLY_MODULES.includes(mod) && !INDEX_ONLY_MODULES.includes(mod),
    );
    expect(reExports("index.browser.ts")).toEqual(expected);
  });

  it("exposes exactly index.ts's runtime exports minus path-containment's", () => {
    const nodeOnly = new Set([...Object.keys(pathContainment), ...Object.keys(approvalCorpus)]);
    const expected = Object.keys(full)
      .filter((name) => !nodeOnly.has(name))
      .sort();
    expect(Object.keys(browser).sort()).toEqual(expected);
  });

  it("leaves the hostile corpus out of the browser barrel but keeps it in the full one", () => {
    expect(Object.keys(full)).toContain("HOSTILE_CORPUS");
    expect(Object.keys(browser)).not.toContain("HOSTILE_CORPUS");
  });

  it("both barrels declare nothing but re-exports", () => {
    for (const file of ["index.ts", "index.browser.ts"]) {
      const code = readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(code.every((line) => /^export \* from "[^"]+";$/.test(line))).toBe(true);
    }
  });
});
