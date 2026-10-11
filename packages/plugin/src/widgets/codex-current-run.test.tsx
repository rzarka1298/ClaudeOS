import type { CodexSessionsSnapshot, CodexSessionView } from "@ccc/domain/codex-sessions.js";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexWidget } from "./codex.js";
import { CodexCurrentRunSection } from "./codex-current-run.js";
import { applyCodexServiceEvent } from "./codex-events.js";
import { buildCodexSessionRows } from "./codex-session-rows.js";
import { codexSessions, lastCodexEventAt } from "./codex-signals.js";

const rowNow = Date.parse("2026-10-09T12:00:00Z");
function session(
  threadId: string,
  state: CodexSessionView["state"] = "completed",
  ago = 0,
): CodexSessionView {
  return {
    threadId,
    state,
    projectId: null,
    projectName: "Alpha",
    origin: "headless",
    model: "gpt-6",
    effort: "high",
    startedAt: new Date(rowNow - 3600000).toISOString(),
    lastActivityAt: new Date(rowNow - ago).toISOString(),
    resumesAfter: null,
    title: null,
    hasTranscript: true,
    liveLogRunId: null,
  };
}
function snapshot(sessions: CodexSessionView[], hiddenCount = 0): CodexSessionsSnapshot {
  return {
    kind: "available",
    sessions,
    hiddenCount,
    analysisOn: false,
    observedAt: new Date(rowNow).toISOString(),
    freshness: "live",
    partiality: { partial: false },
  };
}

afterEach(() => {
  cleanup();
  codexSessions.value = null;
  lastCodexEventAt.value = null;
});
describe("Codex session tracer", () => {
  it("renders current and recent rows through the composer and emits a transcript descriptor", () => {
    const emit = vi.fn();
    expect(
      applyCodexServiceEvent({
        id: 1,
        type: "codex.sessions.updated",
        occurredAt: new Date(rowNow).toISOString(),
        payload: snapshot([
          session("abcd1234-private", "running"),
          session("recent12-private"),
          session("older123-private", "completed", 1000),
        ]),
      }),
    ).toBe(true);
    const Body = codexWidget.renderBody;
    const view = render(
      <Body
        size="tall"
        onQuickAction={emit}
        data={{
          sessions: codexSessions.value,
          usage: null,
          headroom: null,
          tokens: null,
          integration: null,
          analysisOn: false,
          nowMs: rowNow,
        }}
      />,
    );
    view.getByText("Current run");
    view.getByText("Recent sessions");
    const primary = view.getByText("Alpha · Session abcd1234");
    expect(primary.title).toBe("Alpha · Session abcd1234");
    expect(view.container.innerHTML).not.toContain("abcd1234-private");
    fireEvent.click(
      view.getByRole("button", { name: "Open transcript for Alpha · Session recent12" }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "codex:open-transcript",
        target: { threadId: "recent12-private" },
      }),
    );
    expect(view.getAllByText("Alpha · Session abcd1234")).toHaveLength(1);
  });
});

describe("Current run zero and unavailable states", () => {
  it("shows the none line for available rows and omits unavailable snapshots", () => {
    const v = render(
      <CodexCurrentRunSection
        rows={buildCodexSessionRows(snapshot([]), {
          nowMs: rowNow,
          analysisOn: false,
          hookInstalled: null,
          size: "tall",
        })}
        size="tall"
      />,
    );
    v.getByText("No Codex run in progress.");
    cleanup();
    expect(
      render(
        <CodexCurrentRunSection
          rows={{ kind: "unavailable", reason: "no-data", version: null }}
          size="tall"
        />,
      ).container.textContent,
    ).toBe("");
  });
});
