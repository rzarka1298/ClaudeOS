import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { configureHealth } from "../health/api.js";
import { resetHealthState } from "../health/state.js";
import { healthResponse as fixtureResponse, HEALTH_NOW } from "../test-support/health-fixtures.js";
import { DiagnosticsSection } from "./diagnostics-section.js";
import { navigationRequest } from "./navigation-request.js";
import { createInertSettingsHost } from "./settings-host.js";
import { requestSettingsSection, takeSettingsSectionRequest } from "./settings-sections.js";
import { Shell } from "./shell.js";

/**
 * The Diagnostics section (plan 08-13; D-01, D-03, D-43, 08-UI-SPEC S3). Everything above the
 * service is real: the state, the copy and the markup; the health API is a fake that answers what
 * the service would.
 */

const ROW_NAMES = [
  "Companion service",
  "Vault access",
  "Claude Code hooks",
  "Usage collectors",
  "Scheduler",
  "App launchers",
];

const PATHY = "connect ENOENT /Users/secretperson/Library/ccc/service.sock";

type Fetch = (trigger: "gesture" | "reconnect") => Promise<ReturnType<typeof fixtureResponse>>;

function configure(get: Fetch = () => Promise.resolve(fixtureResponse())) {
  const spy = vi.fn(get);
  configureHealth({ api: { get: spy } });
  return spy;
}

function renderSection(
  options: { connection?: ConnectionState; now?: number; notify?: (message: string) => void } = {},
) {
  const notify = options.notify ?? vi.fn();
  const host = createInertSettingsHost();
  const view = (connection: ConnectionState, now: number) => (
    <DiagnosticsSection host={host} connection={connection} now={now} notify={notify} />
  );
  const connection = options.connection ?? { kind: "live" };
  const now = options.now ?? HEALTH_NOW;
  const utils = render(view(connection, now));
  return {
    ...utils,
    notify,
    rerenderWith: (next: ConnectionState, nextNow: number = now) =>
      utils.rerender(view(next, nextNow)),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("li.ccc-health-row")];
}

function rowNamed(name: string): HTMLElement {
  const row = rows().find((candidate) => candidate.querySelector("h5")?.textContent === name);
  if (row === undefined) throw new Error(`no row named ${name}`);
  return row;
}

function chipOf(row: HTMLElement): string {
  const chip = row.querySelector(".ccc-badge[data-status]");
  return (chip?.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  resetHealthState();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  configureHealth(null);
  resetHealthState();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
  navigationRequest.value = null;
});

describe("Task 1 (tracer): opening Diagnostics fetches the health route and shows six honest rows", () => {
  it("Test 1: calls the API once on open, then renders the heading, toolbar, summary and six rows in order", async () => {
    const get = configure();
    renderSection();
    await settle();

    expect(get).toHaveBeenCalledTimes(1);
    // Opening the section is an owner action: the one fetch that may check the Keychain.
    expect(get).toHaveBeenCalledWith("gesture");

    expect(screen.getByRole("heading", { level: 3, name: "Diagnostics" })).toBeTruthy();
    expect(
      screen.getByText(
        "Whether each part of the command center is working, and what to do when it isn't. Checks only read; nothing is installed, launched or sent.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run checks again/ })).toBeTruthy();
    expect(document.querySelector(".ccc-health-summary")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 4, name: "Subsystems" })).toBeTruthy();

    expect(rows().map((row) => row.querySelector("h5")?.textContent)).toEqual(ROW_NAMES);
    // The Companion service row reads Running (UI-SPEC R-note); the five service rows are guidance.
    expect(chipOf(rowNamed("Companion service"))).toContain("Running");
    for (const name of ROW_NAMES.slice(1)) {
      expect(chipOf(rowNamed(name))).toContain("Needs setup");
      expect(rowNamed(name).getAttribute("data-status")).toBe("setup-needed");
    }
    expect(rowNamed("Companion service").getAttribute("data-status")).toBe("ok");
  });

  it("Test 1: shows the service row facts and the five rows' reason sentences", async () => {
    configure();
    renderSection();
    await settle();
    const service = rowNamed("Companion service");
    expect(
      within(service).getByText("The companion service is running and answering."),
    ).toBeTruthy();
    expect(service.textContent).toContain("Version 0.1.0");
    expect(
      within(rowNamed("Vault access")).getByText("No managed vault is set up yet."),
    ).toBeTruthy();
  });

  it("Test 1 (through Settings): a deep link to diagnostics lists the section in the nav and fetches once", async () => {
    const get = configure();
    requestSettingsSection("diagnostics");
    render(<Shell initialDestination="settings" />);
    await settle();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Diagnostics" })).toBeTruthy();
    expect(rows()).toHaveLength(6);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("Test 3: a disconnected service reads Failing with the fixed sentence and none of the reason text", async () => {
    const get = configure();
    renderSection({ connection: { kind: "disconnected", reason: PATHY } });
    await settle();

    const service = rowNamed("Companion service");
    expect(chipOf(service)).toContain("Failing");
    expect(within(service).getByText("The plugin can't reach the companion service.")).toBeTruthy();
    for (const fragment of ["secretperson", "ENOENT", "/Users", "service.sock", "Library"]) {
      expect(document.body.textContent).not.toContain(fragment);
      expect(document.body.innerHTML).not.toContain(fragment);
    }
    // Every other row is cleared, and nothing was fetched from a service that is away.
    for (const name of ROW_NAMES.slice(1)) {
      expect(chipOf(rowNamed(name))).toContain("Unknown");
      expect(
        within(rowNamed(name)).getByText(
          "Can't be checked while the companion service isn't running.",
        ),
      ).toBeTruthy();
    }
    expect(get).not.toHaveBeenCalled();
  });
});
