import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeIntegrationStatus } from "@ccc/domain";
import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { adoptCodexSnapshot } from "../widgets/codex-events.js";
import { codexIntegration } from "../widgets/codex-signals.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import { IntegrationsSection } from "./settings-integrations.js";
import {
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_NAME,
  CLAUDE_HOOKS_NAME,
  CLAUDE_STATUSLINE_NAME,
} from "./settings-model.js";
import { resetPendingActions } from "./settings-pending.js";
import { takeSettingsSectionRequest } from "./settings-sections.js";

/**
 * The Integrations section (plan 08-15 Task 1; 08-UI-SPEC S2 Integrations, D-15, D-44, OD-2):
 * Claude Code, Codex and Accounts. Every locked string is asserted literally. The section only
 * ever copies a command; nothing installs, writes or connects.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const AWAY_TEXT = "Status unavailable — the companion service isn't running.";

const CLAUDE_NOT_INSTALLED: ClaudeIntegrationStatus = {
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

const CODEX_STATUS: CodexIntegrationStatus = {
  hooks: { state: "not-installed", lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed", lastWindowAt: null },
  codex: { installed: true, version: "0.159.2" },
  doctor: null,
};

interface Fixture {
  readonly host: SettingsHost;
  readonly copyText: ReturnType<typeof vi.fn>;
  readonly getClaude: ReturnType<typeof vi.fn>;
  readonly getCodex: ReturnType<typeof vi.fn>;
  readonly notify: Mock<(message: string) => void>;
  readonly session: ReturnType<typeof createLaunchersSession>;
  /** Every call that would install, write or connect: must stay empty. */
  readonly writes: string[];
}

function fixture(
  options: {
    claude?: () => Promise<ClaudeIntegrationStatus>;
    codex?: () => Promise<CodexIntegrationStatus>;
    copy?: () => Promise<void>;
  } = {},
): Fixture {
  const writes: string[] = [];
  const copyText = vi.fn(options.copy ?? (() => Promise.resolve()));
  const getClaude = vi.fn(options.claude ?? (() => new Promise<ClaudeIntegrationStatus>(() => {})));
  const getCodex = vi.fn(options.codex ?? (() => new Promise<CodexIntegrationStatus>(() => {})));
  const base = createInertSettingsHost();
  const host: SettingsHost = {
    ...base,
    copyText,
    claude: {
      getIntegration: getClaude,
      setTranscriptAnalysis: () => {
        writes.push("setTranscriptAnalysis");
        return Promise.reject(new Error("no"));
      },
      deleteUsageAnalytics: () => {
        writes.push("deleteUsageAnalytics");
        return Promise.reject(new Error("no"));
      },
      copyText: () => {
        writes.push("claude.copyText");
        return Promise.resolve();
      },
    },
    codex: {
      getIntegration: getCodex,
      copyText: () => {
        writes.push("codex.copyText");
        return Promise.resolve();
      },
    },
    runVaultSetup: () => {
      writes.push("runVaultSetup");
      return Promise.resolve();
    },
  };
  return {
    host,
    copyText,
    getClaude,
    getCodex,
    notify: vi.fn<(message: string) => void>(),
    session: createLaunchersSession(),
    writes,
  };
}

function renderSection(f: Fixture, connection: ConnectionState = { kind: "live" }) {
  return render(
    <IntegrationsSection
      host={f.host}
      connection={connection}
      now={NOW}
      notify={f.notify}
      launchersSession={f.session}
    />,
  );
}

function group(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  claudeIntegration.value = null;
  codexIntegration.value = null;
  resetPendingActions();
  takeSettingsSectionRequest();
});

afterEach(() => {
  cleanup();
  claudeIntegration.value = null;
  codexIntegration.value = null;
  takeSettingsSectionRequest();
});

