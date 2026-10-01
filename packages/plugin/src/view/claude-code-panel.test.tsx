import {
  type DetectionResponse,
  type LauncherConfigView,
  TEMPLATE_REFUSAL_REASONS,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions, SaveOutcome } from "../projects/launchers-actions.js";
import {
  DETECTION,
  fakeLaunchersActions,
  NOTHING_SAVED,
  OSASCRIPT_PRESET_ARGV,
} from "../test-support/launchers-fixtures.js";
import { ClaudeCodePanel } from "./claude-code-panel.js";
import { createLaunchersSession, type LaunchersSession } from "./launchers-settings.js";
import { TEMPLATE_REFUSAL_COPY } from "./template-editor.js";

/**
 * The Claude Code launcher panel (Task 2, PROJ-10, D-21, D-22, D-23, RR-13,
 * PR-13): the executable, the terminal choice with its Unverified presets,
 * the two argument editors and the save body.
 */

const LIVE: ConnectionState = { kind: "live" };

function sessionWith(
  detection: DetectionResponse | null = DETECTION,
  configs: LauncherConfigView | null = NOTHING_SAVED,
): LaunchersSession {
  const session = createLaunchersSession();
  session.detection.value = detection;
  session.configs.value = configs;
  return session;
}

function mount(actions: LaunchersActions, session: LaunchersSession = sessionWith()) {
  return render(
    <ClaudeCodePanel
      actions={actions}
      session={session}
      connection={LIVE}
      now={Date.parse("2026-09-30T10:05:00.000Z")}
      sampleDisplayPath="~/code/example-project"
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function save(): void {
  fireEvent.click(screen.getByRole("button", { name: "Save launcher" }));
}

afterEach(cleanup);

describe("the claude executable (D-21)", () => {
  it("offers each detected executable as a radio with its home-abbreviated mono path", () => {
    mount(fakeLaunchersActions());
    const group = screen.getByRole("group", { name: "Claude Code executable" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    const local = within(group).getByText("~/.local/bin/claude");
    expect(local.className).toContain("ccc-display-path");
    expect(within(group).getByText("/opt/homebrew/bin/claude")).toBeTruthy();
  });

  it("Use a different path reveals the Path to claude field", () => {
    mount(fakeLaunchersActions());
    expect(screen.queryByLabelText("Path to claude")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Use a different path" }));
    const input = screen.getByLabelText<HTMLInputElement>("Path to claude");
    expect(input.className).toContain("ccc-text-input--mono");
  });

  it("says so when no executable was found", () => {
    mount(fakeLaunchersActions(), sessionWith({ ...DETECTION, claudeExecutables: [] }));
    expect(screen.getByText("Claude Code wasn't found in the usual places.")).toBeTruthy();
    expect(screen.getByText("Enter the full path to the claude executable.")).toBeTruthy();
  });

  it("a detected executable is sent by its candidate id, never as a path", async () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    save();
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId: "candidate-1" },
      args: [],
      terminal: { kind: "terminal-app" },
    });
    await settle();
  });

  it("a typed path is sent as typed; a relative one is refused before sending", () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    fireEvent.click(screen.getByRole("radio", { name: "Use a different path" }));
    const input = screen.getByLabelText("Path to claude");
    fireEvent.input(input, { target: { value: "bin/claude" } });
    save();
    expect(actions.save).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the full path, starting with /.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.input(input, { target: { value: "/usr/local/bin/claude" } });
    save();
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "claude-code",
      executable: { kind: "path", path: "/usr/local/bin/claude" },
      args: [],
      terminal: { kind: "terminal-app" },
    });
  });
});

