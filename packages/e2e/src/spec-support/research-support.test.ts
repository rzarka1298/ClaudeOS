import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESEARCH_CLASSES } from "./research-copy.js";
import {
  clearResearchNotes,
  DOM_CONFIG,
  isRunEndLine,
  readVaultNotes,
} from "./research-support.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vault(): { root: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "ccc-uat-support-"));
  made.push(root);
  const path = join(root, "vaults", "live");
  for (const folder of ["global/raw", "global/wiki", "global/output", "automation-runs", "tasks"]) {
    mkdirSync(join(path, folder), { recursive: true });
  }
  return { root, vault: path };
}

describe("isRunEndLine", () => {
  it("is true for the ready line, the ready-with-gaps line and a failed line, and for nothing else", () => {
    expect(isRunEndLine("Research report ready: Developer tooling — Oct 16, 2026.")).toBe(true);
    expect(isRunEndLine("Research report ready with gaps: 1 of 3 sources were unavailable.")).toBe(
      true,
    );
    expect(isRunEndLine("Research report ready.")).toBe(true);
    expect(isRunEndLine("Research run failed: no source could be fetched.")).toBe(true);
    expect(isRunEndLine("Research run started.")).toBe(false);
    expect(isRunEndLine("Starting a research run…")).toBe(false);
    expect(isRunEndLine("")).toBe(false);
  });
});

describe("the vault readers", () => {
  it("reads the research folders without the generated index, and nothing from other folders", () => {
    const { root, vault: path } = vault();
    writeFileSync(join(path, "global/raw/a.b.md"), "raw");
    writeFileSync(join(path, "global/raw/index.md"), "index");
    writeFileSync(join(path, "global/output/r.md"), "report");
    writeFileSync(join(path, "automation-runs/run.md"), "run");
    writeFileSync(join(path, "tasks/t.md"), "task");
    const notes = readVaultNotes(path, root);
    expect(notes.raw.map((note) => note.path)).toEqual(["global/raw/a.b.md"]);
    expect(notes.output.map((note) => note.text)).toEqual(["report"]);
    expect(notes.runs.map((note) => note.name)).toEqual(["run.md"]);
    expect(notes.wiki).toEqual([]);
  });

  it("reads an absent folder as empty", () => {
    const { root, vault: path } = vault();
    rmSync(join(path, "global/wiki"), { recursive: true });
    expect(readVaultNotes(path, root).wiki).toEqual([]);
  });

  it("refuses a vault outside the run root", () => {
    const { root } = vault();
    const outside = mkdtempSync(join(tmpdir(), "ccc-uat-outside-"));
    made.push(outside);
    expect(() => readVaultNotes(outside, root)).toThrow(/run root/);
    expect(() => clearResearchNotes(outside, root)).toThrow(/run root/);
  });

  it("clears the research notes and leaves the indexes and every other folder alone", () => {
    const { root, vault: path } = vault();
    writeFileSync(join(path, "global/raw/a.md"), "raw");
    writeFileSync(join(path, "global/raw/index.md"), "index");
    writeFileSync(join(path, "global/output/r.md"), "report");
    writeFileSync(join(path, "automation-runs/run.md"), "run");
    writeFileSync(join(path, "tasks/t.md"), "task");
    clearResearchNotes(path, root);
    expect(existsSync(join(path, "global/raw/a.md"))).toBe(false);
    expect(existsSync(join(path, "global/output/r.md"))).toBe(false);
    expect(existsSync(join(path, "automation-runs/run.md"))).toBe(false);
    expect(existsSync(join(path, "global/raw/index.md"))).toBe(true);
    expect(existsSync(join(path, "tasks/t.md"))).toBe(true);
  });
});

describe("the DOM reader configuration", () => {
  it("holds a class name for every key, each from the mirrored table", () => {
    const known = new Set(Object.values(RESEARCH_CLASSES));
    for (const [key, value] of Object.entries(DOM_CONFIG)) {
      expect(known.has(value), key).toBe(true);
    }
  });
});