describe("Task 1, Test 1 (tracer): Claude Code hook status and the copied install command", () => {
  it("shows the moved hook status and copies the exact command, posting the moved notice", async () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture();
    renderSection(f);

    expect(screen.getByRole("heading", { level: 3, name: "Integrations" }).className).toBe(
      "ccc-settings-section-title",
    );
    expect(
      screen.getByText(
        "Claude Code and Codex hooks, the status-line wrapper and the Codex bridge. The app never installs anything: it shows status and copies the command for you to run.",
      ),
    ).toBeTruthy();
    expect(
      within(group("Claude Code hooks")).getByText(
        "Not installed. Session tracking and waiting-for-approval states need them.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      within(group("Copy install command")).getByRole("button", { name: "Copy install command" }),
    );
    await flush();
    expect(f.copyText).toHaveBeenCalledTimes(1);
    expect(f.copyText).toHaveBeenCalledWith("./scripts/claude-hooks/install.sh");
    expect(f.notify).toHaveBeenCalledWith("Install command copied. Run it in Terminal.");

    fireEvent.click(screen.getByRole("button", { name: "Copy uninstall command" }));
    await flush();
    expect(f.copyText).toHaveBeenLastCalledWith("./scripts/claude-hooks/uninstall.sh");
    expect(f.notify).toHaveBeenLastCalledWith("Uninstall command copied. Run it in Terminal.");
    expect(f.writes).toEqual([]);
  });

  it("shows the commands as mono text that wraps", () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture();
    const { container } = renderSection(f);
    const commands = [...container.querySelectorAll("code.ccc-mono")].map((el) => el.textContent);
    expect(commands).toContain("./scripts/claude-hooks/install.sh");
    expect(commands).toContain("./scripts/claude-hooks/uninstall.sh");
    expect(commands).toContain("./scripts/codex-hooks/install.sh");
    expect(commands).toContain("node scripts/codex/install-user-kit.mjs");
  });

  it("a refused clipboard write says so and does not claim a copy", async () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture({ copy: () => Promise.reject(new Error("blocked")) });
    renderSection(f);
    fireEvent.click(screen.getByRole("button", { name: "Copy install command" }));
    await flush();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith(
      "Couldn't copy the command. It's shown in the setting's description; copy it from there.",
    );
  });

  it("a second press while the clipboard write is pending is ignored", async () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    let release!: () => void;
    const f = fixture({
      copy: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    renderSection(f);
    const button = screen.getByRole("button", { name: "Copy install command" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.copyText).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Task 1, Test 2: the live signal wins, the seam is the fallback, the service can be away", () => {
  it("with the signal null the seam is read once and its answer is shown", async () => {
    const f = fixture({
      claude: () => Promise.resolve(CLAUDE_NOT_INSTALLED),
      codex: () => Promise.resolve(CODEX_STATUS),
    });
    renderSection(f);
    await flush();
    expect(f.getClaude).toHaveBeenCalledTimes(1);
    expect(f.getCodex).toHaveBeenCalledTimes(1);
    expect(
      within(group("Claude Code hooks")).getByText(
        "Not installed. Session tracking and waiting-for-approval states need them.",
      ),
    ).toBeTruthy();
  });

  it("with the signal set the seam is not read, and a pushed signal replaces the text", async () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    codexIntegration.value = CODEX_STATUS;
    const f = fixture();
    renderSection(f);
    await flush();
    expect(f.getClaude).not.toHaveBeenCalled();
    expect(f.getCodex).not.toHaveBeenCalled();
    await act(async () => {
      claudeIntegration.value = {
        ...CLAUDE_NOT_INSTALLED,
        hooks: "installed",
        lastEventAt: "2026-10-22T09:58:00.000Z",
      };
    });
    expect(
      within(group("Claude Code hooks")).getByText("Installed. Last event 2 minutes ago."),
    ).toBeTruthy();
  });

  it("while the first answer is awaited the status rows are skeletons and the copy buttons stay enabled", () => {
    const f = fixture();
    const { container } = renderSection(f);
    expect(within(group("Claude Code hooks")).getByText("Checking…").className).toContain(
      "ccc-visually-hidden",
    );
    expect(container.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThanOrEqual(4);
    for (const name of [
      "Copy install command",
      "Copy uninstall command",
      "Copy install command for the Codex hooks",
      "Copy uninstall command for the Codex hooks",
      "Copy install command for the Codex bridge",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBeNull();
    }
  });

  it("with the service away every status row reads the moved unavailable string and copying still works", async () => {
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    codexIntegration.value = CODEX_STATUS;
    const f = fixture();
    renderSection(f, { kind: "disconnected", reason: "ECONNREFUSED /Users/username/x" });
    await flush();
    for (const name of [
      "Claude Code hooks",
      "Status-line wrapper",
      "Codex hooks",
      "Antigravity terminal bridge",
    ]) {
      expect(within(group(name)).getByText(AWAY_TEXT)).toBeTruthy();
    }
    expect(f.getClaude).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    const copy = screen.getByRole("button", { name: "Copy install command" });
    expect(copy.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(copy);
    await flush();
    expect(f.copyText).toHaveBeenCalledWith("./scripts/claude-hooks/install.sh");
  });

  it("a rejected seam settles on the moved unavailable string, never on Checking forever", async () => {
    const f = fixture({
      claude: () => Promise.reject(new Error("boom")),
      codex: () => Promise.reject(new Error("boom")),
    });
    renderSection(f);
    await flush();
    expect(within(group("Claude Code hooks")).getByText(AWAY_TEXT)).toBeTruthy();
    expect(
      within(group("Codex hooks")).getByText(
        "Status unavailable — the companion service didn't respond.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Checking…")).toBeNull();
  });

  it("the silence threshold is the domain's: ten minutes of silence reads the moved silent sentence", () => {
    claudeIntegration.value = {
      ...CLAUDE_NOT_INSTALLED,
      hooks: "installed",
      lastEventAt: "2026-10-22T09:49:00.000Z",
    };
    renderSection(fixture());
    expect(
      within(group("Claude Code hooks")).getByText(/^Installed, but no events have arrived since /),
    ).toBeTruthy();
  });
});

describe("Task 1, Test 3: the Codex group", () => {
  it("shows hook and bridge status from the live signal and copies the two install steps", async () => {
    codexIntegration.value = {
      ...CODEX_STATUS,
      hooks: { state: "installed", lastEventAt: "2026-10-22T09:55:00.000Z", installedSince: null },
      bridge: { state: "outdated", lastWindowAt: null },
    };
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture();
    renderSection(f);
    expect(
      within(group("Codex hooks")).getByText("Installed. Last event 5 minutes ago."),
    ).toBeTruthy();
    expect(
      within(group("Antigravity terminal bridge")).getByText(
        "Out of date. Run its install step again.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy install command for the Codex hooks" }),
    );
    await flush();
    expect(f.copyText).toHaveBeenLastCalledWith("./scripts/codex-hooks/install.sh");
    expect(f.notify).toHaveBeenLastCalledWith("Install step copied. Run it in Terminal.");

    fireEvent.click(
      screen.getByRole("button", { name: "Copy install command for the Codex bridge" }),
    );
    await flush();
    expect(f.copyText).toHaveBeenLastCalledWith("node scripts/codex/install-user-kit.mjs");
    expect(f.writes).toEqual([]);
  });

  it("shows the notify note and the Codex health result read-only, with Check Codex health left to Launchers", () => {
    codexIntegration.value = CODEX_STATUS;
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture();
    f.session.codexDoctor.value = { kind: "problem", ids: ["config"] };
    renderSection(f);
    expect(
      within(group("Codex notify setting")).getByText(
        "Left untouched. This app never takes over Codex's notify setting.",
      ),
    ).toBeTruthy();
    expect(
      within(group("Codex health")).getByText(/Codex doctor reported a problem: config\./),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /check codex health/i })).toBeNull();
  });

  it("with no health check run the row says where to run it", () => {
    codexIntegration.value = CODEX_STATUS;
    renderSection(fixture());
    expect(
      within(group("Codex health")).getByText("Run Check Codex health in the launchers section."),
    ).toBeTruthy();
  });

  it("the health row and the Launcher row both link to the launchers section and nothing else", () => {
    codexIntegration.value = CODEX_STATUS;
    const f = fixture();
    renderSection(f);
    for (const row of ["Codex health", "Launcher"]) {
      fireEvent.click(
        within(group(row)).getByRole("button", { name: "Go to the launchers section" }),
      );
      expect(takeSettingsSectionRequest()).toBe("launchers");
    }
    expect(f.writes).toEqual([]);
  });
});

describe("Task 1, Test 4: Accounts has no control", () => {
  it("lists Gmail, Google Calendar and GitHub as not part of this version with the locked sentence", () => {
    const f = fixture();
    const { container } = renderSection(f);
    const accounts = container.querySelector('[data-group="accounts"]') as HTMLElement;
    expect(accounts).not.toBeNull();
    expect(within(accounts).getByRole("heading", { level: 4, name: "Accounts" }).className).toBe(
      "ccc-settings-group-title",
    );
    for (const name of ["Gmail", "Google Calendar", "GitHub"]) {
      const row = within(accounts).getByRole("group", { name });
      expect(row.textContent).toContain("∅");
      expect(row.textContent).toContain("Not part of this version");
      expect(row.textContent).toContain(
        "Connecting accounts arrives in a later milestone. Nothing is read from this account.",
      );
    }
    expect(within(accounts).queryAllByRole("button")).toEqual([]);
    expect(within(accounts).queryAllByRole("link")).toEqual([]);
    expect(screen.queryByRole("button", { name: /connect|disconnect|sign in/i })).toBeNull();
  });

  it("has the three group headings in order, as h4 group titles", () => {
    const { container } = renderSection(fixture());
    const titles = [...container.querySelectorAll("h4.ccc-settings-group-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Claude Code", "Codex", "Accounts"]);
  });
});

describe("registration", () => {
  it("is a registered section view for the integrations id", async () => {
    const { SECTION_VIEWS } = await import("./settings-destination.js");
    expect(SECTION_VIEWS.integrations).toBeDefined();
  });

  it("makes no network, install or timer call from the source", async () => {
    const source = readFileSync(join(HERE, "settings-integrations.tsx"), "utf8");
    expect(source).not.toMatch(
      /fetch\(|XMLHttpRe|WebSocket|node:http|child_process|setTimeout|setInterval/,
    );
    // The native attribute only: `aria-disabled=` is the honest way to say a control can't act.
    expect(source).not.toMatch(/(?<![-\w])disabled=/);
  });
});

// ---------------------------------------------------------------------------------------------
// Plan 08-18 Task 3: the native tab's Claude and Codex groups are gone, so everything they did is
// proven here. Each test below replaces one removed `settings-tab.test.ts` case (see the SUMMARY).

/** The names of the rows (`role="group"`) inside one `data-group` block, in document order. */
function rowNames(container: Element, groupId: string): (string | null)[] {
  const block = container.querySelector(`[data-group="${groupId}"]`);
  if (block === null) throw new Error(`no ${groupId} group`);
  return [...block.querySelectorAll('[role="group"]')].map((row) => {
    const labelledBy = row.getAttribute("aria-labelledby");
    return labelledBy === null ? null : (document.getElementById(labelledBy)?.textContent ?? null);
  });
}

describe("08-18: the rows moved from the native tab, in their locked order", () => {
  it("the Claude group has the four status and copy rows in the native tab's order", () => {
    const { container } = renderSection(fixture());
    expect(rowNames(container, "claude")).toEqual([
      CLAUDE_HOOKS_NAME,
      CLAUDE_COPY_INSTALL_NAME,
      CLAUDE_COPY_UNINSTALL_NAME,
      CLAUDE_STATUSLINE_NAME,
    ]);
  });

  it("the Codex group has every native row, including Copy uninstall step, in the native order", () => {
    const { container } = renderSection(fixture());
    expect(rowNames(container, "codex")).toEqual([
      "Codex hooks",
      "Copy install step",
      "Copy uninstall step",
      "Antigravity terminal bridge",
      "Copy bridge install step",
      "Codex health",
      "Codex notify setting",
      "Launcher",
    ]);
  });

  it("Copy uninstall step copies the fixed Codex uninstall step and posts the locked notice", async () => {
    const f = fixture();
    renderSection(f);
    const row = group("Copy uninstall step");
    expect(within(row).getByText("./scripts/codex-hooks/uninstall.sh")).toBeTruthy();
    expect(
      within(row).getByText(
        "Removes the Codex hooks this app added and leaves everything else as it was: ./scripts/codex-hooks/uninstall.sh",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(row).getByRole("button", { name: "Copy uninstall command for the Codex hooks" }),
    );
    await flush();
    expect(f.copyText).toHaveBeenLastCalledWith("./scripts/codex-hooks/uninstall.sh");
    expect(f.notify).toHaveBeenLastCalledWith("Uninstall step copied. Run it in Terminal.");
    expect(f.writes).toEqual([]);
  });

  it("a refused clipboard write on the Codex uninstall step says so and does not claim a copy", async () => {
    const f = fixture({ copy: () => Promise.reject(new Error("clipboard denied")) });
    renderSection(f);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy uninstall command for the Codex hooks" }),
    );
    await flush();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenLastCalledWith(
      "Couldn't copy the command. It's shown in the setting's description; copy it from there.",
    );
  });

  it("the Claude install row names --dry-run and --with-statusline, and no row shows a home path", () => {
    const { container } = renderSection(fixture());
    const install = group(CLAUDE_COPY_INSTALL_NAME);
    expect(install.textContent).toContain("--dry-run");
    expect(install.textContent).toContain("--with-statusline");
    const text = container.textContent ?? "";
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("~/.claude");
  });
});

describe("08-18: status freshness moved from the native tab", () => {
  it("opening the section again reads the status again; re-rendering with a new clock reads nothing", async () => {
    const f = fixture({
      claude: () => Promise.resolve(CLAUDE_NOT_INSTALLED),
      codex: () => Promise.resolve(CODEX_STATUS),
    });
    const first = renderSection(f);
    await flush();
    expect(f.getClaude).toHaveBeenCalledTimes(1);

    // The shared clock ticks: the section re-renders and starts no further read (no refresh loop).
    first.rerender(
      <IntegrationsSection
        host={f.host}
        connection={{ kind: "live" }}
        now={NOW + 60_000}
        notify={f.notify}
        launchersSession={f.session}
      />,
    );
    await flush();
    expect(f.getClaude).toHaveBeenCalledTimes(1);
    expect(f.getCodex).toHaveBeenCalledTimes(1);

    // Leaving the section and coming back (the nav unmounts it) reads the newest answer.
    first.unmount();
    renderSection(f);
    await flush();
    expect(f.getClaude).toHaveBeenCalledTimes(2);
    expect(f.getCodex).toHaveBeenCalledTimes(2);
  });

  it("F4: a reconnect snapshot with no Codex status refreshes the hooks row without reopening Settings", async () => {
    const INSTALLED_NO_EVENTS: CodexIntegrationStatus = {
      ...CODEX_STATUS,
      hooks: { state: "installed", lastEventAt: null, installedSince: "2026-10-11T00:00:00.000Z" },
    };
    let current = CODEX_STATUS;
    codexIntegration.value = CODEX_STATUS;
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture({ codex: () => Promise.resolve(current) });
    renderSection(f);
    await flush();
    expect(within(group("Codex hooks")).getByText(/^Not installed\./)).toBeTruthy();
    expect(f.getCodex).not.toHaveBeenCalled();

    // The service restarted; the snapshot carries no integration part, so the section re-reads.
    current = INSTALLED_NO_EVENTS;
    await act(async () => {
      adoptCodexSnapshot({ state: { codex: {} } } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(f.getCodex).toHaveBeenCalledTimes(1);
    expect(
      within(group("Codex hooks")).getByText(/^Installed, but no events have arrived/),
    ).toBeTruthy();
  });

  it("F4: a snapshot that carries the Codex status is adopted directly, with no second read", async () => {
    codexIntegration.value = CODEX_STATUS;
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    // Any read would hang, so only the pushed status can change the row.
    const f = fixture();
    renderSection(f);
    await flush();

    await act(async () => {
      adoptCodexSnapshot({
        state: {
          codex: {
            integration: {
              ...CODEX_STATUS,
              hooks: { state: "installed", lastEventAt: null, installedSince: null },
            },
          },
        },
      } as never);
      await Promise.resolve();
    });
    await flush();
    expect(
      within(group("Codex hooks")).getByText(/^Installed, but no events have arrived/),
    ).toBeTruthy();
    expect(f.getCodex).not.toHaveBeenCalled();
  });

  it("F4: a status pushed while a refresh is in flight stands; the slower, older answer cannot overwrite it", async () => {
    codexIntegration.value = CODEX_STATUS;
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    let answerLate!: (status: CodexIntegrationStatus) => void;
    const f = fixture({
      codex: () =>
        new Promise<CodexIntegrationStatus>((resolve) => {
          answerLate = resolve;
        }),
    });
    renderSection(f);
    await flush();

    await act(async () => {
      adoptCodexSnapshot({ state: { codex: {} } } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(f.getCodex).toHaveBeenCalledTimes(1);

    // The service pushes a newer status while that read is still out.
    await act(async () => {
      codexIntegration.value = {
        ...CODEX_STATUS,
        hooks: { state: "installed", lastEventAt: null, installedSince: null },
      };
      await Promise.resolve();
    });
    await act(async () => {
      answerLate(CODEX_STATUS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      within(group("Codex hooks")).getByText(/^Installed, but no events have arrived/),
    ).toBeTruthy();
  });

  it("F4: a refresh that fails settles on the moved unavailable string, never on Checking", async () => {
    codexIntegration.value = CODEX_STATUS;
    claudeIntegration.value = CLAUDE_NOT_INSTALLED;
    const f = fixture({ codex: () => Promise.reject(new Error("down")) });
    renderSection(f);
    await act(async () => {
      adoptCodexSnapshot({ state: { codex: {} } } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(
      within(group("Codex hooks")).getByText(
        "Status unavailable — the companion service didn't respond.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Checking…")).toBeNull();
  });
});
