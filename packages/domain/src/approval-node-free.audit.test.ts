// Wave-2 audit (plan 06-04, D-40): the new approval domain files must be
// Node-free and reachable through the browser barrel, not just listed there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "./index.browser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_FILES = [
  "classification.ts",
  "approval.ts",
  "approval-view.ts",
  "approval-operations.ts",
  "approval-ports.ts",
  "capability.ts",
  "ids.ts",
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("new approval domain files are Node-free (D-40)", () => {
  for (const file of NEW_FILES) {
    it(`${file} has no node: import, dynamic import or require`, () => {
      const code = stripComments(readFileSync(join(HERE, file), "utf8"));
      expect(code).not.toMatch(/["']node:[a-z/_]+["']/);
      expect(code).not.toMatch(/\brequire\s*\(/);
    });
  }

  it("the browser barrel exposes the runtime members of the new files", () => {
    for (const name of [
      "classifyCapability",
      "CLASSIFICATION",
      "resolveTtlMs",
      "canonicalJson",
      "PROPOSAL_STATES",
      "neutraliseUntrustedText",
      "APPROVAL_STATE_DISPLAY",
    ]) {
      expect(Object.keys(browser), name).toContain(name);
    }
  });
});
