// The sweep for hostile summariser answers (plan 07-07, D-06, D-15, RSRCH-04, RSRCH-08): every
// answer in HOSTILE_MODEL_ANSWERS goes through the trusted stage, and the result is checked
// against the invariants that must hold whatever the answer says. This file spawns nothing,
// writes nothing and reaches no network.
import { readFileSync } from "node:fs";
import { REPORT_ITEM_QUOTE_MIN_LENGTH, REPORT_ITEMS_MAX, ReportItemSchema } from "@ccc/domain";
import { normaliseForMatch, validateSummariserOutput } from "@ccc/research";
import { describe, expect, it } from "vitest";
import { HOSTILE_MODEL_ANSWERS } from "./hostile-model-answers.js";

const ADDRESS = /(?:[a-z][a-z0-9+.-]*:[/\\]|\bwww\.|\b(?:javascript|data|vbscript|file|obsidian):)/i;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

describe("hostile model answers: shape of the set", () => {
  it("has unique kebab-case names and at least 30 cases", () => {
    const names = HOSTILE_MODEL_ANSWERS.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(30);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("is written with escapes only: its source holds no non-ASCII character at all", () => {
    const source = readFileSync(new URL("./hostile-model-answers.ts", import.meta.url), "utf8");
    const offenders = [...source].filter(
      (c) => (c.codePointAt(0) ?? 0) > 0x7e || (c < " " && c !== "\n"),
    );
    expect(offenders.map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()}`)).toEqual([]);
  });
});

describe("hostile model answers: the trusted stage holds", () => {
  for (const entry of HOSTILE_MODEL_ANSWERS) {
    it(entry.name, () => {
      const result = validateSummariserOutput(entry.answer, { sources: entry.sources });
      if (entry.expect.invalid === true) {
        expect(result).toEqual({ ok: false, code: "summariser-invalid-output" });
        return;
      }
      if (!result.ok) throw new Error(`expected a valid answer, got ${result.code}`);
      expect(result.items.length).toBeLessThanOrEqual(REPORT_ITEMS_MAX);
      expect(result.items.map((i) => i.kind)).toEqual(entry.expect.kinds);
      if (entry.expect.ids !== undefined) {
        expect(result.items.map((i) => [...i.citedSourceIds])).toEqual(entry.expect.ids);
      }
      for (const item of result.items) {
        expect(ReportItemSchema.safeParse(item).success).toBe(true);
        expect(item.kind).not.toBe("recommendation");
        for (const field of [item.text, item.quote ?? ""]) {
          expect(ADDRESS.test(field.normalize("NFKC")), field).toBe(false);
          expect(INVISIBLE.test(field), field).toBe(false);
          expect(/\s{2,}|[\n\t]/.test(field), field).toBe(false);
        }
        for (const id of item.citedSourceIds) {
          expect(Object.hasOwn(entry.sources, id)).toBe(true);
        }
        if (item.quote !== undefined) {
          expect(item.quote.length).toBeGreaterThanOrEqual(REPORT_ITEM_QUOTE_MIN_LENGTH);
          const holders = item.citedSourceIds.filter((id) =>
            normaliseForMatch(entry.sources[id] ?? "").includes(item.quote ?? ""),
          );
          // A fact or claim cites only sources that hold its quote; an inference at least one.
          if (item.kind === "inference") expect(holders.length).toBeGreaterThan(0);
          else expect(holders).toEqual([...item.citedSourceIds]);
        }
        if (item.kind !== "inference") expect(item.quote).toBeDefined();
      }
    });
  }
});
