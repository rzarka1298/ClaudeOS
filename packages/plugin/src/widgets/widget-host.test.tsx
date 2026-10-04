import type { ProjectId } from "@ccc/domain";
import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { launchStatusKey, resetLaunchStatus, setLaunchError } from "../projects/launch-status.js";
import {
  createSystemSettingsOpener,
  SYSTEM_SETTINGS_OPEN_FAILED_NOTICE,
} from "../projects/system-settings-opener.js";
import { Shell } from "../view/shell.js";
import type { WidgetState } from "./contract.js";
import type { ProjectRow } from "./panels.js";
import { dispatchQuickAction } from "./quick-actions.js";
import type { WidgetId } from "./registry.js";

/**
 * Wave-5 review findings 4 and 6: what a widget body can reach of its host.
 *
 * - Finding 4: `Start a Claude Code session` is only live when the host
 *   provides a quick switcher. Until plan 04-14 wires one, the view passes
 *   none, and the button must take the UI-SPEC "unavailable" treatment
 *   (`aria-disabled`, under `Not available yet`, the existing Notice) rather
 *   than sit live and do nothing.
 * - Finding 6: S1's and S8's launch status lines show `Open Automation
 *   settings` / `Open Privacy & Security settings` when the host provides the
 *   System Settings route (RR-16), as S3 already does; a failed open posts a
 *   Notice through the host's notice port.
 */

const OBSERVED = "2026-09-30T11:58:00.000Z";
const PROJECT_ID = "abcdefghi0123456789abcdef0123401" as ProjectId;
const LAUNCHERS = {
  antigravity: "set-up",
  "claude-code": { status: "set-up", terminalLabel: "Terminal" },
  "claude-desktop": "set-up",
};

function ready(data: unknown): WidgetState<unknown> {
  return {
    kind: "ready",
    data,
    observedAt: OBSERVED,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };
}

const ROW: ProjectRow = {
  id: PROJECT_ID,
  name: "example-project",
  pinned: true,
  git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
  gitReadFailed: false,
  github: { kind: "none" },
  observedAt: OBSERVED,
  openItems: null,
  sessionCount: null,
  nextTask: null,
};

function stateFor(id: WidgetId): ReadonlySignal<WidgetState<unknown>> {
  if (id === "quick-actions") return signal(ready({ launchers: LAUNCHERS }));
  if (id === "project-shortcuts") return signal(ready({ projects: [ROW], launchers: LAUNCHERS }));
  return signal({ kind: "unavailable" });
}

function card(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (section === null) throw new Error(`no ${title} card`);
  return section;
}

afterEach(() => {
  cleanup();
  resetLaunchStatus();
  connectionState.value = { kind: "connecting" };
});

