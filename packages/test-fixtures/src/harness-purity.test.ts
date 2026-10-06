// The visual-regression harness is the only code path from which a committed
// screenshot is ever produced, so what it is ALLOWED TO IMPORT is the privacy
// property (PRIV-04 verification chain, layer 1; threat T-03-03).
//
// A behavioural assertion ("the rendered page contains no personal data")
// cannot prove this: it would pass on today's synthetic data and keep passing
// the day someone wires a real client in, right up until a real payload
// arrived. A source scan over the harness entry point can: if the only data
// the harness can reach is `widget-fixtures.json`, then the only data a
// screenshot can contain is the synthetic fixture — by construction.
//
// The companion guarantee lives in `harness/build.mjs`: it declares NO
// `external`, so a transitive `obsidian` import anywhere under `@ccc/plugin`'s
// public entry fails the bundle loudly instead of being silently deferred to a
// runtime that does not exist on a `file://` page.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HARNESS_DIR = join(REPO_ROOT, "packages", "test-fixtures", "harness");
const MAIN_PATH = join(HARNESS_DIR, "main.tsx");
const BUILD_PATH = join(HARNESS_DIR, "build.mjs");
const INDEX_PATH = join(HARNESS_DIR, "index.html");
/** The Playwright specs: they run in Node with the full filesystem and
 * network available, which is exactly why the prohibition names them too
 * (03-09 review MINOR, closed in plan 03-10). `agent-runs.spec.ts` (05-13
 * Task 3) is a second, independent spec file over the same harness page and
 * carries the identical purity contract. */
const SPEC_PATH = join(REPO_ROOT, "packages", "test-fixtures", "visual", "widgets.spec.ts");
const AGENT_RUNS_SPEC_PATH = join(
  REPO_ROOT,
  "packages",
  "test-fixtures",
  "visual",
  "agent-runs.spec.ts",
);
const SPEC_PATHS = [
  ["widgets.spec.ts", SPEC_PATH],
  ["agent-runs.spec.ts", AGENT_RUNS_SPEC_PATH],
] as const;

/** The exact set of modules the visual spec may import. */
const SPEC_ALLOWED_IMPORTS = ["@ccc/plugin", "@playwright/test"] as const;

/** The file plan 03-02's determinism test (`widget-fixtures.test.ts`) reads. */
const DETERMINISM_FIXTURE_PATH = join(
  REPO_ROOT,
  "packages",
  "test-fixtures",
  "src",
  "widget-fixtures.json",
);

/** The exact set of modules the harness entry may import (order irrelevant).
 * `./approval-fixtures.json` was added deliberately by plan 06-17 for the
 * Approvals cells: a second synthetic-only fixture file next to the harness
 * entry, validated against the domain schemas and scanned for personal data by
 * `approvals-harness.test.ts`. Nothing else was added to the set. */
const ALLOWED_IMPORTS = [
  "../src/widget-fixtures.json",
  "./approval-fixtures.json",
  "@ccc/plugin",
  "preact",
] as const;

/** Tolerated, never required: setting a signal through its own package. */
const TOLERATED_IMPORTS = new Set(["@preact/signals"]);

/** Reads a harness file, or "" when it does not exist yet — so a missing file
 * fails on an ASSERTION about the harness rather than crashing the suite. */
function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Blanks comment text while preserving line numbering, so every scan reads
 * CODE only — the file most likely to name a forbidden module is the one
 * documenting why it is forbidden (same helper as vault-write.test.ts). */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""));
}

/** Every module specifier a source file names: static `from`, bare side-effect
 * `import "x"`, dynamic `import("x")` and `require("x")`. */
function importSpecifiers(source: string): string[] {
  const code = codeLines(source).join("\n");
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(?\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found].sort();
}

