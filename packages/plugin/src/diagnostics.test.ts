import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDiagnostics,
  DIAGNOSTICS_CAPACITY,
  type DiagnosticRecord,
  diagnostics,
  recordDiagnostic,
} from "./diagnostics.js";
import { ENABLED_FLAGS } from "./widgets/feature-flags.js";
import {
  composeLayout,
  DEFAULT_LAYOUT,
  layoutOverride,
  resolvedLayout,
  setLayoutOverride,
} from "./widgets/layout.js";
import { WIDGETS } from "./widgets/registry.js";

function record(n: number): DiagnosticRecord {
  return { source: "test", code: `code-${n}`, message: `Record ${n}.`, at: "2026-09-25T00:00:00Z" };
}

beforeEach(() => {
  clearDiagnostics();
  layoutOverride.value = undefined;
});

afterEach(() => {
  clearDiagnostics();
  layoutOverride.value = undefined;
});

describe("the in-memory diagnostics record (D-13; read by Phase 8's DIAG-01..04)", () => {
  it("appends a record carrying source, code, message and at", () => {
    recordDiagnostic(record(1));
    expect(diagnostics.value).toEqual([record(1)]);
  });

  it(`keeps at most ${DIAGNOSTICS_CAPACITY} records, dropping the oldest`, () => {
    for (let n = 1; n <= 101; n++) recordDiagnostic(record(n));

    expect(diagnostics.value).toHaveLength(100);
    expect(diagnostics.value[0]).toEqual(record(2));
    expect(diagnostics.value[99]).toEqual(record(101));
  });

  it("empties on clearDiagnostics", () => {
    recordDiagnostic(record(1));
    clearDiagnostics();
    expect(diagnostics.value).toEqual([]);
  });
});

describe("setLayoutOverride records every skip (D-13)", () => {
  it("records one layout diagnostic per skipped entry, coded by its reason", () => {
    const next = {
      schemaVersion: 1 as const,
      entries: [{ widgetId: "today" }, { widgetId: "not-a-widget" }, { widgetId: "today" }],
    };

    const resolution = setLayoutOverride(next);

    expect(layoutOverride.value).toEqual(next);
    expect(resolution.entries.map((e) => e.widgetId)).toEqual(["today"]);
    expect(resolvedLayout.value).toEqual(resolution);
    expect(diagnostics.value.map((d) => [d.source, d.code])).toEqual([
      ["layout", "unknown-widget"],
      ["layout", "duplicate"],
    ]);
    expect(diagnostics.value[0]?.message).toBe(
      'Layout entry "not-a-widget" skipped (unknown-widget).',
    );
    expect(Number.isNaN(Date.parse(diagnostics.value[0]?.at ?? ""))).toBe(false);
  });

  it("restores the in-code default on undefined and records nothing for it", () => {
    setLayoutOverride({ schemaVersion: 1, entries: [{ widgetId: "today" }] });

    const resolution = setLayoutOverride(undefined);

    expect(layoutOverride.value).toBeUndefined();
    expect(resolution).toEqual(composeLayout(DEFAULT_LAYOUT, undefined, WIDGETS, ENABLED_FLAGS));
    expect(diagnostics.value).toEqual([]);
  });
});
