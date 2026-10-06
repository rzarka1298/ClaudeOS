import type { RunId, SessionView } from "@ccc/domain";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { type ActiveSessionsData, activeSessionsWidget } from "./active-sessions.js";
import type { WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";

/**
 * Audit (05-06 UI Considerations truths): the REAL Active Claude sessions
 * definition rendered through WidgetFrame in loading, empty, error, one-row,
 * partial and long-text presentations. The executor's tests cover these
 * through the shared frame/list-body fixtures; this pins them on the hero.
 */

afterEach(cleanup);

const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");
const LIVE: ConnectionState = { kind: "live" };

function runId(n: number): RunId {
  return `0mfk1a2b3c4d5e6f7a8b9c0d${(n % 36).toString(36)}` as RunId;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: runId(1),
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "running",
    activity: "working",
    projectId: "proj-alpha",
    projectName: "alpha",
    name: "Refactor parser",
    model: null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-09-25T11:42:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-09-25T11:59:30.000Z",
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: null,
    worktreeBasename: null,
    hasTranscript: false,
    terminateRequested: false,
    hasConversation: true,
    ...overrides,
  };
}

function ready(sessions: readonly SessionView[], partial = false): WidgetState<ActiveSessionsData> {
  return {
    kind: "ready",
    data: { sessions, nowMs: NOW_MS },
    observedAt: "2026-09-25T11:58:00.000Z",
    freshness: "live",
    partiality: partial
      ? { partial: true, missingSources: ["Claude Code transcripts"] }
      : { partial: false },
    isEmpty: sessions.length === 0,
  };
}

function renderState(state: WidgetState<ActiveSessionsData>) {
  return render(
    <WidgetFrame
      definition={activeSessionsWidget}
      state={state}
      connection={LIVE}
      size="tall"
      now={NOW_MS}
    />,
  ).container;
}

describe("Active Claude sessions hero presentations (audit, 05-06)", () => {
  it("loading: cream skeleton of three lines, aria-busy, visually hidden loading text", () => {
    const c = renderState({ kind: "loading" });
    const card = c.querySelector("section.ccc-card");
    expect(card?.getAttribute("data-surface")).toBe("cream");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(c.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(c.querySelector(".ccc-visually-hidden")?.textContent?.toLowerCase()).toBe(
      "loading active claude sessions",
    );
  });

  it("empty: cream hero shows 0 with the zero caption, no meter, then 'Nothing here yet'", () => {
    const c = renderState(ready([]));
    expect(c.querySelector("section.ccc-card")?.getAttribute("data-surface")).toBe("cream");
    expect(c.querySelector(".ccc-kpi-number")?.textContent).toBe("0");
    expect(c.querySelector(".ccc-hero-caption")?.textContent).toBe(
      "0 waiting for approval · 0 unknown",
    );
    expect(c.querySelector(".ccc-hero-meter")).toBeNull();
    expect(c.textContent).toContain("Nothing here yet");
    expect(activeSessionsWidget.renderEmpty?.(undefined as never)).toBeNull();
  });

  it("error: switches the card to glass with the ▲ glyph", () => {
    const c = renderState({ kind: "error", message: "boom" });
    expect(c.querySelector("section.ccc-card")?.getAttribute("data-surface")).toBe("glass");
    expect(c.querySelector(".ccc-error-glyph")?.textContent).toContain("▲");
  });

  it("one row: numeral 1, one row, plural-invariant caption, a meter", () => {
    const c = renderState(ready([session()]));
    expect(c.querySelector(".ccc-kpi-number")?.textContent).toBe("1");
    expect(c.querySelector(".ccc-hero-caption")?.textContent).toBe(
      "0 waiting for approval · 0 unknown",
    );
    expect(c.querySelectorAll(".ccc-list-primary")).toHaveLength(1);
    expect(c.querySelector(".ccc-hero-meter")).not.toBeNull();
  });

  it("partial: the footer Partial chip appears and an unreported model drops its segment", () => {
    const c = renderState(ready([session({ model: null })], true));
    expect(c.textContent).toContain("Partial");
    const meta = c.querySelector(".ccc-list-meta")?.textContent ?? "";
    expect(meta).toMatch(/^\S Running · \S/u);
    expect(meta.split(" · ")).toHaveLength(3);
    expect(meta).not.toMatch(/model|—\s·|·\s·/iu);
  });

  it("long text: the primary line keeps the full text in the DOM and in title, clamped to two lines", () => {
    const longName = "A very long session name ".repeat(12).trim();
    const c = renderState(ready([session({ name: longName })]));
    const primary = c.querySelector(".ccc-list-primary");
    expect(primary?.textContent).toContain(longName);
    expect(primary?.getAttribute("title")).toContain(longName);
    expect(primary?.classList.contains("ccc-clamp-2")).toBe(true);
  });
});
