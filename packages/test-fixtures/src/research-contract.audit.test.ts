// Wave 1+2 test audit for plans 07-01 and 07-03: the executor's tests restate the UI-SPEC tables
// by hand, so they cannot notice the UI-SPEC changing. This file reads the UI-SPEC tables
// themselves and compares them with the domain constants, checks that the new glyphs are disjoint
// from every glyph map already in the tree, and checks the planning records plan 07-01 owns
// (reconcile sections, per-wave log blocks) and the committed red-evidence records of plans 02-04.
//
// The planning-document tests skip when the .planning folder is absent (the public mirror).
// Pure ASCII source by design.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS_CLASS_DISPLAY,
  APPROVAL_STATE_DISPLAY,
  REPORT_ITEM_KIND_DISPLAY,
  RUN_STATE_DISPLAY,
  SOURCE_FAILURE_DISPLAY,
  TASK_PRIORITY_DISPLAY,
  TASK_STATUS_DISPLAY,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const PHASE_DIR = join(REPO_ROOT, ".planning", "phases", "07-cited-research-report-provenance");
const hasPlanning = existsSync(join(PHASE_DIR, "07-UI-SPEC.md"));
const planningDescribe = hasPlanning ? describe : describe.skip;

function read(name: string): string {
  return readFileSync(join(PHASE_DIR, name), "utf8");
}

function stripTicks(cell: string): string {
  return cell.replace(/^`|`$/g, "").trim();
}

/** The table rows (cells without the outer bars) under the first heading that starts with `heading`. */
function tableRows(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(heading);
  expect(start, `heading ${heading}`).toBeGreaterThan(-1);
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  const block = end === -1 ? rest : rest.slice(0, end);
  return block
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => (cells[1] ?? "").startsWith("`"));
}

