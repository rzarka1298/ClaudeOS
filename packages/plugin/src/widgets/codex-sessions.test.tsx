import type { CodexSessionsSnapshot, CodexSessionView } from "@ccc/domain/codex-sessions.js";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexActionStatus } from "../view/codex-action-status.js";
import { CODEX_COPY } from "./codex-format.js";
import { buildCodexSessionRows } from "./codex-session-rows.js";
import { CodexSessionsSection } from "./codex-sessions.js";

const now = Date.parse("2026-10-09T12:00:00Z");
function row(threadId: string, state: CodexSessionView["state"] = "completed"): CodexSessionView {
  return {
    threadId,
    state,
    projectId: null,
    projectName: "Alpha",
    origin: "headless",
    model: null,
    effort: null,
    startedAt: new Date(now - 3600000).toISOString(),
    lastActivityAt: new Date(now - 19 * 60000).toISOString(),
    resumesAfter: null,
    title: null,
    hasTranscript: true,
    liveLogRunId: null,
  };
}
function view(
  sessions: CodexSessionView[] = [row("abcd1234-private")],
  analysisOn = false,
  hookInstalled: boolean | null = false,
  emit = vi.fn(),
) {
  const snapshot: CodexSessionsSnapshot = {
    kind: "available",
    sessions,
    hiddenCount: 0,
    analysisOn,
    observedAt: new Date(now).toISOString(),
    freshness: "live",
    partiality: { partial: false },
  };
  return {
    emit,
    ...render(
      <CodexSessionsSection
        rows={buildCodexSessionRows(snapshot, {
          nowMs: now,
          analysisOn,
          hookInstalled,
          size: "tall",
        })}
        size="tall"
        onQuickAction={emit}
      />,
    ),
  };
}
afterEach(() => {
  cleanup();
  codexActionStatus.value = null;
});
describe("Codex sessions states and actions", () => {
  it("reports unknown duration bounded by last evidence and shows only visible Unknown notes", () => {
    const v = view([row("unknown1", "stale")]);
    v.getByText(/At least 41 min/);
    v.getByText(/Unknown — ended without reporting/);
    v.getByText(CODEX_COPY.unknownSessionNote);
    expect(v.queryByText(/Completed/)).toBeNull();
    cleanup();
    expect(view().queryByText(CODEX_COPY.unknownSessionNote)).toBeNull();
  });
  it("reports paused reset time, guarding the absent reset", () => {
    const v = view([
      {
        ...row("paused12", "limit-paused"),
        resumesAfter: new Date(2026, 9, 9, 16, 40).toISOString(),
      },
      row("paused34", "limit-paused"),
    ]);
    v.getByText(/resumes after Oct 9, 4:40 PM/);
    v.getByText(/reset time not reported/);
  });
  it("keeps blocked transcript actions focusable and inert and emits only live wrapper log actions", () => {
    const v = view([
      { ...row("blocked1"), hasTranscript: false },
      { ...row("live1234", "running"), liveLogRunId: "wrapper-live" },
      { ...row("current1", "running"), lastActivityAt: new Date(now).toISOString() },
      { ...row("ended123"), liveLogRunId: "ended-wrapper" },
      { ...row("interact", "running"), origin: "interactive", liveLogRunId: "interactive-wrapper" },
    ]);
    const blocked = v.getByRole("button", { name: "Open transcript for Alpha · Session blocked1" });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.hasAttribute("disabled")).toBe(false);
    blocked.focus();
    expect(document.activeElement).toBe(blocked);
    fireEvent.click(blocked);
    fireEvent.keyDown(blocked, { key: "Enter" });
    expect(v.emit).not.toHaveBeenCalled();
    v.getByText("Transcript not found");
    fireEvent.click(
      v.getByRole("button", { name: "Follow live log for Alpha · Session live1234" }),
    );
    expect(v.emit).toHaveBeenCalledWith({
      id: "codex-follow-log-wrapper-live",
      label: "Follow live log",
      capability: "codex:follow-log",
      target: { wrapperRunId: "wrapper-live" },
    });
    expect(v.getAllByRole("button", { name: /Follow live log/ })).toHaveLength(1);
  });
  it("reads the persistent status signal verbatim", async () => {
    const v = view();
    expect(v.container.querySelector("section > p[role=status]")?.textContent).toBe("");
    await act(() => {
      codexActionStatus.value = { kind: "failure", text: "Exact feedback." };
    });
    expect(v.container.querySelector("section > p[role=status]")?.textContent).toBe(
      "Exact feedback.",
    );
  });
  it.each(["throw", "reject"])(
    "emits shared enable descriptor and contains %s failure",
    async (kind) => {
      const emit = vi.fn(() => {
        if (kind === "throw") throw new Error("private");
        return Promise.reject(new Error("private"));
      });
      const v = view(undefined, false, false, emit);
      fireEvent.click(v.getByRole("button", { name: CODEX_COPY.analysisSessionsAriaLabel }));
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ capability: "usage:enable-transcript-analysis" }),
      );
      await waitFor(() => v.getByText(CODEX_COPY.analysisFailure));
      v.getByText(CODEX_COPY.analysisRetry);
      expect(v.container.textContent).not.toContain("private");
    },
  );
  it("conditions analysis and hook notes and uses titles only after opt in", () => {
    const v = view([{ ...row("abcd1234"), title: "Prompt title" }], true, null);
    v.getByText("Alpha · Prompt title");
    expect(v.queryByText(CODEX_COPY.analysisOffNote)).toBeNull();
    expect(v.queryByText(CODEX_COPY.hookNotInstalledNote)).toBeNull();
    cleanup();
    view().getByText(CODEX_COPY.hookNotInstalledNote);
    cleanup();
    expect(view([]).queryByText(CODEX_COPY.hookNotInstalledNote)).toBeNull();
  });
  it("replaces format-changed body and guards versions, retaining empty status and Source", () => {
    for (const version of ["0.12.3", "/Users/USERNAME/private", null]) {
      const v = render(
        <CodexSessionsSection
          rows={{ kind: "unavailable", reason: "format-changed", version }}
          size="tall"
        />,
      );
      v.getByText(CODEX_COPY.sessionsUnavailable);
      v.getByText(
        `The Codex data format changed in ${version === "0.12.3" ? "Codex 0.12.3" : "Your Codex version"}, so sessions are hidden rather than shown wrong.`,
      );
      expect(v.container.querySelector("section > p[role=status]")?.textContent).toBe("");
      expect(v.queryByRole("list")).toBeNull();
      v.getByRole("button", { name: "Source for recent sessions" });
      cleanup();
    }
  });
  it("reports empty recent rows and count provenance without an overflow button", () => {
    const v = view([]);
    v.getByText(CODEX_COPY.noRecentSessions);
    fireEvent.click(v.getByRole("button", { name: "Source for recent sessions" }));
    v.getByText("Source: Codex session records");
    v.getByText("Freshness: Live");
    expect(v.queryByRole("button", { name: /more/ })).toBeNull();
  });
  it.each(["running", "limit-paused", "stale", "failed", "completed", "cancelled"] as const)(
    "scans %s rows and accessible names for billing and non-name paths",
    (state) => {
      const v = view(Array.from({ length: 6 }, (_, i) => row(`thread-${i}`, state)));
      const names = v
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(new Set(names).size).toBe(names.length);
      for (const text of [
        v.container.textContent,
        ...names,
        ...Array.from(v.container.querySelectorAll("[title]"), (el) => el.getAttribute("title")),
      ]) {
        expect(text).not.toMatch(
          /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
        );
        expect(text).not.toMatch(/[/\\]/);
      }
    },
  );
});

describe("Session budget overflow", () => {
  it.each([
    [6, "1 more session isn't shown."],
    [7, "2 more sessions aren't shown."],
  ] as const)("renders %s rows as plain remainder text", (count, line) => {
    const v = view(
      Array.from({ length: count }, (_, i) => row(`thread-${i}`)),
      true,
      true,
    );
    v.getByText(line);
    expect(v.container.querySelectorAll(".ccc-list-row")).toHaveLength(5);
    expect(v.queryByRole("button", { name: /more/ })).toBeNull();
  });
});