describe("the terminal choice (D-23)", () => {
  it("offers Terminal and Custom terminal with their meta lines", () => {
    mount(fakeLaunchersActions());
    const group = screen.getByRole("group", { name: "Terminal" });
    expect(within(group).getByRole("radio", { name: /^Terminal/ })).toBeTruthy();
    expect(within(group).getByText("Built in to macOS.")).toBeTruthy();
    expect(within(group).getByRole("radio", { name: /^Custom terminal/ })).toBeTruthy();
    expect(
      within(group).getByText("Any terminal, started from an argument template."),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Terminal arguments" })).toBeNull();
  });

  it("Custom terminal offers the presets labelled unverified, with the Unverified badge", () => {
    mount(fakeLaunchersActions());
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    const select = screen.getByLabelText<HTMLSelectElement>("Start from a preset");
    const options = Array.from(select.options).map((option) => option.textContent);
    expect(options).toEqual([
      "iTerm2 (unverified)",
      "Ghostty (unverified)",
      "WezTerm (unverified)",
      "Blank template",
    ]);
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Terminal arguments" })).toBeTruthy();
  });

  it("choosing a preset fills the terminal editor with its argv, one row per element", () => {
    mount(fakeLaunchersActions());
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    fireEvent.change(screen.getByLabelText("Start from a preset"), {
      target: { value: "iterm2" },
    });
    const editor = screen.getByRole("group", { name: "Terminal arguments" });
    expect(within(editor).getByLabelText<HTMLInputElement>("Executable").value).toBe(
      "/usr/bin/osascript",
    );
    expect(within(editor).getAllByRole("textbox")).toHaveLength(OSASCRIPT_PRESET_ARGV.length);
    expect(screen.getByText("iTerm2 wasn't found on this Mac.")).toBeTruthy();
  });

  it("saves a custom terminal as its preset and argv", () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    fireEvent.change(screen.getByLabelText("Start from a preset"), {
      target: { value: "ghostty" },
    });
    save();
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId: "candidate-1" },
      args: [],
      terminal: {
        kind: "custom",
        preset: "ghostty",
        argv: ["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "{script}"],
      },
    });
  });
});

