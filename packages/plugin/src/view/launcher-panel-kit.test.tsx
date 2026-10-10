import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLaunchersActions } from "../test-support/launchers-fixtures.js";
import {
  answerLauncherTest,
  CODEX_PANEL_DESCRIPTION,
  CODEX_PANEL_NAME,
  createLaunchersSession,
  runLauncherTest,
  setPanelStatus,
  setSaveError,
  terminalTestSentences,
} from "./launcher-panel-kit.js";

/**
 * The launcher kit's Codex additions (plan 05.1-31 Task 1): the widened
 * panel identity, the session's Codex draft and doctor state, and the shared
 * Test flow for the codex id. Existing panels' use of the session is
 * unchanged (their own suites pass unmodified).
 */

afterEach(() => vi.restoreAllMocks());

describe("the launcher session (Codex members)", () => {
  it("creates a null Codex draft and an idle doctor state, leaving the existing members as they were", () => {
    const session = createLaunchersSession();
    expect(session.codexDraft.value).toBeNull();
    expect(session.codexDoctor.value).toEqual({ kind: "idle" });
    expect(session.claudeDraft.value).toBeNull();
    expect(session.status.value).toEqual({});
    expect(session.saveErrors.value).toEqual({});
  });

  it("holds status and save errors under the codex id", () => {
    const session = createLaunchersSession();
    setPanelStatus(session, "codex", { kind: "saved" });
    setSaveError(session, "codex", { kind: "refused", reason: "forbidden-flag", index: 1 });
    expect(session.status.value.codex).toEqual({ kind: "saved" });
    expect(session.saveErrors.value.codex?.kind).toBe("refused");
    setSaveError(session, "codex", null);
    expect(session.saveErrors.value.codex).toBeUndefined();
  });

  it("names the panel Codex with the locked description", () => {
    expect(CODEX_PANEL_NAME).toBe("Codex");
    expect(CODEX_PANEL_DESCRIPTION).toBe(
      "Which codex runs and with which arguments. It opens in the same terminal as Claude Code.",
    );
  });
});

describe("the shared Test flow for the codex id", () => {
  it("runLauncherTest passes the codex id and the saved terminal, and ends in test-sent", async () => {
    const session = createLaunchersSession();
    const actions = fakeLaunchersActions();
    runLauncherTest(session, actions, "codex", { kind: "terminal-app" });
    expect(session.status.value.codex).toEqual({ kind: "testing" });
    expect(actions.test).toHaveBeenCalledWith("codex", { kind: "terminal-app" });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.status.value.codex).toEqual({ kind: "test-sent" });
  });

  it("answerLauncherTest marks the codex row tested through the service, not locally", async () => {
    const session = createLaunchersSession();
    const actions = fakeLaunchersActions();
    answerLauncherTest(session, actions, "codex", true);
    expect(session.status.value.codex).toEqual({ kind: "confirming" });
    expect(actions.markTested).toHaveBeenCalledWith("codex");
  });
});

describe("terminalTestSentences", () => {
  it("names a tab in Antigravity for the Antigravity terminal and a window for every other terminal", () => {
    expect(terminalTestSentences("Antigravity", "Codex")).toEqual({
      explanation:
        "Test opens a new tab in Antigravity at the managed vault folder that shows the Codex version.",
      question: "Test sent. Did a tab open in Antigravity and show the Codex version?",
    });
    expect(terminalTestSentences("Terminal", "Claude Code")).toEqual({
      explanation:
        "Test opens a new Terminal window at the managed vault folder that shows the Claude Code version.",
      question: "Test sent. Did a Terminal window open and show the Claude Code version?",
    });
  });
});
