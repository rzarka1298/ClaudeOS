// Plan 08-01 audit: the diagnostics domain files must be Node-free (they are
// reachable from the plugin's browser bundle) and reachable through the browser
// barrel, not just listed there. Plan 08-09 extends the file list with the diagnostic bundle and
// its hostile corpus.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "./index.browser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_FILES = [
  "diagnostics.ts",
  "display-path.ts",
  "diagnostic-bundle.ts",
  "diagnostic-corpus.ts",
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** True when the code imports a Node built-in or uses CommonJS `require`. */
function reachesNode(code: string): boolean {
  return (
    /["']node:[a-z/_]+["']/.test(code) ||
    /\brequire\s*\(/.test(code) ||
    /from\s+["'](?:fs|path|os|crypto|child_process|url)["']/.test(code)
  );
}

describe("the diagnostics domain files are Node-free (plan 08-01)", () => {
  for (const file of NEW_FILES) {
    it(`${file} has no node: import, built-in import or require`, () => {
      const code = stripComments(readFileSync(join(HERE, file), "utf8"));
      expect(reachesNode(code)).toBe(false);
    });
  }

  it("the scan is not vacuous: it flags a synthetic offending source", () => {
    expect(reachesNode('import { readFileSync } from "node:fs";')).toBe(true);
    expect(reachesNode('const fs = require("fs");')).toBe(true);
    expect(reachesNode('import path from "path";')).toBe(true);
    expect(reachesNode('import { z } from "zod";')).toBe(false);
  });

  it("the browser barrel exposes the runtime members of the new files", () => {
    for (const name of [
      "DIAGNOSTICS_HEALTH_PATH",
      "DiagnosticsHealthResponseSchema",
      "rollupStatus",
      "summariseRows",
      "SUBSYSTEM_STATUS_DISPLAY",
      "HOOK_SILENT_THRESHOLD_MS",
      "toDisplayPath",
      "DisplayPathSchema",
      "buildDiagnosticBundle",
      "verifyBundle",
      "buildDenylist",
      "DiagnosticBundleSchema",
    ]) {
      expect(Object.keys(browser), name).toContain(name);
    }
  });
});