describe("service refusals land on the row they name (PR-13)", () => {
  function refusing(outcome: SaveOutcome): LaunchersActions {
    return fakeLaunchersActions({ save: vi.fn(() => Promise.resolve(outcome)) });
  }

  it("forbidden-flag at index 2 appears under Argument 2", async () => {
    mount(
      refusing({ kind: "refused", reason: "forbidden-flag", index: 2, template: "claude-code" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.click(within(editor).getByRole("button", { name: "Add argument" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Add argument" }));
    fireEvent.input(within(editor).getByLabelText("Argument 1"), { target: { value: "--model" } });
    fireEvent.input(within(editor).getByLabelText("Argument 2"), {
      target: { value: "--dangerously-skip-permissions" },
    });
    save();
    await settle();
    const row = within(editor).getByLabelText("Argument 2");
    expect(row.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(row.getAttribute("aria-describedby") ?? "");
    expect(error?.textContent).toContain("--dangerously-skip-permissions isn't allowed here.");
  });

  it("missing-script-placeholder says the template needs a {script} argument", async () => {
    mount(
      refusing({
        kind: "refused",
        reason: "missing-script-placeholder",
        index: null,
        template: "terminal",
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    fireEvent.change(screen.getByLabelText("Start from a preset"), {
      target: { value: "ghostty" },
    });
    save();
    await settle();
    expect(screen.getByText("The template needs a {script} argument.")).toBeTruthy();
  });

  it.each(TEMPLATE_REFUSAL_REASONS)("every refusal reason has visible copy: %s", async (reason) => {
    const outcome: SaveOutcome =
      reason === "missing-script-placeholder"
        ? { kind: "refused", reason, index: null, template: "terminal" }
        : { kind: "refused", reason, index: 1, template: "claude-code" };
    mount(refusing(outcome));
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Custom terminal/ }));
    fireEvent.change(screen.getByLabelText("Start from a preset"), {
      target: { value: "ghostty" },
    });
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.click(within(editor).getByRole("button", { name: "Add argument" }));
    fireEvent.input(within(editor).getByLabelText("Argument 1"), {
      target: { value: "--example" },
    });
    save();
    await settle();
    const copy = TEMPLATE_REFUSAL_COPY[reason];
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).not.toMatch(/(^|\s)(\/|~\/)[A-Za-z]/);
    const errors = Array.from(document.querySelectorAll(".ccc-field-error")).map(
      (node) => node.textContent ?? "",
    );
    expect(errors.some((text) => text.includes(copy))).toBe(true);
  });
});

describe("drafts (RR-25)", () => {
  it("an edited draft shows Unsaved changes and Discard changes restores the saved template", () => {
    const saved: LauncherConfigView = {
      ...NOTHING_SAVED,
      "claude-code": {
        executableDisplay: "~/.local/bin/claude",
        args: ["--model", "opus"],
        terminal: { kind: "terminal-app" },
        tested: false,
      },
    };
    mount(fakeLaunchersActions(), sessionWith(DETECTION, saved));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.input(within(editor).getByLabelText("Argument 2"), { target: { value: "sonnet" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(within(editor).getByLabelText<HTMLInputElement>("Argument 2").value).toBe("opus");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3: the Claude Code Test (D-28, PR-02, RR-14, wave-5 Automation cap)

const ITERM_SAVED: LauncherConfigView = {
  ...NOTHING_SAVED,
  "claude-code": {
    executableDisplay: "~/.local/bin/claude",
    args: [],
    terminal: { kind: "custom", preset: "iterm2", argv: [...OSASCRIPT_PRESET_ARGV] },
    tested: false,
  },
};

describe("the Claude Code Test (D-28, PR-02)", () => {
  it("a custom terminal shows the Automation line instead of No permission needed", () => {
    mount(fakeLaunchersActions(), sessionWith(DETECTION, ITERM_SAVED));
    expect(
      screen.getByText(
        "macOS may ask for Automation permission during this test. Choose OK so launches can work.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No permission needed")).toBeNull();
    expect(
      screen.getByText(
        "Test opens a new iTerm2 window at the managed vault folder that shows the Claude Code version.",
      ),
    ).toBeTruthy();
  });

  it("Testing… appears at once, says it may take a minute, and the Test carries the saved terminal", () => {
    const actions = fakeLaunchersActions({ test: vi.fn(() => new Promise<never>(() => {})) });
    mount(actions, sessionWith(DETECTION, ITERM_SAVED));
    fireEvent.click(screen.getByRole("button", { name: "Test the Claude Code launcher" }));
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("Testing…");
    expect(status).toContain("This can take up to a minute if macOS asks for permission.");
    expect(actions.test).toHaveBeenCalledWith("claude-code", ITERM_SAVED["claude-code"]?.terminal);
  });

  it("asks whether a {Terminal} window opened, and It opened marks Claude Code tested", async () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(DETECTION, ITERM_SAVED));
    fireEvent.click(screen.getByRole("button", { name: "Test the Claude Code launcher" }));
    await settle();
    expect(screen.getByRole("status").textContent).toContain(
      "Test sent. Did a iTerm2 window open and show the Claude Code version?",
    );
    expect(actions.markTested).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "It opened" }));
    await settle();
    expect(actions.markTested).toHaveBeenCalledWith("claude-code");
  });

  it("an unanswered Automation prompt explains itself and offers the Automation settings", async () => {
    const actions = fakeLaunchersActions({
      test: vi.fn(() =>
        Promise.resolve({ kind: "error" as const, error: "automation-denied" as const }),
      ),
    });
    mount(actions, sessionWith(DETECTION, ITERM_SAVED));
    fireEvent.click(screen.getByRole("button", { name: "Test the Claude Code launcher" }));
    await settle();
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("macOS blocked the command center from controlling iTerm2.");
    expect(status).toContain(
      "Allow it in System Settings › Privacy & Security › Automation, then try again.",
    );
    expect(status).toContain(
      "If macOS asked and nobody answered within a minute, test again and choose OK.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Automation settings" }));
    expect(actions.openSystemSettings).toHaveBeenCalledWith("automation");
  });

  it("Test launcher is aria-disabled with Save launcher first while the panel has unsaved changes", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(DETECTION, ITERM_SAVED));
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.click(within(editor).getByRole("button", { name: "Add argument" }));
    const button = screen.getByRole("button", { name: "Test the Claude Code launcher" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Save launcher first");
    fireEvent.click(button);
    expect(actions.test).not.toHaveBeenCalled();
  });

  it("the preset badge reads Tested once the saved custom terminal passed a confirmed Test", () => {
    const tested: LauncherConfigView = {
      ...ITERM_SAVED,
      "claude-code": ITERM_SAVED["claude-code"] && { ...ITERM_SAVED["claude-code"], tested: true },
    };
    mount(fakeLaunchersActions(), sessionWith(DETECTION, tested));
    expect(screen.queryByText("Unverified")).toBeNull();
    expect(screen.getAllByText("Tested").length).toBeGreaterThan(0);
  });
});

describe("an uncertain save reconciles with the service (codex review 3, finding 4)", () => {
  it("a failed save re-reads the saved configuration and keeps the draft", async () => {
    const actions = {
      ...fakeLaunchersActions(),
      save: vi.fn(() => Promise.resolve<SaveOutcome>({ kind: "failed" })),
    };
    const session = sessionWith();
    mount(actions, session);
    fireEvent.click(screen.getByRole("radio", { name: "~/.local/bin/claude" }));
    save();
    await settle();
    expect(actions.getConfigs).toHaveBeenCalledTimes(1);
    expect(session.claudeDraft.value).not.toBeNull();
    expect(
      (screen.getByRole("radio", { name: "~/.local/bin/claude" }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});