describe("visual harness purity (PRIV-04 layer 1, T-03-03)", () => {
  it("imports exactly preact, @ccc/plugin and the two synthetic fixture files", () => {
    const specifiers = importSpecifiers(readIfPresent(MAIN_PATH)).filter(
      (specifier) => !TOLERATED_IMPORTS.has(specifier),
    );

    expect(specifiers).toEqual([...ALLOWED_IMPORTS].sort());
  });

  it("names no network call, no Obsidian API and no companion-service client", () => {
    expect(existsSync(MAIN_PATH)).toBe(true);
    const code = codeLines(readIfPresent(MAIN_PATH));

    expect(code.filter((line) => /\bfetch\s*\(/.test(line))).toEqual([]);
    expect(
      code.filter((line) => /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/.test(line)),
    ).toEqual([]);
    expect(code.filter((line) => line.includes("obsidian"))).toEqual([]);
    expect(code.filter((line) => line.includes("@ccc/service-api-client"))).toEqual([]);
  });

  it("builds with no externals, so a transitive obsidian import fails the bundle", () => {
    expect(existsSync(BUILD_PATH)).toBe(true);
    const code = codeLines(readIfPresent(BUILD_PATH));

    expect(code.filter((line) => /\bexternal\s*:/.test(line))).toEqual([]);
    // iife, not esm: Chromium blocks module scripts on file:// origins.
    expect(code.some((line) => /format\s*:\s*["']iife["']/.test(line))).toBe(true);
  });

  it("reads the same fixture file the determinism test pins", () => {
    const fixtureSpecifier = importSpecifiers(readIfPresent(MAIN_PATH)).find((specifier) =>
      specifier.endsWith("widget-fixtures.json"),
    );

    expect(fixtureSpecifier).toBeDefined();
    expect(resolve(HARNESS_DIR, fixtureSpecifier ?? "")).toBe(DETERMINISM_FIXTURE_PATH);
  });

  it.each(SPEC_PATHS)(
    "%s imports only from {@ccc/plugin, @playwright/test} — no node:*, no client",
    (_name, path) => {
      expect(existsSync(path)).toBe(true);

      const specifiers = importSpecifiers(readIfPresent(path));
      // A subset, not an exact match: `widgets.spec.ts` needs `@ccc/plugin`
      // for its registry-derived matrix, while `agent-runs.spec.ts` (05-13)
      // hardcodes its four fixed cells and needs only `@playwright/test` —
      // both are equally pure, so the contract is "nothing outside the
      // allow-list", never "every allowed module is required".
      expect(
        specifiers.every((specifier) =>
          (SPEC_ALLOWED_IMPORTS as readonly string[]).includes(specifier),
        ),
      ).toBe(true);
      expect(specifiers).toContain("@playwright/test");
    },
  );

  it.each(SPEC_PATHS)(
    "%s reaches no network and navigates only to the file:// harness",
    (_name, path) => {
      const code = codeLines(readIfPresent(path));

      expect(code.filter((line) => /\bfetch\s*\(/.test(line))).toEqual([]);
      expect(
        code.filter((line) => /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/.test(line)),
      ).toEqual([]);
      expect(code.filter((line) => line.includes("obsidian"))).toEqual([]);
      expect(code.filter((line) => line.includes("@ccc/service-api-client"))).toEqual([]);
      // No URL literal with a scheme. Read before `//` comment stripping (which
      // would cut "https://…" at its own slashes); whole-line `//` comments
      // are dropped instead.
      const literals = readIfPresent(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"));
      expect(literals.filter((line) => /["'`][a-z][a-z0-9+.-]*:\/\//i.test(line))).toEqual([]);
      // No Playwright API-request fixture and no request routing.
      expect(
        code.filter((line) => /\brequest\b|\bpage\.route\b|\bcontext\.route\b/.test(line)),
      ).toEqual([]);
      // Every navigation goes through harnessUrl(), which builds a URL on the
      // local harness page and nothing else.
      const gotos = code.filter((line) => /\.goto\s*\(/.test(line));
      expect(gotos.length).toBeGreaterThan(0);
      expect(gotos.filter((line) => !/\.goto\s*\(\s*harnessUrl\s*\(/.test(line))).toEqual([]);
      expect(code.join("\n")).toMatch(
        /const HARNESS_PAGE = new URL\("\.\.\/harness\/index\.html", import\.meta\.url\)/,
      );
    },
  );

  it("loads only local files from its page — no remote reference of any kind (T-03-06)", () => {
    const html = readIfPresent(INDEX_PATH);

    expect(html).toContain('<div id="root">');
    expect(html.match(/(?:src|href)\s*=\s*["'](?:[a-z][a-z0-9+.-]*:|\/\/)[^"']*["']/gi)).toBeNull();
    expect(html.match(/\burl\s*\(/gi)).toBeNull();
  });
});
