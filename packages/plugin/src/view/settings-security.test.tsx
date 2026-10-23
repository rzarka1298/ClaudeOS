import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeIntegrationStatus } from "@ccc/domain";
import type { DiagnosticsHealthResponse } from "@ccc/domain/diagnostics.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { configureHealth } from "../health/api.js";
import { healthViewMounted, onHealthLive, resetHealthState } from "../health/state.js";
import { HEALTH_NOW, HEALTH_T0, healthResponse } from "../test-support/health-fixtures.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import { resetPendingActions } from "./settings-pending.js";
import { takeSettingsSectionRequest } from "./settings-sections.js";
import { keychainChipFor, SecuritySection } from "./settings-security.js";

/**
 * The Security section (plan 08-15 Task 2; 08-UI-SPEC S2 Security, R-F5, D-17, OD-4, APPR-05):
 * read-only facts, Keychain presence chips that never claim `Present` without the service saying
 * so, the Transcript analysis switch and Delete cached usage analytics. No control stores,
 * rotates or deletes a credential. Every locked string is asserted literally.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_AWAY = "The companion service isn't running.";
const FAILED_TEXT = "Couldn't run the checks.";
const UNCHECKED_TEXT = "The keychain couldn't be checked.";
const KEY_COMMAND = "node scripts/research-key-setup.mjs";

const CLAUDE_STATUS: ClaudeIntegrationStatus = {
  hooks: "not-installed",
  hookRuntimeMissing: false,
  disableAllHooks: null,
  lastEventAt: null,
  telemetry: { kind: "ok" },
  detectedClaudeVersion: null,
  statusLine: "not-installed",
  statusLineReported: false,
  transcriptAnalysis: { enabled: false },
  spoolDropCount: 0,
  unknownEventCount: 0,
  cleanupPeriodDays: 30,
};

type Presence = "present" | "absent" | "unknown";

function responseWith(installSecret: Presence, researchKey: Presence): DiagnosticsHealthResponse {
  return { ...healthResponse(), keychain: { installSecret, researchKey } };
}

interface Fixture {
  readonly host: SettingsHost;
  readonly notify: Mock<(message: string) => void>;
  readonly copyText: Mock<(text: string) => Promise<void>>;
  readonly setTranscript: Mock<(enabled: boolean) => Promise<{ enabled: boolean }>>;
  readonly deleteUsage: Mock<() => Promise<void>>;
  readonly openModal: Mock<(horizon: string | null, analysisOn: boolean) => Promise<boolean>>;
  readonly saveSettings: Mock<() => Promise<void>>;
  readonly writes: string[];
}

function fixture(
  options: {
    setTranscript?: (enabled: boolean) => Promise<{ enabled: boolean }>;
    deleteUsage?: () => Promise<void>;
    confirm?: boolean;
  } = {},
): Fixture {
  const writes: string[] = [];
  const copyText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  const setTranscript = vi.fn<(enabled: boolean) => Promise<{ enabled: boolean }>>(
    options.setTranscript ?? ((enabled) => Promise.resolve({ enabled })),
  );
  const deleteUsage = vi.fn<() => Promise<void>>(options.deleteUsage ?? (() => Promise.resolve()));
  const openModal = vi.fn<(horizon: string | null, analysisOn: boolean) => Promise<boolean>>(() =>
    Promise.resolve(options.confirm ?? true),
  );
  const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const base = createInertSettingsHost();
  const host: SettingsHost = {
    ...base,
    copyText,
    saveSettings,
    openDeleteUsageModal: openModal,
    claude: {
      getIntegration: () => new Promise<ClaudeIntegrationStatus>(() => {}),
      setTranscriptAnalysis: setTranscript,
      deleteUsageAnalytics: deleteUsage,
      copyText: () => {
        writes.push("claude.copyText");
        return Promise.resolve();
      },
    },
    runVaultSetup: () => {
      writes.push("runVaultSetup");
      return Promise.resolve();
    },
    display: { ...base.display, vaultBasePath: null },
  };
  return {
    host,
    notify: vi.fn<(message: string) => void>(),
    copyText,
    setTranscript,
    deleteUsage,
    openModal,
    saveSettings,
    writes,
  };
}

function renderSecurity(f: Fixture, options: { connection?: ConnectionState; now?: number } = {}) {
  return render(
    <SecuritySection
      host={f.host}
      connection={options.connection ?? { kind: "live" }}
      now={options.now ?? HEALTH_NOW}
      notify={f.notify}
    />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** Serves `response` to the health route and returns the spy. */
