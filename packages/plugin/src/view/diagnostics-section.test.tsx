import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { configureHealth } from "../health/api.js";
import { resetHealthState } from "../health/state.js";
import {
  allOkHealth,
  allOkHealthFor,
  CLAUDE_INSTALL_ACTION,
  collectorsParts,
  fingerprintFor,
  healthResponse as fixtureResponse,
  GO_LAUNCHERS,
  GO_RESEARCH,
  HEALTH_NOW,
  launcherParts,
  part,
  partsRow,
  plainRow,
  schedulerParts,
  VAULT_SETUP,
} from "../test-support/health-fixtures.js";
import { DiagnosticsSection } from "./diagnostics-section.js";
import { navigationRequest } from "./navigation-request.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import {
  requestSettingsSection,
  settingsSectionRequested,
  takeSettingsSectionRequest,
} from "./settings-sections.js";
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
  options: {
    connection?: ConnectionState;
    now?: number;
    notify?: (message: string) => void;
    host?: SettingsHost;
  } = {},
) {
  const notify = options.notify ?? vi.fn();
  const host = options.host ?? createInertSettingsHost();
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
    // A vault digest is real WebCrypto: it settles on a later turn than a microtask.
    await new Promise((resolve) => window.setTimeout(resolve, 15));
  });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("li.ccc-health-row[data-subsystem]")];
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

// ---------------------------------------------------------------------------
// Task 2: reasons, parts, setup actions, the summary, the vault overlay, not-in-version rows

function hostWith(over: Partial<SettingsHost> = {}): SettingsHost {
  return { ...createInertSettingsHost(), ...over };
}

function hostWithVaultPath(
  basePath: string | null,
  over: Partial<SettingsHost> = {},
): SettingsHost {
  const base = createInertSettingsHost();
  return { ...base, ...over, display: { ...base.display, vaultBasePath: basePath } };
}

function buttonsIn(row: HTMLElement, name: string | RegExp): HTMLElement[] {
  return within(row).queryAllByRole("button", { name });
}

function commandsIn(root: HTMLElement): string[] {
  return [...root.querySelectorAll("code.ccc-health-command")].map(
    (code) => code.textContent ?? "",
  );
}

