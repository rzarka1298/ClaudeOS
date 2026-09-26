import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LayoutOverride, layoutOverrideSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { ENABLED_FLAGS } from "./feature-flags.js";
import { composeLayout, DEFAULT_LAYOUT } from "./layout.js";
import { WIDGETS } from "./registry.js";

/**
 * composeLayout's placement and skip rules (D-10, D-13, T-03-02; UI-SPEC E3
 * partial row). Every way an entry can fail to place is pinned here, and each
 * test asserts BOTH halves: the id is absent from `entries` (the grid never
 * sees it) and present in `skipped` (diagnostics can name it).
 */

function override(...entries: LayoutOverride["entries"]): LayoutOverride {
  return { schemaVersion: 1, entries };
}

function compose(layout: LayoutOverride, flags: ReadonlySet<string> = ENABLED_FLAGS) {
  return composeLayout(DEFAULT_LAYOUT, layout, WIDGETS, flags);
}

describe("an override is the complete ordered list (D-10)", () => {
  it("renders exactly the override's entries, in the override's order", () => {
    const resolution = compose(override({ widgetId: "quick-actions" }, { widgetId: "today" }));

    expect(resolution.entries.map((e) => e.widgetId)).toEqual(["quick-actions", "today"]);
    expect(resolution.entries.some((e) => e.widgetId === "service-health")).toBe(false);
    expect(resolution.skipped).toEqual([]);
  });

  it("falls back to the definition's preferredSize when an entry names no size", () => {
    const resolution = compose(override({ widgetId: "project-shortcuts" }));
    expect(resolution.entries).toEqual([{ widgetId: "project-shortcuts", size: "medium" }]);
  });

  it("honours an explicit size over the preferred one", () => {
    const resolution = compose(override({ widgetId: "project-shortcuts", size: "tall" }));
    expect(resolution.entries).toEqual([{ widgetId: "project-shortcuts", size: "tall" }]);
  });

  it("uses the in-code default when there is no override", () => {
    const resolution = composeLayout(DEFAULT_LAYOUT, undefined, WIDGETS, ENABLED_FLAGS);
    expect(resolution.entries.map((e) => e.widgetId)).toEqual(
      DEFAULT_LAYOUT.map((e) => e.widgetId),
    );
  });
});

describe("skipped entries never reach the grid (D-13)", () => {
  it("skips an unknown id as unknown-widget and keeps the known entries around it in order", () => {
    const resolution = compose(
      override({ widgetId: "today" }, { widgetId: "not-a-widget" }, { widgetId: "quick-actions" }),
    );

    expect(resolution.entries.map((e) => e.widgetId)).toEqual(["today", "quick-actions"]);
    expect(resolution.entries.some((e) => (e.widgetId as string) === "not-a-widget")).toBe(false);
    expect(resolution.skipped).toEqual([{ widgetId: "not-a-widget", reason: "unknown-widget" }]);
  });

  it("skips an inherited object key rather than resolving it (lookup is own-property only)", () => {
    const resolution = compose(override({ widgetId: "constructor" }, { widgetId: "__proto__" }));

    expect(resolution.entries).toEqual([]);
    expect(resolution.skipped.map((s) => s.reason)).toEqual(["unknown-widget", "unknown-widget"]);
  });

  it("skips a widget whose feature flag is off as feature-off", () => {
    const flags = new Set([...ENABLED_FLAGS].filter((flag) => flag !== "widget.today"));
    const resolution = compose(
      override({ widgetId: "today" }, { widgetId: "quick-actions" }),
      flags,
    );

    expect(resolution.entries.map((e) => e.widgetId)).toEqual(["quick-actions"]);
    expect(resolution.skipped).toEqual([{ widgetId: "today", reason: "feature-off" }]);
  });

  it("places a duplicated id once and skips the second occurrence as duplicate", () => {
    const resolution = compose(
      override({ widgetId: "today", size: "wide" }, { widgetId: "today", size: "small" }),
    );

    expect(resolution.entries).toEqual([{ widgetId: "today", size: "wide" }]);
    expect(resolution.skipped).toEqual([{ widgetId: "today", reason: "duplicate" }]);
  });
});

describe("layoutOverrideSchema — the untrusted-file contract (T-03-02)", () => {
  const entry = { widgetId: "today" };

  it("accepts a minimal valid document", () => {
    expect(layoutOverrideSchema.safeParse({ schemaVersion: 1, entries: [] }).success).toBe(true);
    expect(
      layoutOverrideSchema.safeParse({ schemaVersion: 1, entries: [{ widgetId: "today" }] })
        .success,
    ).toBe(true);
  });

  it.each([
    ["a future schemaVersion", { schemaVersion: 2, entries: [entry] }],
    ["an unknown top-level key", { schemaVersion: 1, entries: [entry], theme: "light" }],
    ["65 entries", { schemaVersion: 1, entries: Array.from({ length: 65 }, () => entry) }],
    ["an empty widgetId", { schemaVersion: 1, entries: [{ widgetId: "" }] }],
    [
      "a size outside SIZE_HINTS",
      { schemaVersion: 1, entries: [{ widgetId: "today", size: "huge" }] },
    ],
  ])("rejects %s", (_name, document) => {
    expect(layoutOverrideSchema.safeParse(document).success).toBe(false);
  });

  it("rejects an unknown key inside an entry rather than ignoring the typo", () => {
    const document = { schemaVersion: 1, entries: [{ widgetId: "today", sise: "wide" }] };
    expect(layoutOverrideSchema.safeParse(document).success).toBe(false);
  });

  it("rejects a widgetId longer than 64 characters", () => {
    const document = { schemaVersion: 1, entries: [{ widgetId: "w".repeat(65) }] };
    expect(layoutOverrideSchema.safeParse(document).success).toBe(false);
  });
});

describe("resolution is lookup-only (T-03-02)", () => {
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));

  /** Blanks comments while keeping line numbers, so the scan reads CODE only. */
  function codeLines(source: string): string[] {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""));
  }

  const code = codeLines(readFileSync(join(SRC_DIR, "layout.ts"), "utf8")).join("\n");

  it("contains no dynamic import, require, eval or Function constructor", () => {
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\b/);
  });

  it("never constructs a component from a string", () => {
    expect(code).not.toMatch(/\bcreateElement\s*\(/);
    expect(code).not.toMatch(/\bh\s*\(/);
    expect(code).not.toMatch(/\bjsx\s*\(/);
  });

  it("resolves ids through isWidgetId", () => {
    expect(code).toMatch(/\bisWidgetId\(widgetId\)/);
  });
});
