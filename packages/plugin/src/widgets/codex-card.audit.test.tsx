// Wave 4 test audit (plans 05.1-17 and 05.1-18): truths the authoring tests only
// half prove. Headroom and plan-usage glyph-plus-word pairs, exactly one
// reason line, the paused-run earliest resume, one unavailable line per usage
// reason, the meter and number sibling, the absence of inline styles and
// colour literals, and strict per-type adoption of every pushed Codex payload.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import type { ServiceEvent, SnapshotResponse } from "@ccc/domain/events.js";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain/projects.js";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { codexWidget } from "./codex.js";
import { adoptCodexSnapshot, applyCodexServiceEvent } from "./codex-events.js";
import { CodexHeadroomSection } from "./codex-headroom.js";
import { resetCodexInstalled } from "./codex-install-state.js";
import { CodexPlanUsageSection } from "./codex-plan-usage.js";
import {
  type CodexCardData,
  codexHeadroom,
  codexIntegration,
  codexSessions,
  codexStateFor,
  codexTokens,
  codexUsage,
  lastCodexEventAt,
} from "./codex-signals.js";
import type { WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";

const observedAt = "2026-10-08T12:00:00.000Z";
const nowMs = Date.parse(observedAt);
const resetsAt = new Date(2026, 9, 9, 16, 40).toISOString();

const usage: Extract<CodexUsageSnapshot, { kind: "available" }> = {
  kind: "available",
  windows: [{ windowMinutes: 10080, usedPercent: 41, resetsAt, limitLabel: null }],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt,
  freshness: "live",
};
const WEEKLY = usage.windows[0] ?? {
  windowMinutes: 10080,
  usedPercent: 41,
  resetsAt,
  limitLabel: null,
};
const headroom: HeadroomSignal = {
  generatedAt: observedAt,
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt,
    source: "claude-code-status-line",
    observedAt,
    freshness: "live",
  },
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt },
    source: "app-server",
    observedAt,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
};
const sessions = {
  kind: "available" as const,
  sessions: [],
  hiddenCount: 0,
  analysisOn: false,
  observedAt,
  freshness: "live" as const,
  partiality: { partial: false },
};
const tokens = {
  ranges: {
    today: { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "last-7-days": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "this-month": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
  },
  firstScanPending: false,
  observedAt,
};
const integration = {
  codex: { installed: true, version: null },
  hooks: { state: "not-installed" as const, lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed" as const, lastWindowAt: null },
  doctor: null,
};
const data: CodexCardData = {
  sessions,
  usage,
  headroom,
  tokens,
  integration,
  nowMs,
  analysisOn: false,
};

const REASON_LINES = {
  "reserve-line": "At or over the 80% reserve line.",
  "usage-not-allowed": "Codex says ordinary usage isn't allowed right now.",
  "paused-run": "A paused run is waiting for its reset.",
  "no-live-read": "No live usage read yet.",
  "usage-unavailable": "Usage is unavailable.",
} as const;

afterEach(() => {
  cleanup();
  codexUsage.value = null;
  codexHeadroom.value = null;
  codexSessions.value = null;
  codexTokens.value = null;
  codexIntegration.value = null;
  lastCodexEventAt.value = null;
  resetCodexInstalled();
});

function codexCell(container: Element): HTMLElement {
  const cell = container.querySelectorAll<HTMLElement>(".ccc-headroom-cell")[1];
  if (cell === undefined) throw new Error("expected the Codex headroom cell");
  return cell;
}

function refused(reason: keyof typeof REASON_LINES, pausedRuns = headroom.codex.pausedRuns) {
  return {
    ...data,
    headroom: {
      ...headroom,
      codex: { ...headroom.codex, verdict: "refuse" as const, reason, pausedRuns },
    },
  };
}

describe("headroom strip: glyph and word, one reason, paused runs (CODEX-11, D-23)", () => {
  it("an allow reads a check glyph beside Has headroom, the worst window, and no reason line", () => {
    const { container } = render(<CodexHeadroomSection data={data} />);
    const cell = codexCell(container);
    const verdict = cell.querySelector(".ccc-state-heading");
    expect(verdict?.textContent?.replace(/\s+/g, " ").trim()).toBe("✓ Has headroom");
    expect(verdict?.querySelector("[aria-hidden='true']")?.textContent).toBe("✓");
    expect(cell.textContent).toContain("41% used · Weekly window · 10,080 min");
    for (const line of Object.values(REASON_LINES)) expect(cell.textContent).not.toContain(line);
  });

  it("the Claude cell never carries a verdict word", () => {
    const { container } = render(<CodexHeadroomSection data={data} />);
    const claude = container.querySelector(".ccc-headroom-cell");
    expect(claude?.textContent).not.toMatch(/Has headroom|Held back/);
  });

  it.each(Object.keys(REASON_LINES) as Array<keyof typeof REASON_LINES>)(
    "a refusal for %s reads a no-entry glyph beside Held back and exactly that one reason line",
    (reason) => {
      const { container } = render(<CodexHeadroomSection data={refused(reason)} />);
      const cell = codexCell(container);
      const verdict = cell.querySelector(".ccc-state-heading");
      expect(verdict?.textContent?.replace(/\s+/g, " ").trim()).toBe("⊘ Held back");
      expect(verdict?.querySelector("[aria-hidden='true']")?.textContent).toBe("⊘");
      const present = Object.entries(REASON_LINES).filter(([, line]) =>
        [...cell.querySelectorAll("p")].some((p) => p.textContent === line),
      );
      expect(present.map(([key]) => key)).toEqual([reason]);
    },
  );

  it("a paused run shows the earliest resume as an absolute time, in the singular for one run", () => {
    const earliest = new Date(2026, 9, 9, 18, 5).toISOString();
    const { container } = render(
      <CodexHeadroomSection
        data={refused("paused-run", { count: 1, earliestResetAt: earliest })}
      />,
    );
    const text = codexCell(container).textContent ?? "";
    expect(text).toContain("1 run paused by the usage limit. Earliest resume: Oct 9, 6:05 PM.");
    expect(text).not.toMatch(/\bin \d|ago/);
  });

  it("a paused run line is absent when no run is paused", () => {
    const { container } = render(<CodexHeadroomSection data={data} />);
    expect(codexCell(container).textContent).not.toContain("paused by the usage limit");
  });
});

describe("plan usage: glyphs, one reason line, meter and number (CODEX-08, D-28)", () => {
  it("the under state leads with an aria-hidden check, the over state with an aria-hidden triangle", () => {
    const under = render(<CodexPlanUsageSection usage={usage} nowMs={nowMs} />);
    const underState = under.container.querySelector(".ccc-reserve-legend p[id]");
    expect(underState?.querySelector("[aria-hidden='true']")?.textContent).toBe("✓");
    expect(underState?.textContent).toContain("Under the 80% reserve line");
    cleanup();
    const over = render(
      <CodexPlanUsageSection
        usage={{ ...usage, windows: [{ ...WEEKLY, usedPercent: 83 }] }}
        nowMs={nowMs}
      />,
    );
    const overState = over.container.querySelector(".ccc-reserve-legend p[id]");
    expect(overState?.querySelector("[aria-hidden='true']")?.textContent).toBe("▲");
    expect(overState?.textContent).toContain("At or over the 80% reserve line");
  });

  it("the legend pairs an aria-hidden bar glyph with the words 80% reserve line", () => {
    const { container } = render(<CodexPlanUsageSection usage={usage} nowMs={nowMs} />);
    const legend = [...container.querySelectorAll("p")].find(
      (p) => p.textContent === "│80% reserve line",
    );
    expect(legend).toBeDefined();
    expect(legend?.querySelector("[aria-hidden='true']")?.textContent).toBe("│");
  });

  it("the number beside the meter is a sibling text carrying the meter's own value", () => {
    const { container } = render(<CodexPlanUsageSection usage={usage} nowMs={nowMs} />);
    const meter = container.querySelector("meter");
    const row = meter?.closest(".ccc-usage-row");
    expect(row?.querySelector(".ccc-state-heading")?.textContent).toMatch(/^41% used/);
    expect(meter?.getAttribute("aria-valuetext")).toBe("41% used");
    expect(meter?.getAttribute("aria-hidden")).toBeNull();
    expect(document.getElementById(meter?.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
    expect(document.getElementById(meter?.getAttribute("aria-describedby") ?? "")).not.toBeNull();
  });

  it.each([
    [
      "read-failed",
      "Codex didn't answer the usage read. It tries again about once a minute while this card is open.",
    ],
    ["no-limits", "Your Codex sign-in doesn't report plan limits."],
    ["too-old", "The last usage read is too old to trust."],
  ] as const)(
    "unavailable for %s is the heading plus exactly its one reason line",
    (reason, line) => {
      const { container } = render(
        <CodexPlanUsageSection
          usage={{ kind: "unavailable", reason, version: null, observedAt }}
          nowMs={nowMs}
        />,
      );
      const lines = [...container.querySelectorAll("p")].map((p) => p.textContent);
      expect(lines).toEqual(["Codex usage unavailable", line]);
    },
  );

  it("shape-changed never prints a version, hostile or dotted: the numeric-free floor wins", () => {
    for (const version of ["0.12.3", "<b>1</b> /Users/USERNAME/p"]) {
      const view = render(
        <CodexPlanUsageSection
          usage={{ kind: "unavailable", reason: "shape-changed", version, observedAt }}
          nowMs={nowMs}
        />,
      );
      const text = view.container.textContent ?? "";
      expect(text).toContain("isn't in a format this build recognises.");
      expect(text).not.toMatch(/[0-9%]|\/Users|<b>/);
      cleanup();
    }
  });
});

describe("the card introduces no inline style and no colour literal (UI-SPEC floors 4 to 7 and 10)", () => {
  const states: Array<[string, WidgetState<CodexCardData>, boolean]> = [
    ["loading", { kind: "loading" }, false],
    ["error", { kind: "error", message: "failed" }, false],
    [
      "ready",
      {
        kind: "ready",
        data,
        observedAt,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: false,
      },
      false,
    ],
    [
      "over reserve",
      {
        kind: "ready",
        data: {
          ...data,
          usage: { ...usage, windows: [{ ...WEEKLY, usedPercent: 83 }] },
          headroom: refused("reserve-line").headroom,
        },
        observedAt,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: false,
      },
      false,
    ],
    [
      "empty",
      {
        kind: "ready",
        data: { ...data, usage: null, headroom: null, sessions: null, tokens: null },
        observedAt,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: true,
      },
      false,
    ],
    [
      "setup",
      codexStateFor(
        { kind: "live" },
        { ...data, integration: { ...integration, codex: { installed: false, version: null } } },
        nowMs,
      ),
      false,
    ],
    ["paused", { kind: "unavailable", reason: { code: "codex-data-changed" } }, false],
    [
      "disconnected",
      {
        kind: "ready",
        data,
        observedAt,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: false,
      },
      true,
    ],
  ];

  it.each(states)("%s renders no style attribute anywhere", (_name, state, disconnected) => {
    const { container } = render(
      <WidgetFrame
        definition={codexWidget}
        state={state}
        connection={
          disconnected ? { kind: "disconnected", reason: "Service stopped" } : { kind: "live" }
        }
        now={nowMs}
        onQuickAction={() => undefined}
      />,
    );
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("the Codex widget sources carry no style prop, hex colour or colour function", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [
      "codex.tsx",
      "codex-headroom.tsx",
      "codex-plan-usage.tsx",
      "codex-format.ts",
      "codex-signals.ts",
    ]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\b(?:rgba?|hsla?)\(/);
    }
  });
});

describe("every pushed Codex payload is validated on its own (D-25, Pitfall 17)", () => {
  function ev(type: ServiceEvent["type"], payload: ServiceEvent["payload"]): ServiceEvent {
    return { id: 1, type, payload, occurredAt: observedAt };
  }

  it("an invalid sessions, tokens or integration payload is ignored and the previous value stands", () => {
    expect(applyCodexServiceEvent(ev("codex.sessions.updated", sessions))).toBe(true);
    expect(applyCodexServiceEvent(ev("codex.tokens.updated", tokens))).toBe(true);
    expect(applyCodexServiceEvent(ev("codex.integration.updated", integration))).toBe(true);
    const before = {
      sessions: codexSessions.value,
      tokens: codexTokens.value,
      integration: codexIntegration.value,
    };
    expect(applyCodexServiceEvent(ev("codex.sessions.updated", { ...sessions, kind: "x" }))).toBe(
      false,
    );
    expect(applyCodexServiceEvent(ev("codex.sessions.updated", { ...sessions, extra: 1 }))).toBe(
      false,
    );
    expect(applyCodexServiceEvent(ev("codex.tokens.updated", { firstScanPending: "yes" }))).toBe(
      false,
    );
    expect(applyCodexServiceEvent(ev("codex.tokens.updated", { ...tokens, extra: 1 }))).toBe(false);
    expect(applyCodexServiceEvent(ev("codex.integration.updated", {}))).toBe(false);
    expect(applyCodexServiceEvent(ev("codex.integration.updated", null))).toBe(false);
    expect(codexSessions.value).toBe(before.sessions);
    expect(codexTokens.value).toBe(before.tokens);
    expect(codexIntegration.value).toBe(before.integration);
  });

  it("a snapshot whose codex member is invalid leaves every earlier value in place", () => {
    adoptCodexSnapshot({
      lastEventId: 1,
      state: {
        serviceStartedAt: observedAt,
        projects: EMPTY_PROJECTS_SNAPSHOT,
        codex: { usage, headroom, sessions, tokens, integration },
      },
    });
    const kept = {
      usage: codexUsage.value,
      headroom: codexHeadroom.value,
      sessions: codexSessions.value,
    };
    expect(kept.usage).not.toBeNull();
    const bad = {
      lastEventId: 2,
      state: {
        serviceStartedAt: observedAt,
        projects: EMPTY_PROJECTS_SNAPSHOT,
        codex: { usage: { kind: "available", windows: "nope" } },
      },
    } as unknown as SnapshotResponse;
    adoptCodexSnapshot(bad);
    expect(codexUsage.value).toBe(kept.usage);
    expect(codexHeadroom.value).toBe(kept.headroom);
    expect(codexSessions.value).toBe(kept.sessions);
  });
});
