import type { CodexTokenActivity, CodexTokenSummary } from "@ccc/domain/codex-sessions.js";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_COPY } from "./codex-format.js";
import { CodexTokenActivitySection } from "./codex-token-activity.js";
import { usageRange } from "./usage-view.js";

const nowMs = Date.parse("2026-10-09T12:00:00Z");
function activity(
  range: "today" | "last-7-days" | "this-month" = "today",
): Extract<CodexTokenActivity, { kind: "available" }> {
  return {
    kind: "available",
    range,
    bounds: { start: "2026-10-09T00:00:00Z", end: "2026-10-09T12:00:00Z" },
    totals: {
      input: 1200000,
      cachedInput: 900000,
      cacheWrite: 4000,
      output: 30000,
      reasoningOutput: 12000,
      total: 1234567,
    },
    observedAt: "2026-10-09T12:00:00Z",
    source: "codex-session-logs",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
  };
}
function summary(
  today: CodexTokenActivity = activity(),
  firstScanPending = false,
): CodexTokenSummary {
  return {
    ranges: {
      today,
      "last-7-days": { ...activity("last-7-days"), totals: { ...activity().totals, total: 42 } },
      "this-month": activity("this-month"),
    },
    firstScanPending,
    observedAt: "2026-10-09T12:00:00Z",
  };
}
function view(tokens: CodexTokenSummary | null = summary(), analysisOn = true, emit = vi.fn()) {
  return {
    emit,
    ...render(
      <CodexTokenActivitySection
        summary={tokens}
        analysisOn={analysisOn}
        nowMs={nowMs}
        onQuickAction={emit}
      />,
    ),
  };
}
afterEach(cleanup);
describe("Codex token activity", () => {
  it("uses the reported total and all five counters with a separate source", () => {
    const v = view();
    v.getByText(CODEX_COPY.tokenExplanation);
    v.getByText("1.2M tokens");
    v.getByText(
      "Input 1.2M · cached input 900K · cache write 4K · output 30K · reasoning output 12K",
    );
    fireEvent.click(v.getByRole("button", { name: "Source for token activity" }));
    expect(v.getAllByText("Source: Codex session logs")).toHaveLength(6);
    v.getByText(CODEX_COPY.tokenSourceNote);
    const rows = v.container.querySelectorAll(".ccc-source-row");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.querySelector("p")?.textContent).toMatch(/tokens$/);
      expect(row.textContent).not.toMatch(/[/\\]/);
    }
  });
  it("keeps the range local and returns to Today on remount", () => {
    const before = usageRange.value;
    const v = view();
    v.getByRole("group", { name: CODEX_COPY.tokenRangeAriaLabel });
    expect(v.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(v.getByRole("button", { name: "Last 7 days" }));
    v.getByText("42 tokens");
    expect(v.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("false");
    expect(usageRange.value).toBe(before);
    v.unmount();
    expect(view().getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
  });
  it.each(["throw", "reject"])(
    "shows analysis off with no digits and contains %s failure",
    async (kind) => {
      const emit = vi.fn(() => {
        if (kind === "throw") throw new Error("private");
        return Promise.reject(new Error("private"));
      });
      const v = view(null, false, emit);
      v.getByText(CODEX_COPY.analysisHeading);
      v.getByText(CODEX_COPY.analysisBody);
      expect(v.container.textContent).not.toMatch(/\d/);
      fireEvent.click(v.getByRole("button", { name: CODEX_COPY.analysisTokenAriaLabel }));
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ capability: "usage:enable-transcript-analysis" }),
      );
      await waitFor(() => v.getByText(CODEX_COPY.analysisFailure));
      v.getByText(CODEX_COPY.analysisRetry);
    },
  );
  it.each(["0.12.3", "/Users/USERNAME/private", null])(
    "guards format-changed version %s",
    (version) => {
      const v = view(summary({ kind: "unavailable", reason: "format-changed", version }));
      v.getByText(CODEX_COPY.tokenUnavailable);
      v.getByText(
        `The session log format changed in ${version === "0.12.3" ? "Codex 0.12.3" : "Your Codex version"}.`,
      );
    },
  );
  it("renders no coverage without a count and lets the owner select a covered range", () => {
    const v = view(summary({ kind: "unavailable", reason: "no-coverage", version: null }));
    v.getByText(CODEX_COPY.noTokenCoverage);
    expect(v.container.querySelector(".ccc-state-body")?.textContent).not.toMatch(/\d/);
    fireEvent.click(v.getByRole("button", { name: "Last 7 days" }));
    v.getByText("42 tokens");
  });
  it("marks the first scan busy without a spinner and disables Source", () => {
    const v = view(summary(activity(), true));
    v.getByText(CODEX_COPY.tokenFirstScan);
    expect(v.container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(v.container.querySelector(".ccc-spinner")).toBeNull();
    const source = v.getByRole("button", { name: "Source for token activity" });
    expect(source.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(source);
    expect(source.getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps measured zero covered and explains independent partial causes", () => {
    const a = activity();
    const v = view(
      summary({
        ...a,
        totals: {
          input: 0,
          cachedInput: 0,
          cacheWrite: 0,
          output: 0,
          reasoningOutput: 0,
          total: 0,
        },
        partiality: { partial: true, missingSources: ["logs"] },
        coverage: { horizonDate: "2026-10-01", uncoveredDays: 2, analysisOffDays: 1 },
      }),
    );
    v.getByText("0 tokens");
    v.getByText("Partial");
    expect(
      v.getAllByText(/Transcript analysis was off for part of this range./).length,
    ).toBeGreaterThan(0);
    expect(v.getAllByText(/Codex session logs only go back to Oct 1./).length).toBeGreaterThan(0);
    expect(v.queryByText(CODEX_COPY.noTokenCoverage)).toBeNull();
  });
});
