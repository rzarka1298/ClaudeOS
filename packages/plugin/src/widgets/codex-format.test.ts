import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as shared from "./claude-usage.js";
import * as format from "./codex-format.js";
import { FRESHNESS_GLYPH } from "./footer.js";

afterEach(cleanup);
const now = new Date(2026, 9, 8, 12).getTime();
const reset = new Date(2026, 9, 9, 16, 40).toISOString();
const window = { windowMinutes: 10080, usedPercent: 41, resetsAt: reset, limitLabel: null };

describe("Codex pure copy and formatting", () => {
  it("exports the frozen UI-SPEC copy by role", () => {
    expect(format.CODEX_COPY).toEqual({
      cardTitle: "Codex sessions and usage",
      headroomHeading: "Headroom",
      planUsageHeading: "Plan usage",
      currentRunHeading: "Current run",
      recentSessionsHeading: "Recent sessions",
      tokenActivityHeading: "Token activity",
      headroomFooter: "Read-only. This app never starts Codex work on its own.",
      reserveUnder: "Under the 80% reserve line",
      reserveOver: "At or over the 80% reserve line",
      reserveLegend: "80% reserve line",
      fallbackSource: "From Codex session log · {age} old",
      fallbackNote: "Not a live read.",
      setupHeading: "Codex isn't set up",
      setupBody:
        "Install Codex on this Mac and add it in Settings → Launchers. Codex sessions and weekly usage appear here once it has run.",
      setupButton: "Set up Codex",
      analysisHeading: "Transcript analysis is off",
      analysisButton: "Turn on transcript analysis",
      analysisBody:
        "Codex token activity is counted from Codex's local session logs, only after you turn this on. Only counts are kept — never prompts, replies or file contents.",
      tokenExplanation:
        "Tokens Codex reported in its local session logs. This is separate from your plan usage above.",
      tokenSourceNote: "Latest running total per session, never summed twice.",
      usageUnavailable: "Codex usage unavailable",
      usageReadFailed:
        "Codex didn't answer the usage read. It tries again about once a minute while this card is open.",
      usageShapeChanged: "The usage reply from {version} isn't in a format this build recognises.",
      usageNoLimits: "Your Codex sign-in doesn't report plan limits.",
      usageTooOld: "The last usage read is too old to trust.",
      sessionsUnavailable: "Codex sessions unavailable",
      sessionsShapeChanged:
        "The Codex data format changed in {version}, so sessions are hidden rather than shown wrong.",
      tokenUnavailable: "Token activity unavailable",
      tokenShapeChanged: "The session log format changed in {version}.",
      unknownSessionNote:
        "Unknown means no end event arrived and Codex reports no process to check, so it is shown as unknown rather than guessed.",
      hookNotInstalledNote:
        "Live status for interactive sessions needs the optional Codex hook package. Settings → Codex has the install step.",
      analysisOffNote: "Session titles and previews stay hidden until transcript analysis is on.",
      noCurrentRun: "No Codex run in progress.",
      noSessions: "No Codex sessions yet",
      noRecentSessions: "No Codex sessions in the last 7 days.",
      startSession: "Start one with Claude + Codex from a project, or run Codex in a terminal.",
      noTokenCoverage: "No Codex session logs cover this range.",
      headroomUnavailable: "Headroom unavailable",
      usageNotRead:
        "Codex usage hasn't been read yet. It's read about once a minute while this card is open.",
      claudeCapacityUnavailable: "Account capacity unavailable",
      reserveReason: "At or over the 80% reserve line.",
      usageNotAllowedReason: "Codex says ordinary usage isn't allowed right now.",
      pausedRunReason: "A paused run is waiting for its reset.",
      noLiveReadReason: "No live usage read yet.",
      usageUnavailableReason: "Usage is unavailable.",
      allowVerdict: "Has headroom",
      refuseVerdict: "Held back",
      cardDescription: "Codex runs, weekly usage and headroom beside Claude.",
      usageSource: "Codex app-server",
      tokenSource: "Codex session logs",
      sessionsSource: "Codex session records",
      headroomSource: "Claude and Codex usage reads",
      analysisSessionsAriaLabel: "Turn on transcript analysis for Codex session titles",
      analysisTokenAriaLabel: "Turn on transcript analysis for token activity",
      tokenRangeAriaLabel: "Codex token activity range",
      analysisFailure: "Couldn't turn on transcript analysis.",
      analysisRetry: "Check the service in Settings → Diagnostics, then try again.",
      tokenFirstScan: "Counting tokens from Codex session logs…",
      tokenAnalysisPartial: "Transcript analysis was off for part of this range.",
      tokenCoveragePartial: "Codex session logs only go back to {date}.",
      trackingHeading: "Codex tracking paused",
      trackingBody:
        "The Codex data on this Mac is in a format this build doesn't recognise, so it's hidden rather than shown wrong.",
    });
    expect(Object.isFrozen(format.CODEX_COPY)).toBe(true);
  });
  it.each([
    [10080, "7-day window"],
    [300, "5-hour window"],
    [60, "1-hour window"],
    [1440, "1-day window"],
    [20160, "14-day window"],
    [45, "45 min window"],
    [0, "0 min window"],
    [1500, "25-hour window"],
    [1501, "1,501 min window"],
    [null, "Usage window"],
  ])("labels the %s minute window", (minutes, label) => {
    expect(format.formatCodexWindowLabel(minutes)).toBe(label);
  });
  it("formats an absolute local reset including the year outside this year", () => {
    expect(format.formatResetAt(reset, now)).toBe("Oct 9, 4:40 PM");
    expect(format.formatResetAt(new Date(2025, 9, 9, 16, 40).toISOString(), now)).toBe(
      "Oct 9, 2025, 4:40 PM",
    );
  });
  it("drops current status at the reset boundary and keeps the historical value", () => {
    expect(format.codexWindowLine(window, now)).toEqual({
      text: "41% used · resets Oct 9, 4:40 PM",
      outdated: false,
    });
    expect(format.codexWindowLine(window, Date.parse(reset))).toEqual({
      text: "41% used before the Oct 9, 4:40 PM reset · outdated",
      outdated: true,
    });
    expect(format.codexWindowLine({ ...window, resetsAt: null }, now)).toEqual({
      text: "41% used",
      outdated: false,
    });
  });
  it("tests the reserve against the raw percentage, not the rounded display", () => {
    expect(format.reserveState(79.9)).toBe("under");
    expect(format.reserveState(80)).toBe("over");
    expect(format.reserveState(100)).toBe("over");
  });
  it.each([
    ["reserve-line", "At or over the 80% reserve line."],
    ["usage-not-allowed", "Codex says ordinary usage isn't allowed right now."],
    ["paused-run", "A paused run is waiting for its reset."],
    ["no-live-read", "No live usage read yet."],
    ["usage-unavailable", "Usage is unavailable."],
  ] as const)("explains %s", (reason, line) => {
    expect(format.headroomReasonLine(reason)).toBe(line);
  });
  it("labels both verdicts", () => {
    expect(format.verdictLabel("allow")).toBe("Has headroom");
    expect(format.verdictLabel("refuse")).toBe("Held back");
  });
  it("pluralises paused runs and reports the earliest reset only when supplied", () => {
    expect(format.pausedRunsLine(0, null, now)).toBeNull();
    expect(format.pausedRunsLine(1, reset, now)).toBe(
      "1 run paused by the usage limit. Earliest resume: Oct 9, 4:40 PM.",
    );
    expect(format.pausedRunsLine(2, reset, now)).toBe(
      "2 runs paused by the usage limit. Earliest resume: Oct 9, 4:40 PM.",
    );
    expect(format.pausedRunsLine(2, null, now)).toBe(
      "2 runs paused by the usage limit. Reset time not reported.",
    );
  });
  it("explains all four unavailable usage reasons with guarded versions", () => {
    expect(format.unavailableUsageBody("read-failed")).toBe(
      "Codex didn't answer the usage read. It tries again about once a minute while this card is open.",
    );
    expect(format.unavailableUsageBody("no-limits")).toBe(
      "Your Codex sign-in doesn't report plan limits.",
    );
    expect(format.unavailableUsageBody("too-old")).toBe("The last usage read is too old to trust.");
    expect(format.unavailableUsageBody("shape-changed", "0.12.3")).toBe(
      "The usage reply from Codex 0.12.3 isn't in a format this build recognises.",
    );
    for (const version of [
      null,
      "/Users/USERNAME/private",
      "0.12.3-preview",
      "paid",
      "1.2\\secret",
    ]) {
      expect(format.unavailableUsageBody("shape-changed", version)).toBe(
        "The usage reply from Your Codex version isn't in a format this build recognises.",
      );
    }
  });
  it("pluralises undisplayed sessions", () => {
    expect(format.moreSessionsLine(1)).toBe("1 more session isn't shown.");
    expect(format.moreSessionsLine(3)).toBe("3 more sessions aren't shown.");
  });
  it("formats every counter, including cache writes, without adding the total", () => {
    expect(
      format.formatTokenBreakdown({
        input: 1200,
        cachedInput: 3000,
        cacheWrite: 4,
        output: 5,
        reasoningOutput: 6,
        total: 4215,
      }),
    ).toBe("Input 1.2K · cached input 3K · cache write 4 · output 5 · reasoning output 6");
  });
  it("imports Phase 5 constants and permits an accessible Codex range label", () => {
    expect(shared.FRESHNESS_LABEL).toEqual({
      live: "Live",
      cached: "Cached",
      stale: "Stale",
      unavailable: "Unavailable",
    });
    expect(shared.WINDOW_LABEL).toEqual({
      "five-hour": "5-hour window",
      "seven-day": "7-day window",
    });
    expect(shared.ENABLE_ANALYSIS_DESCRIPTOR?.capability).toBe("usage:enable-transcript-analysis");
    expect(FRESHNESS_GLYPH).toEqual({ live: "●", cached: "◐", stale: "◷", unavailable: "○" });
    const onChange = vi.fn();
    render(
      h(shared.RangeSelector, {
        value: "today",
        onChange,
        ariaLabel: "Codex token activity range",
      }),
    );
    const group = screen.getByRole("group", { name: "Codex token activity range" });
    expect(group.querySelectorAll("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalledWith("last-7-days");
  });
  it("renders no billing wording or path separator in any exported copy or formatter result", () => {
    const strings = [
      ...Object.values(format.CODEX_COPY),
      ...[null, 300, 1440, 10080].map(format.formatCodexWindowLabel),
      format.formatResetAt(reset, now),
      format.codexWindowLine(window, now).text,
      format.codexWindowLine(window, Date.parse(reset)).text,
      ...[0, 79.9, 80, 100].map(format.reserveState),
      ...(
        [
          "reserve-line",
          "usage-not-allowed",
          "paused-run",
          "no-live-read",
          "usage-unavailable",
        ] as const
      ).map(format.headroomReasonLine),
      format.verdictLabel("allow"),
      format.verdictLabel("refuse"),
      ...[1, 2, 10].flatMap((n) => [
        format.pausedRunsLine(n, reset, now),
        format.pausedRunsLine(n, null, now),
        format.moreSessionsLine(n),
      ]),
      ...(["read-failed", "shape-changed", "no-limits", "too-old"] as const).flatMap((reason) =>
        [null, "0.12.3", "/Users/USERNAME/private", "price", "0.1-pay"].map((version) =>
          format.unavailableUsageBody(reason, version),
        ),
      ),
      format.formatTokenBreakdown({
        input: 1,
        cachedInput: 2,
        cacheWrite: 3,
        output: 4,
        reasoningOutput: 5,
        total: 15,
      }),
    ];
    for (const line of strings) {
      expect(line).not.toMatch(
        /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
      );
      expect(line).not.toMatch(/[/\\]/);
    }
  });
});

describe("Plan 25 additive vocabulary", () => {
  it("locks action and missing-transcript copy", () => {
    expect(format.CODEX_ROW_COPY.openTranscript).toBe("Open transcript");
    expect(format.CODEX_ROW_COPY.followLog).toBe("Follow live log");
    expect(format.CODEX_ROW_COPY.transcriptMissing).toBe("Transcript not found");
    expect(format.CODEX_ROW_COPY.resetUnreported).toBe("reset time not reported");
    expect(Object.isFrozen(format.CODEX_ROW_COPY)).toBe(true);
    for (const line of [
      ...Object.values(format.CODEX_ROW_COPY),
      ...Object.values(format.CODEX_COUNTER_LABELS),
    ]) {
      expect(line).not.toMatch(
        /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
      );
      expect(line).not.toMatch(/[/\\]/);
    }
  });
});

describe("the rollout fallback label and age (plan 05.1-33, OQ-3)", () => {
  const observed = "2026-10-08T11:00:00.000Z";
  const at = (ms: number) => Date.parse(observed) + ms;
  const SEC = 1000;
  const MIN = 60 * SEC;

  it.each([
    [0, "under 1 min"],
    [59 * SEC, "under 1 min"],
    [60 * SEC, "1 min"],
    [12 * MIN, "12 min"],
    [59 * MIN + 59 * SEC, "59 min"],
    [90 * MIN, "1 hr"],
    [26 * 60 * MIN, "1 d"],
    [-30 * SEC, "under 1 min"],
  ])("formats %i ms as %s", (elapsed, expected) => {
    expect(format.formatCodexAge(observed, at(elapsed))).toBe(expected);
  });

  it("builds the source line from the shared age formatter", () => {
    expect(format.fallbackSourceLine(observed, at(12 * MIN))).toBe(
      "From Codex session log · 12 min old",
    );
    expect(format.fallbackSourceLine(observed, at(0))).toBe(
      "From Codex session log · under 1 min old",
    );
  });

  it("treats a rollout figure as too old only past the stale max age, never an app-server read", () => {
    const base = {
      kind: "available" as const,
      windows: [{ windowMinutes: 10080, usedPercent: 41, resetsAt: null, limitLabel: null }],
      ordinaryUsageAllowed: null,
      rateLimitReached: false,
      rateLimitReachedType: null,
      source: "rollout-fallback" as const,
      observedAt: observed,
      freshness: "stale" as const,
    };
    expect(format.isFallbackTooOld(base, at(10 * MIN))).toBe(false);
    expect(format.isFallbackTooOld(base, at(10 * MIN + SEC))).toBe(true);
    expect(format.isFallbackTooOld({ ...base, source: "app-server" }, at(60 * MIN))).toBe(false);
    expect(
      format.isFallbackTooOld(
        { kind: "unavailable", reason: "read-failed", version: null, observedAt: observed },
        at(60 * MIN),
      ),
    ).toBe(false);
  });
});