function serve(response: DiagnosticsHealthResponse | Error | "never") {
  const get = vi.fn((_trigger: string): Promise<DiagnosticsHealthResponse> => {
    if (response === "never") return new Promise<DiagnosticsHealthResponse>(() => {});
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  configureHealth({ api: { get } });
  return get;
}

function row(name: string): HTMLElement {
  const dt = screen.getByText(name, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (dd === null) throw new Error(`no dd for ${name}`);
  return dd as HTMLElement;
}

function chipOf(name: string): HTMLElement | null {
  return row(name).querySelector(".ccc-badge[data-status]");
}

beforeEach(() => {
  resetHealthState();
  resetPendingActions();
  configureHealth(null);
  claudeIntegration.value = null;
  takeSettingsSectionRequest();
});

afterEach(() => {
  cleanup();
  resetHealthState();
  configureHealth(null);
  claudeIntegration.value = null;
  takeSettingsSectionRequest();
});

describe("Task 2, Test 1: the facts", () => {
  it("reads the socket, network, token and always-allow sentences, with the token life derived from the domain", async () => {
    serve(responseWith("present", "present"));
    const f = fixture();
    renderSecurity(f);
    await flush();

    expect(screen.getByRole("heading", { level: 3, name: "Security" }).className).toBe(
      "ccc-settings-section-title",
    );
    expect(
      screen.getByText(
        "What protects the command center, and what it stores. Nothing here changes a credential.",
      ),
    ).toBeTruthy();
    expect(row("Service connection").textContent).toBe(
      "A local socket that only you can read (mode 0600).",
    );
    expect(row("Network listener").textContent).toBe(
      "None. The companion service doesn't listen on any network port.",
    );
    expect(row("Connection tokens").textContent).toBe(
      "Each lasts 1 hour. The plugin asks for a new one when it expires.",
    );
    expect(row("Always allow").textContent).toBe(
      "No always-allow control exists. Every consequential action asks you each time.",
    );
    expect(row("Install secret in keychain").textContent).toContain(
      "Stored in the macOS keychain. Only its presence is shown, never its value.",
    );
    expect(row("Research key in keychain").textContent).toContain(
      "Only its presence is shown, never its value.",
    );
  });

  it("takes the token life from TOKEN_TTL_MS, not from a second constant", () => {
    const source = readFileSync(join(HERE, "settings-security.tsx"), "utf8");
    expect(source).toContain("TOKEN_TTL_MS");
    expect(source).not.toMatch(/60\s*\*\s*60\s*\*\s*1000|3_?600_?000/);
  });
});

describe("Task 2, Test 2: the keychain chips", () => {
  it("maps each presence to its word, kind and glyph", () => {
    expect(keychainChipFor("installSecret", "present")).toMatchObject({
      status: "ok",
      word: "Present",
      glyph: "✓",
    });
    expect(keychainChipFor("researchKey", "present")).toMatchObject({
      status: "ok",
      word: "Present",
    });
    expect(keychainChipFor("researchKey", "absent")).toMatchObject({
      status: "setup-needed",
      word: "Needs setup",
      glyph: "⊕",
    });
    expect(keychainChipFor("installSecret", "absent")).toMatchObject({
      status: "failing",
      word: "Missing",
      glyph: "✕",
    });
    for (const kind of ["installSecret", "researchKey"] as const) {
      expect(keychainChipFor(kind, "unknown")).toMatchObject({
        status: "unknown",
        word: "Unknown",
        glyph: "?",
      });
      expect(keychainChipFor(kind, null)).toMatchObject({ status: "unknown", word: "Unknown" });
    }
  });

  it("present reads Present for both, with the service's own answer", async () => {
    serve(responseWith("present", "present"));
    renderSecurity(fixture());
    await flush();
    for (const name of ["Install secret in keychain", "Research key in keychain"]) {
      const chip = chipOf(name) as HTMLElement;
      expect(chip.getAttribute("data-status")).toBe("ok");
      expect(chip.textContent).toContain("Present");
    }
  });

  it("an absent research key reads Needs setup and an absent install secret reads Missing", async () => {
    serve(responseWith("absent", "absent"));
    renderSecurity(fixture());
    await flush();
    const research = chipOf("Research key in keychain") as HTMLElement;
    expect(research.getAttribute("data-status")).toBe("setup-needed");
    expect(research.textContent).toContain("Needs setup");
    const install = chipOf("Install secret in keychain") as HTMLElement;
    expect(install.getAttribute("data-status")).toBe("failing");
    expect(install.textContent).toContain("Missing");
    expect(install.querySelector(".ccc-badge-glyph")?.textContent).toBe("✕");
    expect(install.querySelector(".ccc-badge-glyph")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("one value known and the other unknown render independently", async () => {
    serve(responseWith("present", "unknown"));
    renderSecurity(fixture());
    await flush();
    expect(chipOf("Install secret in keychain")?.textContent).toContain("Present");
    const research = chipOf("Research key in keychain") as HTMLElement;
    expect(research.getAttribute("data-status")).toBe("unknown");
    expect(research.textContent).toContain("Unknown");
    expect(row("Research key in keychain").textContent).toContain(UNCHECKED_TEXT);
    expect(row("Install secret in keychain").textContent).not.toContain(UNCHECKED_TEXT);
  });

  it("with the service away both read Unknown with the reason, even if an answer is still held", async () => {
    serve(responseWith("present", "present"));
    const f = fixture();
    // The held answer outlives the section here on purpose: the connection is what decides.
    const { rerender } = renderSecurity(f);
    await flush();
    rerender(
      <SecuritySection
        host={f.host}
        connection={{ kind: "disconnected", reason: "ECONNREFUSED /Users/someone/x.sock" }}
        now={HEALTH_NOW}
        notify={f.notify}
      />,
    );
    for (const name of ["Install secret in keychain", "Research key in keychain"]) {
      expect(chipOf(name)?.getAttribute("data-status")).toBe("unknown");
      expect(row(name).textContent).toContain(SERVICE_AWAY);
      expect(row(name).textContent).not.toContain("Present");
    }
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("opened with the service away it never asks and reads Unknown", () => {
    const get = serve(responseWith("present", "present"));
    renderSecurity(fixture(), { connection: { kind: "disconnected", reason: "x" } });
    expect(get).not.toHaveBeenCalled();
    expect(chipOf("Install secret in keychain")?.textContent).toContain("Unknown");
  });

  it("a failed check reads Unknown with the failure line, never Present", async () => {
    serve(new Error("boom"));
    renderSecurity(fixture());
    await flush();
    for (const name of ["Install secret in keychain", "Research key in keychain"]) {
      expect(chipOf(name)?.getAttribute("data-status")).toBe("unknown");
      expect(row(name).textContent).toContain(FAILED_TEXT);
      expect(row(name).textContent).not.toContain("Present");
    }
  });

  it("shows skeletons, no chip and no claim, until the first answer lands", () => {
    serve("never");
    const { container } = renderSecurity(fixture());
    expect(chipOf("Install secret in keychain")).toBeNull();
    expect(chipOf("Research key in keychain")).toBeNull();
    expect(container.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThanOrEqual(2);
    expect(row("Install secret in keychain").textContent).not.toContain("Present");
  });

  it("an answer older than five minutes shows the Stale badge on both chips; a fresh one does not", async () => {
    serve(responseWith("present", "absent"));
    const f = fixture();
    const { rerender } = renderSecurity(f);
    await flush();
    expect(document.querySelectorAll('.ccc-badge[data-badge="stale"]')).toHaveLength(0);
    rerender(
      <SecuritySection
        host={f.host}
        connection={{ kind: "live" }}
        now={Date.parse(HEALTH_T0) + 6 * 60_000}
        notify={f.notify}
      />,
    );
    for (const name of ["Install secret in keychain", "Research key in keychain"]) {
      expect(row(name).querySelector('.ccc-badge[data-badge="stale"]')?.textContent).toContain(
        "Stale",
      );
    }
  });

  it("offers the owner-run key setup command as copyable text when the key is not present, and copies it", async () => {
    serve(responseWith("present", "absent"));
    const f = fixture();
    renderSecurity(f);
    await flush();
    expect(within(row("Research key in keychain")).getByText(KEY_COMMAND).tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Copy key setup command" }));
    await flush();
    expect(f.copyText).toHaveBeenCalledWith(KEY_COMMAND);
    expect(f.notify).toHaveBeenCalledWith("Key setup command copied. Run it in Terminal.");
    expect(f.writes).toEqual([]);
  });

  it("a refused clipboard write says so", async () => {
    serve(responseWith("present", "absent"));
    const f = fixture();
    f.copyText.mockImplementation(() => Promise.reject(new Error("blocked")));
    renderSecurity(f);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy key setup command" }));
    await flush();
    expect(f.notify).toHaveBeenCalledWith(
      "Couldn't copy the command. It's shown on this row; copy it from there.",
    );
  });

  it("offers no setup command when the research key is present", async () => {
    serve(responseWith("present", "present"));
    renderSecurity(fixture());
    await flush();
    expect(screen.queryByRole("button", { name: "Copy key setup command" })).toBeNull();
    expect(screen.queryByText(KEY_COMMAND)).toBeNull();
  });
});

describe("Task 2, Test 3: opening Security uses the Diagnostics health refresh", () => {
  it("fetches once on open with the gesture trigger and registers as a health view", async () => {
    const get = serve(responseWith("present", "present"));
    const { unmount } = renderSecurity(fixture());
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("gesture");
    expect(healthViewMounted()).toBe(true);
    // A reconnect while the section is open refreshes it through the shared hook, never as a gesture.
    await act(async () => {
      onHealthLive();
    });
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith("reconnect");
    unmount();
    expect(healthViewMounted()).toBe(false);
  });

  it("starts no timer and re-renders without another fetch", async () => {
    const get = serve(responseWith("present", "present"));
    const f = fixture();
    const { rerender } = renderSecurity(f);
    await flush();
    rerender(
      <SecuritySection
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW + 120_000}
        notify={f.notify}
      />,
    );
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("Task 2, Test 4: the two privacy controls", () => {
  it("the Transcript analysis switch saves through the claude seam and keeps nothing in the plugin settings", async () => {
    serve(responseWith("present", "present"));
    claudeIntegration.value = CLAUDE_STATUS;
    const f = fixture();
    renderSecurity(f);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Transcript analysis" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await flush();
    expect(f.setTranscript).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(f.saveSettings).not.toHaveBeenCalled();
    expect(Object.keys(f.host.settings)).not.toContain("transcriptAnalysis");
  });

  it("a failed save reverts the switch and posts the moved failure string", async () => {
    serve(responseWith("present", "present"));
    claudeIntegration.value = CLAUDE_STATUS;
    const f = fixture({ setTranscript: () => Promise.reject(new Error("no")) });
    renderSecurity(f);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Transcript analysis" });
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(f.notify).toHaveBeenCalledWith(
      "Couldn't change transcript analysis. The companion service didn't respond.",
    );
  });

  it("is aria-disabled with a visible reason while the service is away, and a press does nothing", async () => {
    claudeIntegration.value = CLAUDE_STATUS;
    const f = fixture();
    renderSecurity(f, { connection: { kind: "disconnected", reason: "x" } });
    const toggle = screen.getByRole("switch", { name: "Transcript analysis" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    const described = (toggle.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described).toContain(SERVICE_AWAY);
    fireEvent.click(toggle);
    await flush();
    expect(f.setTranscript).not.toHaveBeenCalled();
  });

  it("turning analysis off notes that the existing totals stay until they are deleted", async () => {
    serve(responseWith("present", "present"));
    claudeIntegration.value = { ...CLAUDE_STATUS, transcriptAnalysis: { enabled: true } };
    const f = fixture();
    renderSecurity(f);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Transcript analysis" }));
    await flush();
    expect(
      within(screen.getByRole("group", { name: "Delete cached usage analytics" })).getByText(
        /Existing totals are kept until you delete them\./,
      ),
    ).toBeTruthy();
  });

  it("Delete cached usage analytics opens the existing modal and deletes only on confirm", async () => {
    serve(responseWith("present", "present"));
    claudeIntegration.value = { ...CLAUDE_STATUS, transcriptAnalysis: { enabled: true } };
    const f = fixture({ confirm: false });
    renderSecurity(f);
    await flush();
    const button = screen.getByRole("button", { name: "Delete cached usage analytics" });
    fireEvent.click(button);
    await flush();
    const expectedHorizon = new Date(HEALTH_NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(f.openModal).toHaveBeenCalledWith(expectedHorizon, true);
    expect(f.deleteUsage).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();

    f.openModal.mockImplementation(() => Promise.resolve(true));
    fireEvent.click(button);
    await flush();
    expect(f.deleteUsage).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenLastCalledWith("Cached usage analytics deleted.");
    expect(
      within(screen.getByRole("group", { name: "Delete cached usage analytics" })).getByText(
        "Cached usage analytics deleted.",
      ),
    ).toBeTruthy();
  });

  it("a failed delete says so and an unknown status gives the modal no horizon date", async () => {
    serve(responseWith("present", "present"));
    const f = fixture({ deleteUsage: () => Promise.reject(new Error("no")) });
    renderSecurity(f);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Delete cached usage analytics" }));
    await flush();
    expect(f.openModal).toHaveBeenCalledWith(null, false);
    expect(f.notify).toHaveBeenLastCalledWith(
      "Couldn't delete cached usage analytics. Check the service in Settings → Diagnostics, then try again.",
    );
  });

  it("delete is aria-disabled with the reason while the service is away and never opens the modal", async () => {
    const f = fixture();
    renderSecurity(f, { connection: { kind: "disconnected", reason: "x" } });
    const button = screen.getByRole("button", { name: "Delete cached usage analytics" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await flush();
    expect(f.openModal).not.toHaveBeenCalled();
  });

  it("a second press while the modal is open is ignored", async () => {
    serve(responseWith("present", "present"));
    claudeIntegration.value = CLAUDE_STATUS;
    const f = fixture();
    let resolveModal!: (confirmed: boolean) => void;
    f.openModal.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveModal = resolve;
        }),
    );
    renderSecurity(f);
    await flush();
    const button = screen.getByRole("button", { name: "Delete cached usage analytics" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.openModal).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolveModal(false);
      await Promise.resolve();
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Task 2, Test 5: no credential control, and the pointer to approvals and tasks", () => {
  it("has only the closed set of controls, none of which stores, rotates or deletes a credential", async () => {
    serve(responseWith("absent", "absent"));
    claudeIntegration.value = CLAUDE_STATUS;
    const f = fixture();
    renderSecurity(f);
    await flush();
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    const allowed = [
      "Copy key setup command",
      "Delete cached usage analytics",
      "Go to the approvals and tasks section",
    ];
    for (const name of names) {
      if (name === null || name === "On" || name === "Off") continue;
      expect(allowed, `unexpected control: ${name}`).toContain(name);
    }
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /store|rotate|reset|sign in|always allow/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /always|allow|credential|key|secret/i }),
    ).toBeNull();
    expect(f.writes).toEqual([]);
  });

  it("points to the approvals and tasks section with a link that navigates only", async () => {
    serve(responseWith("present", "present"));
    renderSecurity(fixture());
    await flush();
    expect(
      screen.getByText("Approval notifications are in the approvals and tasks section."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to the approvals and tasks section" }));
    expect(takeSettingsSectionRequest()).toBe("approvals-tasks");
    expect(screen.queryByRole("switch", { name: "Approval notifications" })).toBeNull();
  });

  it("is a registered section view for the security id", async () => {
    const { SECTION_VIEWS } = await import("./settings-destination.js");
    expect(SECTION_VIEWS.security).toBeDefined();
  });
});
