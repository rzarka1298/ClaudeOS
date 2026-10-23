import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import * as codexSettings from "./codex-settings.js";
import {
  CODEX_BRIDGE_INSTALL_STEP,
  CODEX_COPY_BRIDGE_DESC,
  CODEX_COPY_INSTALL_DESC,
  CODEX_COPY_UNINSTALL_DESC,
  CODEX_COPY_UNINSTALL_NAME,
  CODEX_HOOKS_INSTALL_STEP,
  CODEX_HOOKS_UNINSTALL_STEP,
  CODEX_INSTALL_COPIED_NOTICE,
  CODEX_LAUNCHER_DESC,
  CODEX_NOTIFY_DESC,
  CODEX_UNINSTALL_COPIED_NOTICE,
  type CodexStatusInput,
  codexBridgeStatusText,
  codexHookStatusText,
} from "./codex-settings.js";

/**
 * The Codex status texts and locked copy (05.1 UI-SPEC S4-a, D-12, D-19, D-30), now read by the
 * Integrations section (plan 08-18 removed the native tab's Codex group). Every string below is
 * asserted LITERALLY from the locked copy, so a drifted constant cannot hide behind a test that
 * imports it.
 */

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const FIVE_MIN_AGO = "2026-10-10T11:55:00.000Z";
const INSTALLED_AT = "2026-10-09T08:30:00.000Z";

function integration(overrides: {
  hooks?: Partial<CodexIntegrationStatus["hooks"]>;
  bridge?: Partial<CodexIntegrationStatus["bridge"]>;
}): CodexIntegrationStatus {
  return {
    hooks: { state: "not-installed", lastEventAt: null, installedSince: null, ...overrides.hooks },
    bridge: { state: "not-installed", lastWindowAt: null, ...overrides.bridge },
    codex: { installed: true, version: "0.159.2" },
    doctor: null,
  };
}

const TRUST_SUFFIX =
  "Codex asks you to trust a new hook on its hooks screen (type /hooks in Codex), and skips hooks in folders it hasn't trusted.";

describe("codexHookStatusText (UI-SPEC S4-a row 1)", () => {
  it("reads Checking… before the service answers and the locked unavailable line after a failure", () => {
    expect(codexHookStatusText("checking", NOW)).toBe("Checking…");
    expect(codexHookStatusText("unavailable", NOW)).toBe(
      "Status unavailable — the companion service didn't respond.",
    );
  });

  it("installed with events reads 'Installed. Last event {relative time}.'", () => {
    const text = codexHookStatusText(
      integration({
        hooks: { state: "installed", lastEventAt: FIVE_MIN_AGO, installedSince: INSTALLED_AT },
      }),
      NOW,
    );
    expect(text).toBe(`Installed. Last event ${formatRelativeTime(FIVE_MIN_AGO, NOW)}.`);
    expect(text).toBe("Installed. Last event 5 minutes ago.");
  });

  it("installed with no events names the absolute install time, the /hooks screen and untrusted folders", () => {
    const text = codexHookStatusText(
      integration({
        hooks: { state: "installed-no-events", lastEventAt: null, installedSince: INSTALLED_AT },
      }),
      NOW,
    );
    expect(text).toBe(
      `Installed, but no events have arrived since ${formatAbsoluteTime(INSTALLED_AT)}. ${TRUST_SUFFIX}`,
    );
  });

  it("installed with no events and no install time still reads a definite sentence", () => {
    const text = codexHookStatusText(integration({ hooks: { state: "installed-no-events" } }), NOW);
    expect(text).toBe(`Installed, but no events have arrived yet. ${TRUST_SUFFIX}`);
  });

  it("not installed reads the locked sentence", () => {
    expect(codexHookStatusText(integration({ hooks: { state: "not-installed" } }), NOW)).toBe(
      "Not installed. Live status for interactive Codex sessions needs the optional hook package. Sessions and usage still appear from Codex's own records.",
    );
  });

  it("an unknown hook state reads a definite sentence that blames nobody", () => {
    const text = codexHookStatusText(integration({ hooks: { state: "unknown" } }), NOW);
    expect(text).toBe(
      "Status unknown. This app couldn't tell whether the hook package is installed.",
    );
  });
});

describe("codexBridgeStatusText (UI-SPEC S4-a row 4)", () => {
  it("covers every bridge state with its locked sentence", () => {
    const cases: Array<[CodexStatusInput, string]> = [
      [
        integration({ bridge: { state: "installed", lastWindowAt: FIVE_MIN_AGO } }),
        "Installed. Antigravity reported a window 5 minutes ago.",
      ],
      [
        integration({ bridge: { state: "installed-idle", lastWindowAt: null } }),
        "Installed, but Antigravity hasn't reported a window recently. It opens when you launch.",
      ],
      [
        integration({ bridge: { state: "not-installed" } }),
        "Not installed. Launches fall back to Terminal.",
      ],
      [integration({ bridge: { state: "outdated" } }), "Out of date. Run its install step again."],
      [
        integration({ bridge: { state: "different-folder" } }),
        "Installed, but it writes to a different state folder than this app reads. Run its install step again.",
      ],
      ["unavailable", "Status unavailable — the companion service didn't respond."],
      ["checking", "Checking…"],
    ];
    for (const [status, expected] of cases) {
      expect(codexBridgeStatusText(status, NOW)).toBe(expected);
    }
  });

  it("an installed bridge with no window time falls back to the idle sentence", () => {
    expect(
      codexBridgeStatusText(
        integration({ bridge: { state: "installed", lastWindowAt: null } }),
        NOW,
      ),
    ).toBe(
      "Installed, but Antigravity hasn't reported a window recently. It opens when you launch.",
    );
  });
});

