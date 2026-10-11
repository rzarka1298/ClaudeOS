import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexTokenSummary } from "@ccc/domain/codex-sessions.js";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { CodexTokenActivitySection } from "./codex-token-activity.js";

/**
 * Wave 5 test audit (plan 05.1-25 truths 11 and 15): the billing and path scan
 * must cover every Token activity state, and the new section sources must stay
 * free of inline style, colour literals and motion.
 */
const nowMs = Date.parse("2026-10-09T12:00:00Z");
const BILLING =
  /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i;
const avail = {
  kind: "available" as const,
  range: "today" as const,
  bounds: { start: "2026-10-09T00:00:00Z", end: "2026-10-09T12:00:00Z" },
  totals: { input: 20, cachedInput: 10, cacheWrite: 1, output: 4, reasoningOutput: 2, total: 99 },
  observedAt: "2026-10-09T12:00:00Z",
  source: "codex-session-logs" as const,
  freshness: "live" as const,
  partiality: { partial: false as const },
  coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
};
function all(today: CodexTokenSummary["ranges"]["today"], pending = false): CodexTokenSummary {
  return {
    ranges: { today, "last-7-days": today, "this-month": today },
    firstScanPending: pending,
    observedAt: "2026-10-09T12:00:00Z",
  };
}
const STATES: Array<[string, CodexTokenSummary | null, boolean]> = [
  ["available", all(avail), true],
  [
    "partial",
    all({
      ...avail,
      partiality: { partial: true, missingSources: ["logs"] },
      coverage: { horizonDate: "2026-10-01", uncoveredDays: 2, analysisOffDays: 1 },
    }),
    true,
  ],
  ["stale", all({ ...avail, freshness: "cached" }), true],
  ["analysis-off", null, false],
  [
    "analysis-off summary",
    all({ kind: "unavailable", reason: "analysis-off", version: null }),
    false,
  ],
  [
    "format-changed dotted",
    all({ kind: "unavailable", reason: "format-changed", version: "0.12.3" }),
    true,
  ],
  [
    "format-changed hostile",
    all({ kind: "unavailable", reason: "format-changed", version: "/Users/USERNAME/x" }),
    true,
  ],
  ["no-coverage", all({ kind: "unavailable", reason: "no-coverage", version: null }), true],
  [
    "first-scan-pending",
    all({ kind: "unavailable", reason: "first-scan-pending", version: null }, true),
    true,
  ],
  ["first-scan flag", all(avail, true), true],
];
afterEach(cleanup);
const here = dirname(fileURLToPath(import.meta.url));

describe("Codex token activity audit", () => {
  it.each(STATES)(
    "%s renders no billing wording, no path separator and no inline style",
    (_n, summary, on) => {
      const v = render(
        <CodexTokenActivitySection
          summary={summary}
          analysisOn={on}
          nowMs={nowMs}
          onQuickAction={() => undefined}
        />,
      );
      const texts = [
        v.container.textContent ?? "",
        ...Array.from(
          v.container.querySelectorAll("[title], [aria-label]"),
          (el) => `${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
        ),
      ];
      for (const t of texts) {
        expect(t).not.toMatch(BILLING);
        expect(t).not.toMatch(/[/\\]/);
      }
      expect(v.container.querySelectorAll("[style]")).toHaveLength(0);
    },
  );

  it("unavailable and analysis-off states never print a measured zero", () => {
    for (const [name, summary, on] of STATES.filter(([n]) =>
      /analysis-off|no-coverage|format|pending/.test(n),
    )) {
      if (name === "first-scan flag") continue;
      const v = render(
        <CodexTokenActivitySection
          summary={summary}
          analysisOn={on}
          nowMs={nowMs}
          onQuickAction={() => undefined}
        />,
      );
      expect(v.container.textContent, name).not.toMatch(/\b0 tokens\b/);
      cleanup();
    }
  });

  it("the new Codex section sources carry no style prop, colour literal, animation or timer", () => {
    for (const file of [
      "codex-sessions.tsx",
      "codex-current-run.tsx",
      "codex-token-activity.tsx",
      "codex-session-rows.ts",
      "codex-format.ts",
    ]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\b(?:rgba?|hsla?)\(/);
      expect(source, file).not.toMatch(/animation|transition|spinner|setInterval|setTimeout/i);
    }
  });
});
