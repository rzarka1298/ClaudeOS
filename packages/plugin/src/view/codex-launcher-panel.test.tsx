import type { DetectionResponse, LauncherConfigView } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import {
  CODEX_APP_BUNDLE,
  CODEX_USER_INSTALL,
  fakeLaunchersActions,
  NOTHING_SAVED,
  withCodexDetection,
} from "../test-support/launchers-fixtures.js";
import { CodexLauncherPanel } from "./codex-launcher-panel.js";
import { createLaunchersSession, type LaunchersSession } from "./launchers-settings.js";

/**
 * The Codex launcher panel (plan 05.1-31, D-11, CODEX-03, UI-SPEC S4-b):
 * built from the same kit as the Claude Code panel. Every service call goes
 * through a fake `LaunchersActions`; the real detection is owner UAT.
 */

const LIVE: ConnectionState = { kind: "live" };
const DISCONNECTED: ConnectionState = { kind: "disconnected", reason: "service-unreachable" };
const NOW = Date.parse("2026-09-30T10:05:00.000Z");

const ONE_CANDIDATE = withCodexDetection([CODEX_USER_INSTALL]);
const TWO_CANDIDATES = withCodexDetection([CODEX_USER_INSTALL, CODEX_APP_BUNDLE]);

const SAVED_CODEX: LauncherConfigView = {
  ...NOTHING_SAVED,
  codex: { executableDisplay: "~/.local/bin/codex", args: [], tested: false },
};

function sessionWith(
  detection: DetectionResponse | null = ONE_CANDIDATE,
  configs: LauncherConfigView | null = NOTHING_SAVED,
): LaunchersSession {
  const session = createLaunchersSession();
  session.detection.value = detection;
  session.configs.value = configs;
  return session;
}

function mount(
  actions: LaunchersActions,
  session: LaunchersSession = sessionWith(),
  connection: ConnectionState = LIVE,
) {
  return render(
    <CodexLauncherPanel
      actions={actions}
      session={session}
      connection={connection}
      now={NOW}
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

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Codex" });
}

function saveButton(): HTMLElement {
  return within(panel()).getByRole("button", { name: "Save launcher" });
}

afterEach(cleanup);

describe("the Codex panel, tracer (plan 05.1-31 Task 1)", () => {
  it("shows the only detected candidate preselected, saves it by id with no terminal, and reads Set up", async () => {
    const actions = fakeLaunchersActions({
      getConfigs: () => Promise.resolve({ kind: "loaded" as const, configs: SAVED_CODEX }),
    });
    const session = sessionWith();
    mount(actions, session);
    const radio = within(panel()).getByRole<HTMLInputElement>("radio", {
      name: "Found Codex 0.159.2 at ~/.local/bin/codex.",
    });
    expect(radio.checked).toBe(true);
    expect(within(panel()).getByText("Not set up")).toBeTruthy();

    fireEvent.click(saveButton());
    expect(actions.save).toHaveBeenCalledTimes(1);
    const request = vi.mocked(actions.save).mock.calls[0]?.[0];
    expect(request).toEqual({
      launcherId: "codex",
      executable: { kind: "candidate", candidateId: "codex-1" },
      args: [],
    });
    expect(Object.keys(request as object)).not.toContain("terminal");

    await settle();
    expect(within(panel()).getByText("Set up")).toBeTruthy();
    expect(within(panel()).getByText("Saved")).toBeTruthy();
  });

  it("renders no path other than the display path the service sent, and never sends a display string", () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    expect(panel().textContent).toContain("~/.local/bin/codex");
    expect(panel().textContent).not.toMatch(/\/Users\//);
    fireEvent.click(saveButton());
    expect(JSON.stringify(vi.mocked(actions.save).mock.calls)).not.toContain("~/.local/bin/codex");
  });

  it("disconnected: controls are aria-disabled, last-known candidates stay, nothing is called", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(TWO_CANDIDATES), DISCONNECTED);
    expect(
      within(panel())
        .getByRole("radio", { name: /Found Codex 0.159.2 at/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saveButton());
    fireEvent.click(within(panel()).getByRole("radio", { name: /Found Codex 0.158.0 at/ }));
    expect(actions.save).not.toHaveBeenCalled();
    expect(
      within(panel()).getByRole<HTMLInputElement>("radio", { name: /Found Codex 0.158.0 at/ })
        .checked,
    ).toBe(false);
    expect(within(panel()).getByText(/Found Codex 0.159.2 at/)).toBeTruthy();
  });
});