describe("status rows carry no path (R-15, PRIV-04)", () => {
  const states: CodexStatusInput[] = [
    "checking",
    "unavailable",
    integration({ hooks: { state: "installed", lastEventAt: FIVE_MIN_AGO } }),
    integration({ hooks: { state: "installed-no-events", installedSince: INSTALLED_AT } }),
    integration({ hooks: { state: "not-installed" } }),
    integration({ hooks: { state: "unknown" } }),
    integration({ bridge: { state: "installed", lastWindowAt: FIVE_MIN_AGO } }),
    integration({ bridge: { state: "installed-idle" } }),
    integration({ bridge: { state: "outdated" } }),
    integration({ bridge: { state: "different-folder" } }),
  ];

  it("no status text holds a home path, an absolute path or a slash other than /hooks", () => {
    for (const status of states) {
      for (const text of [codexHookStatusText(status, NOW), codexBridgeStatusText(status, NOW)]) {
        expect(text).not.toMatch(/\/Users|\/home|~\/|[A-Za-z]:\\/);
        expect(text.replaceAll("/hooks", "")).not.toContain("/");
      }
    }
  });
});

describe("the locked copy and fixed steps the Integrations section reads (moved from the removed group)", () => {
  it("pins the copy-row descriptions literally", () => {
    expect(CODEX_COPY_INSTALL_DESC).toBe(
      "From the Claude command center repository folder, run: ./scripts/codex-hooks/install.sh — add --dry-run to preview the change first. It adds to Codex's hooks file only and never touches its config file or notify setting. Then type /hooks in Codex and trust the new hook.",
    );
    expect(CODEX_COPY_UNINSTALL_DESC).toBe(
      "Removes the Codex hooks this app added and leaves everything else as it was: ./scripts/codex-hooks/uninstall.sh",
    );
    expect(CODEX_COPY_BRIDGE_DESC).toBe(
      "From the Claude command center repository folder, run: node scripts/codex/install-user-kit.mjs — it installs the Antigravity terminal bridge for your user account only. Restart Antigravity afterwards.",
    );
  });

  it("pins the Launcher and notify descriptions literally", () => {
    expect(CODEX_LAUNCHER_DESC).toBe(
      "Antigravity terminal is the default. It falls back to Terminal when the bridge isn't installed. A Terminal setup you already saved stays as it is until you save a new one.",
    );
    expect(CODEX_NOTIFY_DESC).toBe(
      "Left untouched. This app never takes over Codex's notify setting.",
    );
  });

  it("the three fixed steps are repository-relative and the notices are the locked ones", () => {
    expect([
      CODEX_HOOKS_INSTALL_STEP,
      CODEX_HOOKS_UNINSTALL_STEP,
      CODEX_BRIDGE_INSTALL_STEP,
    ]).toEqual([
      "./scripts/codex-hooks/install.sh",
      "./scripts/codex-hooks/uninstall.sh",
      "node scripts/codex/install-user-kit.mjs",
    ]);
    for (const step of [
      CODEX_HOOKS_INSTALL_STEP,
      CODEX_HOOKS_UNINSTALL_STEP,
      CODEX_BRIDGE_INSTALL_STEP,
    ]) {
      expect(step).not.toMatch(/^\/|\/Users|~/);
    }
    expect(CODEX_COPY_UNINSTALL_NAME).toBe("Copy uninstall step");
    expect(CODEX_INSTALL_COPIED_NOTICE).toBe("Install step copied. Run it in Terminal.");
    expect(CODEX_UNINSTALL_COPIED_NOTICE).toBe("Uninstall step copied. Run it in Terminal.");
  });

  it("no description renders an absolute or home path, and the word command appears only in the product name", () => {
    for (const desc of [
      CODEX_COPY_INSTALL_DESC,
      CODEX_COPY_UNINSTALL_DESC,
      CODEX_COPY_BRIDGE_DESC,
      CODEX_LAUNCHER_DESC,
      CODEX_NOTIFY_DESC,
    ]) {
      expect(desc).not.toMatch(/\/Users|\/home|~\//);
      expect(desc.replaceAll("Claude command center", "")).not.toMatch(/command/i);
    }
  });

  it("the native-tab group builder, its input type and its state class are gone", () => {
    const exported = Object.keys(codexSettings);
    expect(exported).not.toContain("buildCodexGroup");
    expect(exported).not.toContain("CodexSettingsState");
    expect(exported).not.toContain("CODEX_OPEN_LAUNCHER_LABEL");
  });
});

describe("the plugin host wires exactly one codex seam member (T-05.1-09, T-05.1-18)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, "..", "main.ts"), "utf8");
  const settings = readFileSync(join(here, "codex-settings.ts"), "utf8");

  it("main.ts binds getCodexIntegration and the clipboard in one codex member, with no launcher hand-off", () => {
    expect(main.match(/^\s+codex: \{/gm)).toHaveLength(1);
    expect(main).toMatch(/getIntegration: \(\) => getCodexIntegration\(this\.client\)/);
    // The Launchers section is reached by `requestSettingsSection("launchers")`, not by the host.
    expect(main).not.toMatch(/openLauncherSettings/);
    expect(settings).not.toMatch(/openLauncherSettings/);
  });

  it("the settings module installs nothing: no process, file-system or network call and no design token", () => {
    expect(settings).not.toMatch(
      /child_process|node:fs|writeFile|fetch\(|XMLHttpRequest|spawn|exec\(|localStorage|saveData/,
    );
    expect(settings).not.toContain("--ccc-");
  });
});
