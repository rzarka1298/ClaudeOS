// A machine check for the one convention this package cannot afford to
// lose track of: gray-matter is NEVER called without an explicit options
// object.
//
// `matter(raw)` with no options resolves a `---js` opening delimiter to an
// `eval`-based engine (and, separately, retains every file it parses in an
// unevictable module-level cache). `matter.stringify(body, ...)` with a
// STRING body re-parses that body through the same default engines. Both
// defects shipped in this package once already — the first as a live RCE on
// the index identity read-back, reachable from an authenticated route —
// precisely because the convention lived only in a docblock.
//
// This test is deliberately a source scan rather than a behavioural
// assertion. A behavioural test only covers the call sites someone thought
// to write one for; the defect was a call site nobody thought about.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** The one module permitted to hold a raw gray-matter call: it is where the
 * hardened options and the refusing engines are defined, and every other
 * module reaches the library through the helpers it exports. */
const PARSER_MODULE = "frontmatter.ts";

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Blanks out comment text while preserving line numbering, so the scan
 * reads CODE only.
 *
 * Without this the guard would fire on the docblocks that explain the
 * convention — the modules most likely to quote the forbidden shape are
 * exactly the ones documenting why it is forbidden.
 */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""));
}

describe("gray-matter call discipline", () => {
  test("no module outside the parser calls matter() as a bare parse", () => {
    const offences: Offence[] = [];

    for (const name of sourceFiles()) {
      if (name === PARSER_MODULE) continue;
      codeLines(readFileSync(join(SRC_DIR, name), "utf8")).forEach((text, index) => {
        // `matter.stringify(` and `matter.cache` are property accesses, not
        // a parse; the negative lookahead keeps this rule aimed at the one
        // shape that reaches an engine with default options.
        if (/\bmatter\s*\((?!\s*\))/.test(text) && !/\bmatter\s*\.\s*\w+\s*\(/.test(text)) {
          offences.push({ file: name, line: index + 1, text: text.trim() });
        }
      });
    }

    expect(offences).toEqual([]);
  });

  test("matter.stringify is never handed a bare string body", () => {
    const offences: Offence[] = [];

    for (const name of sourceFiles()) {
      codeLines(readFileSync(join(SRC_DIR, name), "utf8")).forEach((text, index) => {
        const call = /\bmatter\s*\.\s*stringify\s*\(\s*([^,)]*)/.exec(text);
        if (call === null) return;
        // The safe form passes a file-shaped object, which skips
        // gray-matter's `typeof file === 'string'` re-parse branch.
        if (call[1]?.trimStart().startsWith("{")) return;
        offences.push({ file: name, line: index + 1, text: text.trim() });
      });
    }

    expect(offences).toEqual([]);
  });

  test("the scan actually saw this package's modules", () => {
    // Without this the two assertions above would pass vacuously if the
    // directory layout ever changed underneath them.
    expect(sourceFiles()).toContain(PARSER_MODULE);
    expect(sourceFiles()).toContain("index-generation.ts");
  });
});