planningDescribe("07-03: the domain display maps equal the UI-SPEC tables", () => {
  const spec = hasPlanning ? read("07-UI-SPEC.md") : "";

  it("REPORT_ITEM_KIND_DISPLAY: key, label, code point, rule shape and meaning line", () => {
    const rows = tableRows(spec, "### Item kinds");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const kind = stripTicks(row[0] ?? "") as keyof typeof REPORT_ITEM_KIND_DISPLAY;
      const display = REPORT_ITEM_KIND_DISPLAY[kind];
      expect(display, `kind ${kind}`).toBeDefined();
      expect(display.label).toBe(stripTicks(row[1] ?? ""));
      const codePoint = /U\+([0-9A-F]{4,6})/.exec(row[2] ?? "")?.[1];
      expect(codePoint, `glyph cell of ${kind}`).toBeDefined();
      expect(display.glyph.codePointAt(0)).toBe(Number.parseInt(codePoint ?? "0", 16));
      expect(display.rule).toBe((row[3] ?? "").trim());
      expect(display.meaning).toBe(stripTicks(row[4] ?? ""));
    }
  });

  it("SOURCE_FAILURE_DISPLAY: every code and phrase of the 'Source failure reasons' paragraph", () => {
    const start = spec.indexOf("### Source failure reasons");
    expect(start).toBeGreaterThan(-1);
    const rest = spec.slice(start + "### Source failure reasons".length);
    const paragraph = rest.slice(0, rest.search(/\n#{2,3} /)).replace(/\s+/g, " ");
    const pairs = [...paragraph.matchAll(/`([a-z-]+)`\s+`([^`]+)`/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    );
    expect(pairs).toHaveLength(12);
    expect(Object.fromEntries(pairs)).toEqual({ ...SOURCE_FAILURE_DISPLAY });
  });

  it("ACCESS_CLASS_DISPLAY: label and explanation per class", () => {
    const rows = tableRows(spec, "### Access classification");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const key = stripTicks(row[0] ?? "") as keyof typeof ACCESS_CLASS_DISPLAY;
      expect(ACCESS_CLASS_DISPLAY[key], `class ${key}`).toEqual({
        label: stripTicks(row[1] ?? ""),
        explanation: stripTicks(row[2] ?? ""),
      });
    }
  });
});

describe("07-03: the three report item glyphs are unique across the existing vocabularies", () => {
  // Glyph maps that are not exported by the domain: freshness (footer), the Phase 4
  // facts written inline in components, per the UI-SPEC "Glyph rule", as code points.
  const FRESHNESS_AND_PHASE_4 = [
    0x25cf, 0x25d0, 0x25f7, 0x25cb, 0x2387, 0x2731, 0x25cc, 0x2605, 0x25c8, 0x25b3, 0x25b2,
  ].map((codePoint) => String.fromCodePoint(codePoint));
  const exported = [
    ...Object.values(RUN_STATE_DISPLAY).map((entry) => entry.glyph),
    ...Object.values(APPROVAL_STATE_DISPLAY).map((entry) => entry.glyph),
    ...Object.values(TASK_STATUS_DISPLAY).map((entry) => entry.glyph),
    ...Object.values(TASK_PRIORITY_DISPLAY)
      .map((entry) => entry.glyph)
      .filter((glyph): glyph is string => glyph !== null),
  ];

  it("shares no glyph with any run state, approval, task status, priority, freshness or Phase 4 glyph", () => {
    const taken = new Set([...FRESHNESS_AND_PHASE_4, ...exported]);
    expect(taken.size).toBeGreaterThan(20);
    for (const [kind, display] of Object.entries(REPORT_ITEM_KIND_DISPLAY)) {
      expect(
        taken.has(display.glyph),
        `${kind} ${display.glyph.codePointAt(0)?.toString(16)}`,
      ).toBe(false);
    }
  });
});

planningDescribe(
  "07-01: the reconcile record and the per-wave log exist as the plans cite them",
  () => {
    it("07-RECONCILE.md has the eleven R-sections later plans cite", () => {
      const reconcile = read("07-RECONCILE.md");
      const headings = [...reconcile.matchAll(/^## (R-[A-Z]+)$/gm)].map((m) => m[1]);
      expect(headings).toEqual([
        "R-TREE",
        "R-MIG",
        "R-ADR",
        "R-RULES",
        "R-PINS",
        "R-ELEMENTS",
        "R-EXPORTS",
        "R-SEAMS",
        "R-PRIMITIVES",
        "R-ENV",
        "R-GATES",
      ]);
    });

    it("07-WAVE-REVIEWS.md has one block per wave, 1 to 7, each with the fixed rows", () => {
      const log = read("07-WAVE-REVIEWS.md");
      const blocks = log.split(/^## Wave /m).slice(1);
      expect(blocks).toHaveLength(7);
      blocks.forEach((block, index) => {
        expect(block.startsWith(`${index + 1} `), `wave ${index + 1} heading`).toBe(true);
        for (const row of [
          "**Diff range:**",
          "**Post-merge gates:**",
          "**Code review verdict:**",
          "**Test audit:**",
          "**Codex review findings:**",
          "**Resolution:**",
        ]) {
          expect(block, `wave ${index + 1} ${row}`).toContain(row);
        }
      });
    });

    it("names the plan-to-wave membership the plans' own front matter declares", () => {
      const log = read("07-WAVE-REVIEWS.md");
      const waves = new Map<number, string[]>();
      for (const name of readdirSync(PHASE_DIR).filter((n) => /^07-\d\d-PLAN\.md$/.test(n))) {
        const text = read(name);
        const wave = Number(/^wave: (\d+)$/m.exec(text)?.[1]);
        const plan = name.slice(0, 5);
        waves.set(wave, [...(waves.get(wave) ?? []), plan]);
      }
      expect(waves.size).toBe(7);
      for (const [wave, plans] of waves) {
        const block = log.split(/^## Wave /m)[wave] ?? "";
        const heading = block.split("\n")[0] ?? "";
        for (const plan of plans) expect(heading, `wave ${wave}`).toContain(plan);
      }
    });
  },
);

planningDescribe(
  "07-02 to 07-04: every red-evidence record that the plans' acceptance names",
  () => {
    it("is committed, parses, and records a failing exit code with a named failing test", () => {
      const files = readdirSync(PHASE_DIR).filter((name) =>
        /^07-0[234]-.*red-evidence\.json$/.test(name),
      );
      for (const required of [
        "07-02-task1-red-evidence.json",
        "07-02-task2-red-evidence.json",
        "07-02-task3-red-evidence.json",
        "07-03-task1-red-evidence.json",
        "07-03-task2-red-evidence.json",
        "07-03-task3-red-evidence.json",
        "07-04-task1-red-evidence.json",
        "07-04-task2-red-evidence.json",
        "07-04-task3-red-evidence.json",
      ]) {
        expect(files, required).toContain(required);
      }
      for (const name of files) {
        const record = JSON.parse(read(name)) as {
          exit_code?: unknown;
          failing_test?: unknown;
          command?: unknown;
        };
        expect(typeof record.exit_code === "number" && record.exit_code !== 0, name).toBe(true);
        expect(typeof record.failing_test === "string" && record.failing_test !== "", name).toBe(
          true,
        );
        expect(typeof record.command === "string" && record.command !== "", name).toBe(true);
      }
    });
  },
);
