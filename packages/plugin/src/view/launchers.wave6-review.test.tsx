import type { LauncherConfigView } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { ConfigsOutcome, SaveOutcome, TestOutcome } from "../projects/launchers-actions.js";
import {
  DETECTION,
  deferred,
  fakeLaunchersActions,
  NOTHING_SAVED,
} from "../test-support/launchers-fixtures.js";
import { ClaudeCodePanel } from "./claude-code-panel.js";
import {
  createLaunchersSession,
  type LaunchersSession,
  LaunchersSettings,
} from "./launchers-settings.js";
import { TemplateEditor } from "./template-editor.js";

/**
 * Wave-6 review findings on S6/S7: the App not found badge only when the
 * service reports it (2), drafts kept when edited during a save and stale
 * getConfigs answers dropped (7), focus back to Test launcher after the
 * owner answers a Test (8), and blur errors cleared when the template is
 * replaced from outside (10). Synthetic bundle IDs and `~/` paths only.
 */

const NOW = Date.parse("2026-09-30T10:05:00.000Z");
const LIVE: ConnectionState = { kind: "live" };

function mountSettings(
  actions = fakeLaunchersActions(),
  session: LaunchersSession = createLaunchersSession(),
) {
  return render(
    <LaunchersSettings actions={actions} connection={LIVE} now={NOW} session={session} />,
  );
}

function panel(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

afterEach(cleanup);

describe("App not found only when the service says so (finding 2)", () => {
  const OVERRIDE_SAVED: LauncherConfigView = {
    ...NOTHING_SAVED,
    "claude-desktop": { bundleId: "com.example.custom-desktop", tested: false },
  };

  it("a saved bundle ID detection does not list reads Set up, not App not found", async () => {
    const actions = fakeLaunchersActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({ kind: "loaded", configs: OVERRIDE_SAVED }),
      ),
    });
    mountSettings(actions);
    await settle();
    const desktop = panel("Claude Desktop");
    expect(within(desktop).getByText("Set up")).toBeTruthy();
    expect(within(desktop).queryByText("App not found")).toBeNull();
  });

  it("a Test the service answered app-not-found shows App not found", async () => {
    const actions = fakeLaunchersActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({ kind: "loaded", configs: OVERRIDE_SAVED }),
      ),
      test: vi.fn(() => Promise.resolve<TestOutcome>({ kind: "error", error: "app-not-found" })),
    });
    mountSettings(actions);
    await settle();
    const desktop = panel("Claude Desktop");
    fireEvent.click(
      within(desktop).getByRole("button", { name: "Test the Claude Desktop launcher" }),
    );
    await settle();
    expect(within(desktop).getByText("App not found")).toBeTruthy();
  });
});

describe("a save keeps a draft edited while it ran, and stale configs are dropped (finding 7)", () => {
  it("an app panel keeps the choice made while Save launcher was in flight", async () => {
    const pendingSave = deferred<SaveOutcome>();
    const saved: LauncherConfigView = {
      ...NOTHING_SAVED,
      antigravity: { bundleId: "com.example.antigravity", tested: false },
    };
    const getConfigs = vi
      .fn<() => Promise<ConfigsOutcome>>()
      .mockResolvedValueOnce({ kind: "loaded", configs: NOTHING_SAVED })
      .mockResolvedValue({ kind: "loaded", configs: saved });
    const actions = fakeLaunchersActions({ save: vi.fn(() => pendingSave.promise), getConfigs });
    mountSettings(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: /^Antigravity com/ }));
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    fireEvent.click(within(antigravity).getByRole("radio", { name: /^Antigravity Preview/ }));
    await act(async () => pendingSave.resolve({ kind: "saved" }));
    await settle();
    expect(
      within(antigravity).getByRole<HTMLInputElement>("radio", { name: /^Antigravity Preview/ })
        .checked,
    ).toBe(true);
    expect(within(antigravity).getByText("Unsaved changes")).toBeTruthy();
  });

  it("the Claude Code panel keeps an argument edited while Save launcher was in flight", async () => {
    const pendingSave = deferred<SaveOutcome>();
    const saved: LauncherConfigView = {
      ...NOTHING_SAVED,
      "claude-code": {
        executableDisplay: "~/.local/bin/claude",
        args: ["--model", "opus"],
        terminal: { kind: "terminal-app" },
        tested: false,
      },
    };
    const session = createLaunchersSession();
    session.detection.value = DETECTION;
    session.configs.value = saved;
    const actions = fakeLaunchersActions({
      save: vi.fn(() => pendingSave.promise),
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: {
            ...saved,
            "claude-code": {
              ...(saved["claude-code"] as NonNullable<LauncherConfigView["claude-code"]>),
              args: ["--model", "sonnet"],
            },
          },
        }),
      ),
    });
    render(
      <ClaudeCodePanel
        actions={actions}
        session={session}
        connection={LIVE}
        now={NOW}
        sampleDisplayPath="~/code/example-project"
      />,
    );
    const editor = screen.getByRole("group", { name: "Claude Code arguments" });
    fireEvent.input(within(editor).getByLabelText("Argument 2"), { target: { value: "sonnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Save launcher" }));
    fireEvent.input(within(editor).getByLabelText("Argument 2"), { target: { value: "haiku" } });
    await act(async () => pendingSave.resolve({ kind: "saved" }));
    await settle();
    expect(within(editor).getByLabelText<HTMLInputElement>("Argument 2").value).toBe("haiku");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("an older getConfigs answer arriving after a newer one is dropped", async () => {
    const first = deferred<ConfigsOutcome>();
    const second = deferred<ConfigsOutcome>();
    const saved: LauncherConfigView = {
      ...NOTHING_SAVED,
      antigravity: { bundleId: "com.example.antigravity", tested: false },
    };
    const getConfigs = vi
      .fn<() => Promise<ConfigsOutcome>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const actions = fakeLaunchersActions({ getConfigs });
    mountSettings(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: /^Antigravity com/ }));
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    await settle();
    expect(getConfigs).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ kind: "loaded", configs: saved }));
    await act(async () => first.resolve({ kind: "loaded", configs: NOTHING_SAVED }));
    await settle();
    expect(screen.getByText("1 of 3 launchers set up")).toBeTruthy();
  });
});

