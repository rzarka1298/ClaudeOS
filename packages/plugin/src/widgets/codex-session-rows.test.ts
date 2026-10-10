import type { CodexSessionsSnapshot, CodexSessionView } from "@ccc/domain/codex-sessions.js";
import { describe, expect, it } from "vitest";
import { buildCodexSessionRows } from "./codex-session-rows.js";

export const rowNow = Date.parse("2026-10-09T12:00:00Z");
export function session(
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
export function snapshot(sessions: CodexSessionView[], hiddenCount = 0): CodexSessionsSnapshot {
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
export const rowOptions = {
  nowMs: rowNow,
  analysisOn: false,
  hookInstalled: true,
  size: "tall",
} as const;
describe("Codex row derivation", () => {
  it("selects the newest running session and sorts recent states and activity", () => {
    const result = buildCodexSessionRows(
      snapshot([
        session("completed-old", "completed", 2000),
        session("cancelled", "cancelled"),
        session("running-old", "running", 1000),
        session("unknown", "stale"),
        session("running-new", "running"),
        session("completed-new"),
        session("failed", "failed"),
        session("paused", "limit-paused"),
        session("expired", "failed", 7 * 86400000 + 1),
      ]),
      { ...rowOptions, size: "tall" },
    );
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.current?.threadId).toBe("running-new");
    expect(result.recent.map((row) => row.threadId)).toEqual([
      "running-old",
      "paused",
      "unknown",
      "failed",
      "completed-new",
    ]);
    expect(result.overflow).toBe(2);
  });
  it("pre-slices by actual size and includes the snapshot hidden count", () => {
    for (const [size, budget] of [
      ["medium", 3],
      ["tall", 5],
    ] as const) {
      const result = buildCodexSessionRows(
        snapshot(
          Array.from({ length: 7 }, (_, i) => session(`thread-${i}`)),
          2,
        ),
        { ...rowOptions, size },
      );
      if (result.kind !== "available") throw new Error("expected rows");
      expect(result.recent).toHaveLength(budget);
      expect(result.overflow).toBe(7 - budget + 2);
    }
  });
  it("gates titles, truncates the fallback and omits malformed model and effort", () => {
    const input = snapshot([
      {
        ...session("abcd1234-private"),
        title: "Prompt title",
        model: "/private",
        effort: "bad\\effort",
      },
    ]);
    const off = buildCodexSessionRows(input, rowOptions);
    const on = buildCodexSessionRows(input, { ...rowOptions, analysisOn: true });
    if (off.kind !== "available" || on.kind !== "available") throw new Error("expected rows");
    expect(off.recent[0]?.primary).toBe("Alpha · Session abcd1234");
    expect(on.recent[0]?.primary).toBe("Alpha · Prompt title");
    expect(off.recent[0]?.segments.map((s) => s.text)).toEqual([
      "Completed",
      "started 1 hour ago",
      "active just now",
    ]);
  });
  it("uses elapsed for the current run and retains opaque action targets only as data", () => {
    const result = buildCodexSessionRows(
      snapshot([session("abcd1234-private", "running")]),
      rowOptions,
    );
    if (result.kind !== "available") throw new Error("expected rows");
    expect(result.current?.segments.map((s) => s.text)).toContain("elapsed 1 h 0 min");
    expect(result.current?.openTranscript).toEqual({
      id: "codex-open-transcript-abcd1234-private",
      label: "Open transcript",
      capability: "codex:open-transcript",
      target: { threadId: "abcd1234-private" },
    });
    expect(result.recent).toHaveLength(0);
  });
});
