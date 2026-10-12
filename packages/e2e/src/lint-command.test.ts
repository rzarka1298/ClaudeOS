import { describe, expect, it } from "vitest";
import { lintTagsCommand } from "./lint-command.js";
import { UAT_ITEM_PLAN } from "./spec-map.js";

const SPEC_DIR = "/work/specs";
const SCRIPT_PATH = "/work/06-UAT.md";

function buildScript(mutate: (number: number, lines: string[]) => string[] = (_n, l) => l): string {
  const out = ["---", "status: testing", "phase: 06-demo", "---", "", "## Tests", ""];
  for (const entry of UAT_ITEM_PLAN) {
    const lines = [`### ${entry.number}. Title ${entry.number}`, `run: ${entry.runClass}`];
    if (entry.runClass !== "owner") lines.push(`via: ${entry.via.join(", ")}`);
    if (entry.specFile !== null) {
      lines.push(`spec: ${entry.specFile}::[06-UAT#${String(entry.number).padStart(2, "0")}]`);
    }
    if (entry.ownerWhy !== null) lines.push(`owner-why: ${entry.ownerWhy}`);
    if (entry.autoPart !== null) lines.push(`auto-part: ${entry.autoPart}`);
    lines.push("expected: |", "  Something.", "result: [pending]", "");
    out.push(...mutate(entry.number, lines));
  }
  out.push("## Summary", "", "total: 26", "");
  return out.join("\n");
}

function buildSpecs(skip: number[] = []): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const entry of UAT_ITEM_PLAN) {
    if (entry.specFile === null) continue;
    const name = entry.specFile.split("/").pop() as string;
    sources[name] ??= "";
    if (skip.includes(entry.number)) continue;
    sources[name] += `it("[06-UAT#${String(entry.number).padStart(2, "0")}] title", () => {});\n`;
  }
  return sources;
}

function run(
  script: string,
  specs: Record<string, string>,
  extra: { standardSpecs?: readonly string[] } = {},
) {
  return lintTagsCommand({
    scriptPath: SCRIPT_PATH,
    specsDir: SPEC_DIR,
    readFile: (path) => {
      if (path === SCRIPT_PATH) return script;
      const name = path.slice(SPEC_DIR.length + 1);
      return specs[name] ?? null;
    },
    listFiles: () => Object.keys(specs),
    ...extra,
  });
}

describe("lintTagsCommand (Test 4)", () => {
  it("returns 0 and no finding for a consistent script and spec set", () => {
    const result = run(buildScript(), buildSpecs());
    expect(result.lines.filter((line) => /^[A-Z_]+/.test(line))).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("prints findings by code and item number only, and exits 1", () => {
    const result = run(buildScript(), buildSpecs([5]));
    expect(result.exitCode).toBe(1);
    const text = result.lines.join("\n");
    expect(text).toContain("TAGGED_NO_TEST");
    expect(text).toContain("5");
    expect(text).not.toContain("Something");
    expect(text).not.toContain("Title 5");
  });

  it("fails when a spec file named in the script does not exist", () => {
    const specs = buildSpecs();
    const missing = Object.keys(specs)[0] as string;
    delete specs[missing];
    const result = run(buildScript(), specs);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/SPEC_FILE_MISSING/);
  });

  it("fails when a script item differs from the spec map", () => {
    const script = buildScript((number, lines) =>
      number === 5 ? lines.map((line) => (line === "run: auto" ? "run: auto+look" : line)) : lines,
    );
    const result = run(script, buildSpecs());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("MAP_MISMATCH");
  });

  it("fails when the scale spec appears in the standard profile's spec list", () => {
    const scale = UAT_ITEM_PLAN.find((entry) => entry.profile === "full")?.specFile as string;
    const result = run(buildScript(), buildSpecs(), { standardSpecs: [scale] });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("SCALE_IN_STANDARD");
  });

  it("flags an .only test with ONLY_TEST and its item number", () => {
    const specs = buildSpecs();
    const name = Object.keys(specs)[0] as string;
    specs[name] = (specs[name] as string).replace("it(", "it.only(");
    const result = run(buildScript(), specs);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/ONLY_TEST item \d+/);
  });

  it("reports a spec file with no tagged test as TAGGED_NO_TEST, not SPEC_FILE_MISSING", () => {
    const target = UAT_ITEM_PLAN.find((entry) => entry.specFile !== null)?.specFile as string;
    const skip = UAT_ITEM_PLAN.filter((entry) => entry.specFile === target).map(
      (entry) => entry.number,
    );
    const result = run(buildScript(), buildSpecs(skip));
    const text = result.lines.join("\n");
    expect(text).toContain("TAGGED_NO_TEST");
    expect(text).not.toContain("SPEC_FILE_MISSING item");
    expect(text).not.toMatch(/^SPEC_FILE_MISSING/m);
  });

  it("states how many items have expected tests when everything is consistent", () => {
    const result = run(buildScript(), buildSpecs());
    expect(result.lines.join("\n")).toMatch(/\d+ item\(s\) with expected tests/);
  });

  it("fails when the script cannot be read", () => {
    const result = lintTagsCommand({
      scriptPath: SCRIPT_PATH,
      specsDir: SPEC_DIR,
      readFile: () => null,
      listFiles: () => [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("SCRIPT_UNREADABLE");
  });
});