describe("Start a Claude Code session without a switcher (finding 4)", () => {
  it("renders aria-disabled in the Not available yet group", () => {
    connectionState.value = { kind: "live" };
    render(<Shell stateFor={stateFor} />);
    const quick = card("Quick actions");
    const button = within(quick).getByRole("button", { name: "Start a Claude Code session" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const body = quick.querySelector(".ccc-card-body");
    if (body === null) throw new Error("no body");
    const order = Array.from(body.querySelectorAll("button, p")).map((el) => el.textContent);
    expect(order.indexOf("Not available yet")).toBeLessThan(
      order.indexOf("Start a Claude Code session"),
    );
    // Claude Desktop stays live.
    expect(
      within(quick)
        .getByRole("button", { name: "Open Claude Desktop" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("posts the existing unavailable Notice when activated", () => {
    connectionState.value = { kind: "live" };
    const notify = vi.fn();
    render(<Shell stateFor={stateFor} notify={notify} />);
    fireEvent.click(
      within(card("Quick actions")).getByRole("button", { name: "Start a Claude Code session" }),
    );
    expect(notify).toHaveBeenCalledWith("Start a Claude Code session isn't available yet.");
  });

  it("stays live when a switcher is provided", () => {
    connectionState.value = { kind: "live" };
    const openSwitcher = vi.fn();
    render(<Shell stateFor={stateFor} openSwitcher={openSwitcher} />);
    const button = within(card("Quick actions")).getByRole("button", {
      name: "Start a Claude Code session",
    });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(openSwitcher).toHaveBeenCalledWith("Start Claude Code in ");
  });

  it("the dispatcher answers unavailable when the context has no switcher", () => {
    const notify = vi.fn();
    const result = dispatchQuickAction(
      {
        id: "start-session",
        label: "Start a Claude Code session",
        capability: "switcher:claude-code",
      },
      { navigate: vi.fn(), notify, requestLaunch: vi.fn() },
    );
    expect(result).toEqual({ kind: "unavailable" });
    expect(notify).toHaveBeenCalledWith("Start a Claude Code session isn't available yet.");
  });
});

describe("System Settings buttons on S1 and S8 status lines (finding 6)", () => {
  it("S1 shows Open Automation settings for automation-denied and opens that pane", () => {
    connectionState.value = { kind: "live" };
    setLaunchError(launchStatusKey(PROJECT_ID, "claude-code"), "automation-denied");
    const openSystemSettings = vi.fn();
    render(<Shell stateFor={stateFor} openSystemSettings={openSystemSettings} />);
    fireEvent.click(
      within(card("Project shortcuts")).getByRole("button", { name: "Open Automation settings" }),
    );
    expect(openSystemSettings).toHaveBeenCalledWith("automation");
  });

  it("S1 shows Open Privacy & Security settings for folder-access-denied", () => {
    connectionState.value = { kind: "live" };
    setLaunchError(launchStatusKey(PROJECT_ID, "finder"), "folder-access-denied");
    const openSystemSettings = vi.fn();
    render(<Shell stateFor={stateFor} openSystemSettings={openSystemSettings} />);
    fireEvent.click(
      within(card("Project shortcuts")).getByRole("button", {
        name: "Open Privacy & Security settings",
      }),
    );
    expect(openSystemSettings).toHaveBeenCalledWith("privacy-security");
  });

  it("S8's Claude Desktop line offers the pane button when its error names one", () => {
    connectionState.value = { kind: "live" };
    setLaunchError(launchStatusKey(null, "claude-desktop"), "automation-denied");
    const openSystemSettings = vi.fn();
    render(<Shell stateFor={stateFor} openSystemSettings={openSystemSettings} />);
    fireEvent.click(
      within(card("Quick actions")).getByRole("button", { name: "Open Automation settings" }),
    );
    expect(openSystemSettings).toHaveBeenCalledWith("automation");
  });

  it("omits the pane buttons when the host has no System Settings route", () => {
    connectionState.value = { kind: "live" };
    setLaunchError(launchStatusKey(PROJECT_ID, "claude-code"), "automation-denied");
    render(<Shell stateFor={stateFor} />);
    expect(
      within(card("Project shortcuts")).queryByRole("button", { name: "Open Automation settings" }),
    ).toBeNull();
  });
});

describe("createSystemSettingsOpener (finding 6)", () => {
  it("posts a Notice naming the pane when the open fails", async () => {
    const notify = vi.fn();
    const open = createSystemSettingsOpener(() => Promise.reject(new Error("socket")), notify);
    open("automation");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(SYSTEM_SETTINGS_OPEN_FAILED_NOTICE.automation);
    expect(SYSTEM_SETTINGS_OPEN_FAILED_NOTICE.automation).toContain(
      "System Settings › Privacy & Security › Automation",
    );
  });

  it("posts nothing when the pane opened", async () => {
    const notify = vi.fn();
    const opened = vi.fn(() => Promise.resolve({ ok: true }));
    const open = createSystemSettingsOpener(opened, notify);
    open("privacy-security");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith("privacy-security"));
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it("never puts a path or the error message in the Notice", () => {
    for (const text of Object.values(SYSTEM_SETTINGS_OPEN_FAILED_NOTICE)) {
      expect(text).not.toMatch(/(^|\s)(\/|~\/)/);
    }
  });
});