describe("focus returns to Test launcher after the owner answers (finding 8)", () => {
  it("It opened moves focus to Test launcher", async () => {
    mountSettings();
    await settle();
    const finder = panel("Finder");
    const testButton = within(finder).getByRole("button", { name: "Test the Finder launcher" });
    testButton.focus();
    fireEvent.click(testButton);
    await settle();
    const opened = within(finder).getByRole("button", { name: "It opened" });
    expect(document.activeElement).toBe(opened);
    fireEvent.click(opened);
    await waitFor(() => expect(document.activeElement).toBe(testButton));
  });

  it("It didn't open moves focus to Test launcher", async () => {
    mountSettings();
    await settle();
    const finder = panel("Finder");
    const testButton = within(finder).getByRole("button", { name: "Test the Finder launcher" });
    testButton.focus();
    fireEvent.click(testButton);
    await settle();
    fireEvent.click(within(finder).getByRole("button", { name: "It didn't open" }));
    await waitFor(() => expect(document.activeElement).toBe(testButton));
  });

  it("It opened on a saved app launcher moves focus to its Test launcher", async () => {
    const actions = fakeLaunchersActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: {
            ...NOTHING_SAVED,
            "claude-desktop": { bundleId: "com.example.claude-desktop", tested: false },
          },
        }),
      ),
    });
    mountSettings(actions);
    await settle();
    const desktop = panel("Claude Desktop");
    const testButton = within(desktop).getByRole("button", {
      name: "Test the Claude Desktop launcher",
    });
    testButton.focus();
    fireEvent.click(testButton);
    await settle();
    fireEvent.click(within(desktop).getByRole("button", { name: "It opened" }));
    await waitFor(() => expect(document.activeElement).toBe(testButton));
  });
});

describe("blur errors clear when the template is replaced from outside (finding 10)", () => {
  function Switchable(): VNode {
    const [value, setValue] = useState<readonly string[]>(["/usr/bin/example", ""]);
    return (
      <>
        <button type="button" onClick={() => setValue(["/usr/bin/open", "-na", "{script}"])}>
          Switch preset
        </button>
        <TemplateEditor
          kind="terminal"
          value={value}
          onChange={setValue}
          errors={new Map()}
          sampleDisplayPath="~/code/example-project"
          terminalLabel="Terminal"
        />
      </>
    );
  }

  it("a preset switch drops the row-indexed blur error of the old template", async () => {
    render(<Switchable />);
    fireEvent.blur(screen.getByLabelText("Argument 1"));
    expect(screen.getByText("Arguments can't be empty.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch preset" }));
    await waitFor(() => expect(screen.queryByText("Arguments can't be empty.")).toBeNull());
    expect(screen.getByLabelText("Argument 1").getAttribute("aria-invalid")).toBeNull();
  });

  it("the editor's own edits keep the other rows' blur errors", () => {
    render(<Switchable />);
    fireEvent.blur(screen.getByLabelText("Executable"));
    fireEvent.input(screen.getByLabelText("Executable"), { target: { value: "relative" } });
    fireEvent.blur(screen.getByLabelText("Executable"));
    fireEvent.blur(screen.getByLabelText("Argument 1"));
    expect(screen.getByText("Arguments can't be empty.")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Executable"), { target: { value: "/usr/bin/x" } });
    expect(screen.getByText("Arguments can't be empty.")).toBeTruthy();
  });
});