describe("Task 2, Test 2: parts", () => {
  it("renders Show details (8) for Usage collectors, collapsed on a fresh install, with two labelled groups once open", async () => {
    configure();
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    const toggle = within(row).getByRole("button", {
      name: "Show details for Usage collectors: 8 parts",
    });
    expect(toggle.textContent).toBe("Show details (8)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    expect(document.getElementById(panelId as string)?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Hide details");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const labels = [...row.querySelectorAll(".ccc-section-label--muted")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Claude Code", "Codex"]);
    // Group labels are not headings: the outline stays h3, h4, h5.
    expect(row.querySelectorAll("h6, [role='heading']")).toHaveLength(0);
    const partNames = [...row.querySelectorAll(".ccc-health-part .ccc-health-part-name")].map(
      (name) => name.textContent,
    );
    expect(partNames).toEqual([
      "Usage telemetry",
      "Status line",
      "Transcript analysis",
      "Dropped records",
      "Codex install",
      "Codex hooks",
      "Codex bridge",
      "Codex doctor",
    ]);
  });

  it("shows each part's chip and reason, and the row's reason is the deciding part's", async () => {
    configure();
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    // The first non-passive setup-needed part decides: the status line.
    expect(
      within(row).getAllByText(
        'The status-line wrapper isn\'t installed. Plan usage reads "Account capacity unavailable".',
      ).length,
    ).toBeGreaterThan(0);
    expect(row.querySelector(".ccc-health-detail")?.textContent).toBe("Reported by: Status line");
    fireEvent.click(within(row).getByRole("button", { name: /^Show details/ }));
    const parts = [...row.querySelectorAll<HTMLElement>(".ccc-health-part")];
    expect(parts).toHaveLength(8);
    expect(chipOf(parts[0] as HTMLElement)).toContain("Working");
    expect(chipOf(parts[1] as HTMLElement)).toContain("Needs setup");
    expect(
      within(parts[0] as HTMLElement).getByText(
        "Usage telemetry is arriving in the expected format.",
      ),
    ).toBeTruthy();
  });

  it("expands the details by default when the row is degraded or failing, and collapses an ok one", async () => {
    configure(() =>
      Promise.resolve(
        fixtureResponse({
          launchers: partsRow("launchers", [
            part("antigravity", "launcher-ready"),
            part("claude-code", "bundle-not-found", { setupAction: GO_LAUNCHERS }),
            part("claude-desktop", "launcher-ready"),
            part("codex", "launcher-ready"),
          ]),
          collectors: partsRow("collectors", collectorsParts()),
        }),
      ),
    );
    renderSection();
    await settle();
    const launchers = rowNamed("App launchers");
    expect(launchers.getAttribute("data-status")).toBe("failing");
    expect(buttonsIn(launchers, /^Hide details/)).toHaveLength(1);
    expect(
      within(launchers)
        .getByRole("button", { name: /Hide details|Show details/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const collectors = rowNamed("Usage collectors");
    expect(collectors.getAttribute("data-status")).toBe("ok");
    expect(
      within(collectors)
        .getByRole("button", { name: /^Show details/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("shows the Terminal launcher part only for a custom terminal choice", async () => {
    configure(() =>
      Promise.resolve(
        fixtureResponse({
          launchers: partsRow("launchers", launcherParts("launcher-not-set-up", true)),
        }),
      ),
    );
    renderSection();
    await settle();
    let launchers = rowNamed("App launchers");
    expect(within(launchers).getByRole("button", { name: /^Show details/ }).textContent).toBe(
      "Show details (5)",
    );
    fireEvent.click(within(launchers).getByRole("button", { name: /^Show details/ }));
    expect(
      [...launchers.querySelectorAll(".ccc-health-part-name")].map((name) => name.textContent),
    ).toEqual(["Antigravity", "Claude Code", "Claude Desktop", "Codex", "Terminal"]);

    cleanup();
    resetHealthState();
    configure();
    renderSection();
    await settle();
    launchers = rowNamed("App launchers");
    expect(within(launchers).getByRole("button", { name: /^Show details/ }).textContent).toBe(
      "Show details (4)",
    );
    fireEvent.click(within(launchers).getByRole("button", { name: /^Show details/ }));
    expect(launchers.textContent).not.toContain("Terminal");
  });

  it("shows the scheduler's fixed line and the last successful and failed run when known", async () => {
    configure(() =>
      Promise.resolve(
        fixtureResponse({
          scheduler: partsRow(
            "scheduler",
            schedulerParts({
              lastRun: [
                "run-all-sources-failed",
                { setupAction: GO_RESEARCH, facts: { lastFailureAt: "2026-10-22T08:00:00.000Z" } },
              ],
              key: "research-key-present",
            }),
          ),
        }),
      ),
    );
    renderSection();
    await settle();
    const scheduler = rowNamed("Scheduler");
    expect(scheduler.textContent).toContain(
      "Manual trigger only in this version. Nothing runs on a timer.",
    );
    expect(scheduler.textContent).toContain("Last failed run 1 hour ago.");
    expect(scheduler.textContent).not.toContain("Next run");
  });

  it("puts the deciding part's action on the row and no action twice inside the details", async () => {
    configure();
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    fireEvent.click(within(row).getByRole("button", { name: /^Show details/ }));
    // Claude install (row level, status line), Codex hooks install, Codex bridge install: once each.
    expect(commandsIn(row).sort()).toEqual(
      [
        "./scripts/claude-hooks/install.sh",
        "./scripts/codex-hooks/install.sh",
        "node scripts/codex/install-user-kit.mjs",
      ].sort(),
    );
    const parts = [...row.querySelectorAll<HTMLElement>(".ccc-health-part")];
    // The status-line part is the deciding one: its action lives on the row, not in its part.
    expect(parts[1]?.querySelectorAll("button")).toHaveLength(0);
    expect(parts[2]?.textContent).toContain("Go to the security section");
  });
});

describe("Task 2, Test 3: setup actions do exactly three things", () => {
  it("copies the exact constant, shows it, and posts the copied string to the status line", async () => {
    const copyText = vi.fn(() => Promise.resolve());
    configure();
    const { notify } = renderSection({ host: hostWith({ copyText }) });
    await settle();
    const hooks = rowNamed("Claude Code hooks");
    expect(commandsIn(hooks)).toEqual(["./scripts/claude-hooks/install.sh"]);
    expect(hooks.querySelector("code")?.className).toContain("ccc-mono");
    fireEvent.click(within(hooks).getByRole("button", { name: "Copy install command" }));
    await settle();
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith("./scripts/claude-hooks/install.sh");
    expect(notify).toHaveBeenCalledWith("Install command copied. Run it in Terminal.");
  });

  it("posts a fixed failure line, and no command text, when the clipboard refuses", async () => {
    const copyText = vi.fn(() => Promise.reject(new Error("/Users/someone/denied")));
    configure();
    const { notify } = renderSection({ host: hostWith({ copyText }) });
    await settle();
    fireEvent.click(
      within(rowNamed("Claude Code hooks")).getByRole("button", { name: "Copy install command" }),
    );
    await settle();
    expect(notify).toHaveBeenCalledWith(
      "Couldn't copy the command. It's shown on this row; copy it from there.",
    );
    expect(JSON.stringify(vi.mocked(notify).mock.calls)).not.toContain("denied");
  });

  it("go-to-section security requests that Settings section", async () => {
    configure(() =>
      Promise.resolve(
        fixtureResponse({
          collectors: partsRow(
            "collectors",
            collectorsParts({
              "transcript-analysis": [
                "analysis-off",
                { setupAction: { kind: "go-to-section", section: "security" } },
              ],
            }),
          ),
        }),
      ),
    );
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    fireEvent.click(within(row).getByRole("button", { name: /^Show details/ }));
    fireEvent.click(within(row).getByRole("button", { name: "Go to the security section" }));
    expect(settingsSectionRequested.value).toBe("security");
    expect(navigationRequest.value).toBeNull();
  });

  it("go-to-section research requests the Research destination", async () => {
    configure();
    renderSection();
    await settle();
    fireEvent.click(
      within(rowNamed("Scheduler")).getByRole("button", { name: "Open the research view" }),
    );
    expect(navigationRequest.value?.destination).toBe("research");
    expect(settingsSectionRequested.value).toBeNull();
  });

  it("run-plugin-command vault-setup calls host.runVaultSetup and nothing else", async () => {
    const runVaultSetup = vi.fn(() => Promise.resolve());
    const copyText = vi.fn(() => Promise.resolve());
    const get = configure();
    renderSection({ host: hostWith({ runVaultSetup, copyText }) });
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(within(rowNamed("Vault access")).getByRole("button", { name: "Set up vault" }));
    await settle();
    expect(runVaultSetup).toHaveBeenCalledTimes(1);
    expect(copyText).not.toHaveBeenCalled();
    expect(navigationRequest.value).toBeNull();
    expect(settingsSectionRequested.value).toBeNull();
    // Nothing else: no further health fetch is started by the button either.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("only ever offers copy, navigate or the vault-setup command: no other button text on any row", async () => {
    configure();
    renderSection();
    await settle();
    const allowed = [
      /^Copy install command$/,
      /^Copy key setup command$/,
      /^Set up vault$/,
      /^Go to (the .+ section|diagnostics)$/,
      /^Open the research view$/,
      /^(Show|Hide) details/,
    ];
    for (const row of rows()) {
      for (const button of within(row).queryAllByRole("button", { hidden: true })) {
        const label = button.textContent ?? "";
        expect(
          allowed.some((pattern) => pattern.test(label)),
          `unexpected button: ${label}`,
        ).toBe(true);
      }
    }
  });
});

describe("Task 2, Test 4: the summary", () => {
  function summaryText(): string {
    return (document.querySelector(".ccc-health-summary")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  it("reads the fresh install: Nothing is failing, one working, five need setup, no failing or degraded", async () => {
    configure();
    renderSection();
    await settle();
    expect(summaryText()).toBe("Nothing is failing. ✓ 1 working ⊕ 5 need setup");
    expect(
      rows().filter((row) =>
        ["failing", "degraded"].includes(row.getAttribute("data-status") ?? ""),
      ),
    ).toHaveLength(0);
    expect(
      document.querySelector(".ccc-health-summary .ccc-badge[data-status='failing']"),
    ).toBeNull();
  });

  it("reads 2 subsystems need attention for one failing and one degraded", async () => {
    configure(() =>
      Promise.resolve(
        allOkHealth({
          hooks: plainRow("hooks", "hook-runtime-missing", { setupAction: CLAUDE_INSTALL_ACTION }),
          vault: plainRow("vault", "managed-tree-incomplete", { setupAction: VAULT_SETUP }),
        }),
      ),
    );
    renderSection({ host: hostWithVaultPath(null) });
    await settle();
    expect(summaryText()).toBe("2 subsystems need attention. ✕ 1 failing ▽ 1 degraded ✓ 4 working");
  });

  it("reads All six subsystems are working with only a working chip", async () => {
    const response = await allOkHealthFor("/Users/example/Vaults/Example");
    configure(() => Promise.resolve(response));
    renderSection({ host: hostWithVaultPath("/Users/example/Vaults/Example") });
    await settle();
    expect(summaryText()).toBe("All six subsystems are working. ✓ 6 working");
  });
});

describe("Task 2, Test 5: the vault overlay", () => {
  const BASE = "/Users/example/Vaults/Example";

  async function readyWith(basePathOfService: string | null) {
    const fingerprint = basePathOfService === null ? null : await fingerprintFor(basePathOfService);
    return allOkHealth({ vaultFingerprint: fingerprint });
  }

  it("keeps vault-ready when the open vault is the managed one", async () => {
    const response = await readyWith(BASE);
    configure(() => Promise.resolve(response));
    renderSection({ host: hostWithVaultPath(BASE) });
    await settle();
    expect(chipOf(rowNamed("Vault access"))).toContain("Working");
    expect(within(rowNamed("Vault access")).getByText("The managed vault is ready.")).toBeTruthy();
  });

  it("reads vault-mismatch (degraded) with its next step when the open vault differs", async () => {
    const response = await readyWith(BASE);
    configure(() => Promise.resolve(response));
    renderSection({ host: hostWithVaultPath(`${BASE}-other`) });
    await settle();
    const row = rowNamed("Vault access");
    expect(chipOf(row)).toContain("Degraded");
    expect(
      within(row).getByText(
        "The vault open in Obsidian isn't the one the companion service manages.",
      ),
    ).toBeTruthy();
    expect(
      within(row).getByText("Open the managed vault, or run vault setup from this vault."),
    ).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Set up vault" })).toBeTruthy();
    // Neither path, neither fingerprint nor salt ever reaches the page.
    expect(document.body.textContent).not.toContain("Vaults");
    expect(document.body.innerHTML).not.toContain(response.vaultFingerprint?.digest ?? "x");
    expect(document.body.innerHTML).not.toContain(response.vaultFingerprint?.salt ?? "x");
  });

  it("reads vault-check-unavailable (unknown) for a vault without a base path", async () => {
    const response = await readyWith(BASE);
    configure(() => Promise.resolve(response));
    renderSection({ host: hostWithVaultPath(null) });
    await settle();
    const row = rowNamed("Vault access");
    expect(chipOf(row)).toContain("Unknown");
    expect(
      within(row).getByText("This kind of vault can't be compared with the managed vault."),
    ).toBeTruthy();
    expect(row.getAttribute("data-status")).toBe("unknown");
  });
});

describe("Task 2, Test 6: Not part of this version", () => {
  it("renders Gmail, Google Calendar and GitHub as static rows: the tag, the locked sentence, no button, no time", async () => {
    configure();
    renderSection();
    await settle();
    expect(
      screen.getByRole("heading", { level: 4, name: "Not part of this version" }),
    ).toBeTruthy();
    const scope = [...document.querySelectorAll<HTMLElement>("li[data-scope='not-in-version']")];
    expect(scope.map((row) => row.querySelector("h5")?.textContent)).toEqual([
      "Gmail",
      "Google Calendar",
      "GitHub",
    ]);
    for (const row of scope) {
      const tag = row.querySelector(".ccc-badge[data-status='not-in-version']");
      expect(tag?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "Status: ∅ Not part of this version",
      );
      expect(
        within(row).getByText(
          "Connecting accounts arrives in a later milestone. Nothing is read from this account.",
        ),
      ).toBeTruthy();
      expect(row.querySelector("button, a, time, input")).toBeNull();
      expect(row.textContent).not.toContain("Checked");
      expect(row.querySelector(".ccc-badge[data-badge]")).toBeNull();
    }
  });

  it("is present while loading and while the service is away, and never counted in the summary", async () => {
    configure(() => new Promise(() => {}));
    renderSection();
    await settle();
    expect(document.querySelectorAll("li[data-scope='not-in-version']")).toHaveLength(3);
    cleanup();
    configure();
    renderSection({ connection: { kind: "disconnected", reason: "x" } });
    await settle();
    expect(document.querySelectorAll("li[data-scope='not-in-version']")).toHaveLength(3);
    // 1 failing (the service) and 5 unknown: still six counted rows, not nine.
    expect(
      document.querySelector(".ccc-health-summary")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("1 subsystem needs attention. ✕ 1 failing ? 5 unknown");
  });
});

// ---------------------------------------------------------------------------
// Task 3: loading, error, stale, timeout and disconnected states; keyboard and focus

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof fixtureResponse>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ReturnType<typeof fixtureResponse>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: /^Run checks again/ });
}

describe("Task 3, Test 1: loading", () => {
  it("renders the six names at once, with skeletons for chips, reasons and meta, under aria-busy with hidden text", async () => {
    configure(() => new Promise(() => {}));
    renderSection();
    await settle();

    const health = document.querySelector(".ccc-health");
    expect(health?.getAttribute("aria-busy")).toBe("true");
    expect(health?.querySelector(".ccc-visually-hidden")?.textContent).toBe("Loading diagnostics");
    expect(rows().map((row) => row.querySelector("h5")?.textContent)).toEqual(ROW_NAMES);
    for (const row of rows()) {
      expect(row.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThanOrEqual(3);
      expect(row.querySelector(".ccc-badge")).toBeNull();
      expect(row.getAttribute("data-status")).toBeNull();
      expect(row.querySelector("time")).toBeNull();
    }
    // Nothing is claimed while the answer is on its way.
    expect(document.body.textContent).not.toContain("Needs setup");
    expect(document.body.textContent).not.toContain("Nothing is failing.");
    expect(document.body.textContent).not.toContain("Can't be checked");
  });

  it("drops aria-busy and the skeletons when the answer arrives", async () => {
    const pending = deferredResponse();
    configure(() => pending.promise);
    renderSection();
    await settle();
    expect(document.querySelector(".ccc-health")?.getAttribute("aria-busy")).toBe("true");
    pending.resolve(fixtureResponse());
    await settle();
    expect(document.querySelector(".ccc-health")?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector(".ccc-skeleton-line")).toBeNull();
    expect(document.body.textContent).not.toContain("Loading diagnostics");
  });
});

describe("Task 3, Test 2: Run checks again", () => {
  it("is busy and aria-disabled before the answer, says Checking…, ignores a second press and keeps focus", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const answers = [first, second];
    const get = configure(() => (answers.shift() as typeof first).promise);
    const { notify } = renderSection();
    first.resolve(fixtureResponse());
    await settle();
    expect(get).toHaveBeenCalledTimes(1);

    const button = runButton();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    button.focus();
    fireEvent.click(button);
    // Everything below is observable before the fetch has answered.
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("Checking…");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith("gesture");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(get).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(button);

    second.resolve(fixtureResponse());
    await settle();
    expect(notify).toHaveBeenLastCalledWith("Checked just now.");
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("ends with the timeout sentence, pluralised, when probes timed out, and counts them as unknown", async () => {
    const timedOut = fixtureResponse({
      vault: plainRow("vault", "probe-timeout", { freshness: "unavailable" }),
      hooks: plainRow("hooks", "probe-timeout", { freshness: "unavailable" }),
    });
    const get = configure();
    const { notify } = renderSection();
    await settle();
    get.mockImplementation(() => Promise.resolve(timedOut));
    fireEvent.click(runButton());
    await settle();
    expect(notify).toHaveBeenLastCalledWith(
      "Checked just now. 2 checks timed out and are shown as unknown.",
    );
    expect(chipOf(rowNamed("Vault access"))).toContain("Unknown");
    expect(
      within(rowNamed("Vault access")).getByText(
        "This check took too long, so its result is unknown.",
      ),
    ).toBeTruthy();
    expect(rowNamed("Vault access").textContent).toContain("Unavailable");
    expect(
      document.querySelector(".ccc-health-summary")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("Nothing is failing. 2 couldn't be checked. ? 2 unknown ✓ 1 working ⊕ 3 need setup");
  });

  it("reads the single-timeout sentence in the singular", async () => {
    const one = fixtureResponse({
      hooks: plainRow("hooks", "probe-timeout", { freshness: "unavailable" }),
    });
    const get = configure();
    const { notify } = renderSection();
    await settle();
    get.mockImplementation(() => Promise.resolve(one));
    fireEvent.click(runButton());
    await settle();
    expect(notify).toHaveBeenLastCalledWith(
      "Checked just now. 1 check timed out and is shown as unknown.",
    );
  });

  it("is aria-disabled with a visible reason it is described by while the service is away, and does nothing", async () => {
    const get = configure();
    renderSection({ connection: { kind: "disconnected", reason: "x" } });
    await settle();
    const button = runButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId as string)?.textContent).toBe(
      "The companion service isn't running.",
    );
    fireEvent.click(button);
    await settle();
    expect(get).not.toHaveBeenCalled();
  });

  it("has an accessible name that begins with its visible label", async () => {
    configure();
    renderSection();
    await settle();
    expect(runButton().getAttribute("aria-label")).toBe(
      "Run checks again: re-run the read-only checks",
    );
    expect(runButton().textContent).toBe("Run checks again");
  });
});

describe("Task 3, Test 3: a failed fetch", () => {
  it("shows the error and its follow-up sentence, clears the rows, and keeps no last-good value", async () => {
    const get = configure();
    const { notify } = renderSection();
    await settle();
    expect(chipOf(rowNamed("Vault access"))).toContain("Needs setup");

    get.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("/Users/x/y"), { code: "timeout" })),
    );
    fireEvent.click(runButton());
    await settle();

    expect(screen.getByText("Couldn't run the checks.")).toBeTruthy();
    expect(document.querySelector(".ccc-health-error")?.textContent).toContain("▲");
    expect(
      screen.getByText(
        "The companion service didn't respond. Check that it is running, then press Run checks again.",
      ),
    ).toBeTruthy();
    expect(notify).toHaveBeenLastCalledWith("Couldn't run the checks.");
    for (const name of ROW_NAMES.slice(1)) {
      expect(chipOf(rowNamed(name))).toContain("Unknown");
    }
    expect(document.body.textContent).not.toContain("Needs setup");
    expect(document.body.textContent).not.toContain("/Users");
  });

  it("shows the error on a failed open, and no error while the answer is good", async () => {
    configure(() => Promise.reject(new Error("boom")));
    renderSection();
    await settle();
    expect(document.querySelector(".ccc-health-error")).not.toBeNull();
    expect(document.querySelector(".ccc-health")?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Task 3, Test 4: disconnection", () => {
  it("clears every service row to unknown with no last-good value when live becomes disconnected", async () => {
    configure(() =>
      Promise.resolve(allOkHealth({ hooks: plainRow("hooks", "hook-runtime-missing") })),
    );
    const view = renderSection({ host: hostWithVaultPath(null) });
    await settle();
    expect(chipOf(rowNamed("Claude Code hooks"))).toContain("Failing");

    view.rerenderWith({ kind: "disconnected", reason: PATHY });
    await settle();
    expect(chipOf(rowNamed("Companion service"))).toContain("Failing");
    for (const name of ROW_NAMES.slice(1)) {
      expect(chipOf(rowNamed(name))).toContain("Unknown");
      expect(
        within(rowNamed(name)).getByText(
          "Can't be checked while the companion service isn't running.",
        ),
      ).toBeTruthy();
      expect(rowNamed(name).textContent).not.toContain("Checked ");
      expect(rowNamed(name).textContent).toContain("Not checked");
      expect(rowNamed(name).textContent).toContain("Unavailable");
      expect(rowNamed(name).querySelector("button")).toBeNull();
    }
    expect(document.body.textContent).not.toContain("The program the hooks run with");
    expect(document.body.textContent).not.toContain("secretperson");
  });

  it("moves focus to the Diagnostics heading when the focused control disappears with its row", async () => {
    configure();
    const view = renderSection({ host: hostWith({ runVaultSetup: () => new Promise(() => {}) }) });
    await settle();
    const setup = within(rowNamed("Vault access")).getByRole("button", { name: "Set up vault" });
    setup.focus();
    expect(document.activeElement).toBe(setup);

    view.rerenderWith({ kind: "disconnected", reason: "gone" });
    await settle();
    expect(setup.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Diagnostics" }),
    );
  });

  it("leaves focus alone when it was not inside a cleared row", async () => {
    configure();
    const view = renderSection();
    await settle();
    const button = runButton();
    button.focus();
    view.rerenderWith({ kind: "disconnected", reason: "gone" });
    await settle();
    expect(document.activeElement).toBe(button);
  });
});

describe("Task 3, Test 5: stale", () => {
  const SIX_MINUTES = 6 * 60 * 1000;

  it("shows the Stale badge on every row and the stale line once checks are older than five minutes, with no fetch from the clock", async () => {
    const get = configure();
    const view = renderSection();
    await settle();
    expect(screen.queryByText(/more than 5 minutes old/)).toBeNull();
    for (const row of rows()) expect(row.textContent).toContain("Live");

    view.rerenderWith({ kind: "live" }, HEALTH_NOW + SIX_MINUTES);
    await settle();
    expect(
      screen.getByText("These checks are more than 5 minutes old. Press Run checks again."),
    ).toBeTruthy();
    for (const row of rows()) {
      expect(row.querySelector(".ccc-badge[data-badge='stale']")?.textContent).toContain("Stale");
      expect(row.querySelector(".ccc-badge[data-badge='live']")).toBeNull();
    }
    // Many ticks later, still exactly the one fetch made when the section opened.
    view.rerenderWith({ kind: "live" }, HEALTH_NOW + 3 * SIX_MINUTES);
    view.rerenderWith({ kind: "live" }, HEALTH_NOW + 9 * SIX_MINUTES);
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not mark a cleared row stale: nothing was checked", async () => {
    configure();
    renderSection({
      connection: { kind: "disconnected", reason: "x" },
      now: HEALTH_NOW + SIX_MINUTES,
    });
    await settle();
    expect(screen.queryByText(/more than 5 minutes old/)).toBeNull();
    expect(document.querySelector(".ccc-badge[data-badge='stale']")).toBeNull();
  });
});

describe("Task 3, Test 6: headings, focus and keyboard", () => {
  it("is h2 Settings, h3 Diagnostics, h4 Subsystems and Not part of this version, h5 row names", async () => {
    configure();
    requestSettingsSection("diagnostics");
    render(<Shell initialDestination="settings" />);
    await settle();
    const outline = [
      ...document.querySelectorAll<HTMLElement>(
        ".ccc-settings h2, .ccc-settings h3, .ccc-settings h4, .ccc-settings h5",
      ),
    ].map((heading) => `${heading.tagName.toLowerCase()} ${heading.textContent}`);
    expect(outline).toEqual([
      "h2 Settings",
      "h3 Diagnostics",
      "h4 Subsystems",
      ...ROW_NAMES.map((name) => `h5 ${name}`),
      "h4 Not part of this version",
      "h5 Gmail",
      "h5 Google Calendar",
      "h5 GitHub",
    ]);
    const h3 = screen.getByRole("heading", { level: 3, name: "Diagnostics" });
    expect(h3.className).toContain("ccc-settings-section-title");
    expect(h3.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("heading", { level: 4, name: "Subsystems" }).className).toContain(
      "ccc-settings-group-title",
    );
    for (const heading of document.querySelectorAll("h5")) {
      expect(heading.className).toContain("ccc-settings-item-title");
    }
  });

  it("has exactly one live region in the whole destination and none of its own in the section", async () => {
    configure();
    requestSettingsSection("diagnostics");
    render(<Shell initialDestination="settings" />);
    await settle();
    expect(
      document.querySelectorAll(
        '.ccc-settings [role="status"], .ccc-settings [aria-live]:not([aria-live="off"]), .ccc-settings [role="alert"]',
      ),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(
        ".ccc-settings-content [role='status'], .ccc-settings-content [aria-live]",
      ),
    ).toHaveLength(0);
  });

  it("tab order follows the keyboard contract: the toolbar button, then each row's action and details toggle; never native disabled, never a positive tabindex", async () => {
    configure();
    renderSection();
    await settle();
    const stops = [
      ...document.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ]
      .filter((element) => element.closest("[hidden]") === null)
      .filter((element) => element.getAttribute("tabindex") !== "-1");
    expect(stops.every((stop) => !stop.hasAttribute("disabled"))).toBe(true);
    expect(stops.every((stop) => Number(stop.getAttribute("tabindex") ?? "0") <= 0)).toBe(true);
    const names = stops.map((stop) =>
      (stop.getAttribute("aria-label") ?? stop.textContent ?? "").trim(),
    );
    expect(names).toEqual([
      "Run checks again: re-run the read-only checks",
      // Vault access
      "Set up vault",
      // Claude Code hooks
      "Copy install command",
      // Usage collectors: the deciding part's action, then the toggle
      "Copy install command",
      "Show details for Usage collectors: 8 parts",
      // Scheduler
      "Open the research view",
      "Show details for Scheduler: 3 parts",
      // App launchers
      "Go to the launchers section",
      "Show details for App launchers: 4 parts",
    ]);
    // Every one of them takes the shared button class, and with it the 2px focus ring rule.
    for (const stop of stops) expect(stop.className).toContain("ccc-connect-button");
  });

  it("opening the details adds each part's own action to the tab order, after the toggle", async () => {
    configure();
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    fireEvent.click(within(row).getByRole("button", { name: /^Show details/ }));
    const names = [...row.querySelectorAll<HTMLElement>("button")]
      .filter((element) => element.closest("[hidden]") === null)
      .map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim());
    expect(names).toEqual([
      "Copy install command",
      "Hide details for Usage collectors: 8 parts",
      "Go to the security section",
      "Copy install command",
      "Copy install command",
      "Go to the launchers section",
    ]);
  });

  it("never uses a native disabled attribute anywhere in the section", async () => {
    configure(() => Promise.reject(new Error("x")));
    renderSection();
    await settle();
    expect(document.querySelector("[disabled]")).toBeNull();
  });
});

describe("Task 3: the stylesheet carries every class the section emits", () => {
  const STYLESHEET = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
    "utf8",
  );

  it.each([
    ".ccc-health-toolbar",
    ".ccc-health-detail",
    ".ccc-health-meta",
    ".ccc-health-error",
    ".ccc-health-part-head",
    ".ccc-health-part-name",
  ])("has a rule for %s", (selector) => {
    expect(STYLESHEET).toContain(`.ccc-command-center ${selector}`);
  });
});

describe("Task 2 (adjustment): the Codex doctor action lands where Check Codex health lives", () => {
  it("go-to-section integrations on a Codex doctor part opens the launchers section", async () => {
    configure();
    renderSection();
    await settle();
    const row = rowNamed("Usage collectors");
    fireEvent.click(within(row).getByRole("button", { name: /^Show details/ }));
    const doctor = row.querySelector<HTMLElement>("[data-part='codex-doctor']");
    expect(doctor?.textContent).toContain("Check Codex health in the launchers section.");
    fireEvent.click(
      within(doctor as HTMLElement).getByRole("button", { name: "Go to the launchers section" }),
    );
    expect(settingsSectionRequested.value).toBe("launchers");
  });
});

describe("the closed reason code is on the DOM for the runner (plan 08-20 drills)", () => {
  it("puts each row's and part's reason code, and nothing else of the answer, in data-reason", async () => {
    configure();
    renderSection();
    await settle();
    expect(rows().map((row) => row.getAttribute("data-reason"))).toEqual([
      "service-live",
      "vault-not-set-up",
      "hooks-not-installed",
      "statusline-not-installed",
      "never-run",
      "launcher-not-set-up",
    ]);
    const parts = [...rowNamed("Usage collectors").querySelectorAll("[data-part]")];
    expect(parts.map((part) => part.getAttribute("data-reason"))).toEqual([
      "telemetry-ok",
      "statusline-not-installed",
      "analysis-off",
      "spool-clean",
      "codex-not-installed",
      "codex-hooks-not-installed",
      "codex-bridge-not-installed",
      "codex-doctor-not-run",
    ]);
  });

  it("reads service-not-running on every cleared row", async () => {
    configure();
    renderSection({ connection: { kind: "disconnected", reason: "x" } });
    await settle();
    expect(rows().map((row) => row.getAttribute("data-reason"))).toEqual([
      "service-unreachable",
      "service-not-running",
      "service-not-running",
      "service-not-running",
      "service-not-running",
      "service-not-running",
    ]);
  });
});
