import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { requestLaunchersFocus } from "./launchers-focus.js";
import { navigationRequest, requestDestination } from "./navigation-request.js";
import {
  requestSettingsSection,
  type SettingsSectionId,
  settingsSectionRequested,
  takeSettingsSectionRequest,
} from "./settings-sections.js";
import { Shell } from "./shell.js";

/**
 * The Settings destination's frame (plan 08-11 Task 1; 08-UI-SPEC S1, R-01, R-02): a heading,
 * a description, one polite status line, a `Settings sections` nav that is ONE tab stop with
 * roving tabindex, and a deep link that lands on a section heading exactly once.
 */

/** Launchers actions that never answer: the section mounts and stays put. */
const PENDING_LAUNCHERS: LaunchersActions = {
  detect: () => new Promise<never>(() => {}),
  getConfigs: () => new Promise<never>(() => {}),
  save: vi.fn(),
  test: vi.fn(),
  markTested: vi.fn(),
  openSystemSettings: vi.fn(),
  codexDoctor: vi.fn(),
};

beforeEach(() => {
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
  navigationRequest.value = null;
});

function renderShell(initialDestination: "settings" | "overview" = "settings") {
  return render(
    <Shell initialDestination={initialDestination} launchersActions={PENDING_LAUNCHERS} />,
  );
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Settings sections" });
}

function navItem(label: string): HTMLElement {
  return within(nav()).getByRole("button", { name: label });
}

