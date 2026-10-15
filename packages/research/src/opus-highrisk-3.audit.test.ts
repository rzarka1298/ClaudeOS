// Wave 2 opus FINAL re-check (third fix round, head fe69fff6). Each test below is a CONFIRMED
// defect found by direct probing or by the parse5 8.0.1 differential (scripting on) against dist
// at that head. They are committed SKIPPED: un-skipping any one of them fails at fe69fff6. The
// product code is not changed by the review. Severity is in each name; reasoning is in
// 07-WAVE-REVIEWS.md (wave 2, "Opus final re-check"). Pure ASCII source by design: the unicode
// escape below is written as a backslash sequence inside a string.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { htmlToText } from "./html-to-text.js";
import { findings } from "./untrusted-ast.test.js";

function shows(html: string, marker = "LEAK"): boolean {
  return htmlToText(html).text.includes(marker);
}

describe("opus final re-check: the untrusted-folder syntax-tree allowlist", () => {
  // BLOCKER (host-global reach). The allowlist accepts any identifier the file DECLARES, and an
  // ambient `declare const` is a declaration. The shell rule bans only `fetch(` with the
  // parenthesis. This file passes both scans, compiles under the folder's `types: []` ES2022
  // project, and at runtime `send` is the real global fetch (verified by compiling and running
  // it on Node 24). Fix: ban ambient declarations (`declare`, `declare global`, module
  // augmentation) in the folder and resolve identifiers with the TypeChecker, so a name must be
  // bound in the file by a non-ambient declaration or be an allowlisted lib global.
  it.skip("BLOCKER: an ambient declaration hands the folder the real fetch", () => {
    const source =
      "declare const fetch: (url: string) => Promise<unknown>;\n" +
      "export function go(url: string): Promise<unknown> {\n" +
      "  const send = fetch;\n" +
      "  return send(url);\n" +
      "}\n";
    expect(findings("probe.ts", source)).not.toEqual([]);
  });

  // MAJOR. The declared-name set is file-wide, not scope-aware: a parameter named like a global
  // anywhere in the file allows the real global everywhere else in it. Spelled with a unicode
  // escape (an identifier, not a string) neither scan sees the plain name: the shell rule has 0
  // hits, the syntax tree decodes the escape, and `reach()` returns the live process.env.
  it.skip("MAJOR: a same-named parameter elsewhere in the file allows the global", () => {
    const g = "glob\\u0061lThis";
    const p = "proc\\u0065ss";
    const source =
      `export function shadow(${g}: number): number {\n  return ${g} + 1;\n}\n` +
      "export function reach(): unknown {\n" +
      `  const host = ${g} as unknown as { ${p}: { env: unknown } };\n` +
      `  return host.${p}.env;\n}\n`;
    expect(findings("probe.ts", source)).not.toEqual([]);
  });
});

describe("opus final re-check: closed details and a re-opened formatting element", () => {
  // MINOR (same class as the earlier closed-details findings: hidden until the reader expands
  // it). A details start tag closes the open paragraph in a browser and pops the formatting
  // element under it; the next text re-opens that element INSIDE the details, so the following
  // summary is a child of the re-opened <b>, not of the details: it is not the details' summary
  // and stays hidden. The parser makes it the first summary and emits it.
  it.skip("MINOR: a summary under a reconstructed formatting element is read as visible", () => {
    expect(shows("<p><b><details>x<summary>LEAK</summary></details>")).toBe(false);
  });
});

describe("opus final re-check: feed namespace prefixes are case-folded", () => {
  // MINOR. XML names and prefixes are case-sensitive; bindingsFor and canonicalName lower-case
  // them, so `xmlns:X` (Atom) overwrites `xmlns:x` (foreign) and a summary a namespace-aware
  // reader places in urn:x:other is read as the entry text. Fail-closed fix: keep prefixes
  // exactly as written (or treat a case-only collision as poisoning the scope).
  it.skip("MINOR: an upper-case prefix declaration rebinds a foreign lower-case prefix", () => {
    const feed =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>t</title>' +
      '<x:summary xmlns:x="urn:x:other" xmlns:X="http://www.w3.org/2005/Atom">LEAK</x:summary>' +
      "</entry></feed>";
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });
});

describe("opus final re-check: width has no upper bound", () => {
  // MINOR (the earlier unbounded-sizes finding, closed for font-size, line-height, border,
  // padding and margin but not for width and height). The text sits 100,000 px to the right.
  it.skip("MINOR: a huge width with right alignment moves the text out of view", () => {
    expect(shows('<p style="width:100000px;text-align:right">LEAK</p>')).toBe(false);
  });
});