function sectionHeading(name: string): HTMLElement {
  return screen.getByRole("heading", { level: 3, name });
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The tab stop before `element` in document order, the way Shift+Tab finds it (jsdom has no Tab key). */
function previousTabStop(element: HTMLElement): Element | null {
  const stops = [...document.querySelectorAll(TABBABLE)].filter(
    (candidate) => candidate.getAttribute("tabindex") !== "-1",
  );
  const before = stops.filter(
    (candidate) =>
      candidate !== element &&
      (candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  return before.at(-1) ?? null;
}

describe("Task 1 (tracer): the Settings frame with a nav and a deep link to the Launchers heading", () => {
  it("Test 1: shows the Settings heading, the description, the nav and the two registered sections", () => {
    renderShell();
    expect(screen.getByRole("heading", { level: 2, name: "Settings" })).toBeTruthy();
    // The shell's generic heading is left out: the destination carries its own, once.
    expect(screen.getAllByRole("heading", { level: 2, name: "Settings" })).toHaveLength(1);
    expect(screen.getByText("Plugin configuration and diagnostics.")).toBeTruthy();
    expect(nav().tagName).toBe("NAV");
    expect(within(nav()).getByRole("button", { name: "Projects" })).toBeTruthy();
    expect(within(nav()).getByRole("button", { name: "Launchers" })).toBeTruthy();
    // The first open shows Projects (R-01) and marks it current.
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
    expect(navItem("Launchers").getAttribute("aria-current")).toBeNull();
    expect(sectionHeading("Projects")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3, name: "Launchers" })).toBeNull();
  });

  it("Test 1: has one polite status line, present and empty before its first message", () => {
    renderShell();
    const status = document.querySelector(".ccc-settings-status");
    expect(status).not.toBeNull();
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("");
  });

  it("Test 1: requestLaunchersFocus() then selecting Settings activates Launchers and focuses its heading", async () => {
    renderShell("overview");
    requestLaunchersFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(navItem("Launchers").getAttribute("aria-current")).toBe("page");
    const heading = sectionHeading("Launchers");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    // The request was consumed: it will not fire again.
    expect(settingsSectionRequested.value).toBeNull();
  });

  it("Test 1: a deep link made while Settings is open switches section and focuses the heading", async () => {
    renderShell();
    await act(async () => {
      requestSettingsSection("launchers");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(navItem("Launchers").getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(sectionHeading("Launchers"));
  });

  it("Test 2: switching to Settings by its tab leaves focus on the tab and does not change the section", async () => {
    renderShell("overview");
    const tab = screen.getByRole("tab", { name: "Settings" });
    tab.focus();
    fireEvent.click(tab);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(tab);
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).not.toBe(sectionHeading("Projects"));

    // Visiting another section, leaving and coming back keeps it (in memory only).
    fireEvent.click(navItem("Launchers"));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    tab.focus();
    fireEvent.click(tab);
    await act(async () => {
      await Promise.resolve();
    });
    expect(navItem("Launchers").getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(tab);
  });

  it("Test 3: the nav is one tab stop with a roving tabindex on the active item", () => {
    renderShell();
    const items = within(nav()).getAllByRole("button");
    expect(items.map((item) => item.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    expect(items.every((item) => item.tagName === "BUTTON")).toBe(true);
    expect(items.every((item) => item.getAttribute("type") === "button")).toBe(true);
  });

  it("Test 3: arrow keys move focus without activating, wrapping at both ends", () => {
    renderShell();
    const order = [
      "Projects",
      "Launchers",
      "Integrations",
      "Approvals and tasks",
      "Visual",
      "Security",
      "Diagnostics",
    ];
    navItem("Projects").focus();
    fireEvent.keyDown(navItem("Projects"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(navItem("Launchers"));
    // Moving did not activate: Projects is still the current section.
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
    expect(navItem("Launchers").getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: "Launchers" })).toBeNull();

    // Down walks the whole list and wraps from the last item to the first.
    for (const label of order.slice(2)) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
      expect(document.activeElement).toBe(navItem(label));
    }
    fireEvent.keyDown(navItem("Diagnostics"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(navItem("Projects"));
    // Up wraps from the first item to the last.
    fireEvent.keyDown(navItem("Projects"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(navItem("Diagnostics"));
    // Left and right do the same, for the wrapped layout.
    fireEvent.keyDown(navItem("Diagnostics"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(navItem("Projects"));
    fireEvent.keyDown(navItem("Projects"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(navItem("Diagnostics"));
    // None of it activated anything.
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
  });

  it("Test 3: Home and End jump to the first and last item", () => {
    renderShell();
    navItem("Projects").focus();
    fireEvent.keyDown(navItem("Projects"), { key: "End" });
    expect(document.activeElement).toBe(navItem("Diagnostics"));
    fireEvent.keyDown(navItem("Diagnostics"), { key: "Home" });
    expect(document.activeElement).toBe(navItem("Projects"));
  });

  it("Test 3: a key with a modifier is left to the browser", () => {
    renderShell();
    navItem("Projects").focus();
    fireEvent.keyDown(navItem("Projects"), { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(navItem("Projects"));
  });

  it("Test 3: activating an item shows its section and focuses the heading; Shift+Tab returns to the active item", async () => {
    renderShell();
    fireEvent.click(navItem("Launchers"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(navItem("Launchers").getAttribute("aria-current")).toBe("page");
    expect(navItem("Projects").getAttribute("aria-current")).toBeNull();
    const heading = sectionHeading("Launchers");
    expect(document.activeElement).toBe(heading);
    // The roving tabindex followed the activation.
    expect(navItem("Launchers").getAttribute("tabindex")).toBe("0");
    expect(navItem("Projects").getAttribute("tabindex")).toBe("-1");
    // Shift+Tab from the heading lands on the active item, not on a stale one.
    expect(previousTabStop(heading)).toBe(navItem("Launchers"));
  });

  it("Test 4: a request for a section that does not exist yet leaves the current section unchanged", async () => {
    renderShell();
    await act(async () => {
      requestSettingsSection("schedules");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
    expect(within(nav()).queryByRole("button", { name: "Schedules" })).toBeNull();
    // The request was still consumed, so it cannot fire later when the section exists.
    expect(settingsSectionRequested.value).toBeNull();
  });

  it("Test 4: an unknown id is ignored and never reaches the destination", async () => {
    renderShell();
    await act(async () => {
      requestSettingsSection("nonsense" as SettingsSectionId);
    });
    expect(settingsSectionRequested.value).toBeNull();
    expect(navItem("Projects").getAttribute("aria-current")).toBe("page");
  });

  it("renders exactly the registered sections in the fixed order; the others are not in the nav", () => {
    renderShell();
    const labels = within(nav())
      .getAllByRole("button")
      .map((button) => button.textContent);
    // Paths and Schedules arrive with 08-18.
    expect(labels).toEqual([
      "Projects",
      "Launchers",
      "Integrations",
      "Approvals and tasks",
      "Visual",
      "Security",
      "Diagnostics",
    ]);
  });

  it("the shell's navigation request for Settings after a launchers request still lands on the heading", async () => {
    renderShell("overview");
    await act(async () => {
      requestLaunchersFocus();
      requestDestination("settings");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(sectionHeading("Launchers"));
  });

  it("the Overview Connect action's request lands on the Integrations heading and connects nothing (R-10)", async () => {
    renderShell("overview");
    await act(async () => {
      requestSettingsSection("integrations");
      requestDestination("settings");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(sectionHeading("Integrations"));
    expect(screen.queryByRole("button", { name: /connect|sign in/i })).toBeNull();
  });
});
