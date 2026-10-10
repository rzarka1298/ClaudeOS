import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import { describe, expect, it, vi } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import {
  buildCodexGroup,
  CodexSettingsState,
  type CodexStatusInput,
  codexBridgeStatusText,
  codexHookStatusText,
} from "./codex-settings.js";

/**
 * Plan 05.1-19 task 3: the "Codex" settings group (UI-SPEC S4-a, D-12, D-19,
 * D-30). Every string below is asserted LITERALLY from the locked copy, so a
 * drifted constant cannot hide behind a test that imports it.
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

/** A row as a test reads it: the group's tuple holds differently shaped items, one per row kind. */
interface Row {
  readonly name: string;
  readonly desc?: string;
  readonly action?: (el: HTMLElement, index: number) => void;
  readonly control?: unknown;
}

function groupFor(
  status: CodexStatusInput,
  overrides: { copy?: (text: string, notice: string) => void; open?: () => void } = {},
): { readonly type: "group"; readonly heading: string; readonly items: readonly Row[] } {
  return buildCodexGroup({
    status,
    nowMs: NOW,
    copy: overrides.copy ?? vi.fn(),
    openLauncherSettings: overrides.open ?? vi.fn(),
  }) as unknown as ReturnType<typeof groupFor>;
}

describe("buildCodexGroup (UI-SPEC S4-a: seven rows, locked order and copy)", () => {
  it("is a group headed Codex with exactly seven rows in the locked order", () => {
    const group = groupFor("checking");
    expect(group).toMatchObject({ type: "group", heading: "Codex" });
    expect(group.items.map((item) => item.name)).toEqual([
      "Codex hooks",
      "Copy install step",
      "Copy uninstall step",
      "Antigravity terminal bridge",
      "Copy bridge install step",
      "Launcher",
      "Codex notify setting",
    ]);
  });

  it("the status rows carry the status text; the three copy rows carry the locked descriptions", () => {
    const status = integration({
      hooks: { state: "installed", lastEventAt: FIVE_MIN_AGO },
      bridge: { state: "not-installed" },
    });
    const items = groupFor(status).items;
    expect(items[0]?.desc).toBe("Installed. Last event 5 minutes ago.");
    expect(items[3]?.desc).toBe("Not installed. Launches fall back to Terminal.");
    expect(items[1]?.desc).toBe(
      "From the Claude command center repository folder, run: ./scripts/codex-hooks/install.sh — add --dry-run to preview the change first. It adds to Codex's hooks file only and never touches its config file or notify setting. Then type /hooks in Codex and trust the new hook.",
    );
    expect(items[2]?.desc).toBe(
      "Removes the Codex hooks this app added and leaves everything else as it was: ./scripts/codex-hooks/uninstall.sh",
    );
    expect(items[4]?.desc).toBe(
      "From the Claude command center repository folder, run: node scripts/codex/install-user-kit.mjs — it installs the Antigravity terminal bridge for your user account only. Restart Antigravity afterwards.",
    );
  });

  it("the copy rows hand EXACTLY the fixed repository-relative strings and the locked Notices to copy()", () => {
    const copy = vi.fn();
    const items = groupFor("checking", { copy }).items;
    items[1]?.action?.({} as never, 1);
    items[2]?.action?.({} as never, 2);
    items[4]?.action?.({} as never, 4);
    expect(copy.mock.calls).toEqual([
      ["./scripts/codex-hooks/install.sh", "Install step copied. Run it in Terminal."],
      ["./scripts/codex-hooks/uninstall.sh", "Uninstall step copied. Run it in Terminal."],
      ["node scripts/codex/install-user-kit.mjs", "Install step copied. Run it in Terminal."],
    ]);
    for (const [text] of copy.mock.calls as Array<[string]>) {
      expect(text).not.toMatch(/^\/|\/Users|~/);
    }
  });

  it("the Launcher row has the locked description and an action that opens launcher settings", () => {
    const open = vi.fn();
    const launcher = groupFor("checking", { open }).items[5];
    expect(launcher?.desc).toBe(
      "Antigravity terminal is the default. It falls back to Terminal when the bridge isn't installed. A Terminal setup you already saved stays as it is until you save a new one.",
    );
    launcher?.action?.({} as never, 5);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the notify row states it is untouched and has no control or action", () => {
    const notify = groupFor("checking").items[6];
    expect(notify?.desc).toBe("Left untouched. This app never takes over Codex's notify setting.");
    expect(notify?.action).toBeUndefined();
    expect(notify?.control).toBeUndefined();
  });

  it("no row description renders an absolute or home path, and the word command appears only in the product name", () => {
    for (const status of ["checking", "unavailable"] as const) {
      for (const item of groupFor(status).items) {
        const desc = item.desc ?? "";
        expect(desc).not.toMatch(/\/Users|\/home|~\//);
        expect(desc.replaceAll("Claude command center", "")).not.toMatch(/command/i);
      }
    }
  });
});

describe("CodexSettingsState (fetch when the tab opens, never forever 'checking')", () => {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("starts at checking and settles on the service's answer, calling onChange", async () => {
    const answer = integration({ hooks: { state: "installed", lastEventAt: FIVE_MIN_AGO } });
    const onChange = vi.fn();
    const state = new CodexSettingsState(() => Promise.resolve(answer), onChange);
    expect(state.status).toBe("checking");

    state.load();
    await flush();

    expect(state.status).toBe(answer);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a rejected fetch settles on unavailable", async () => {
    const onChange = vi.fn();
    const state = new CodexSettingsState(() => Promise.reject(new Error("down")), onChange);
    state.load();
    await flush();
    expect(state.status).toBe("unavailable");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("starts no second fetch while one is in flight, and keeps the last status during a refetch", async () => {
    const resolvers: Array<(status: CodexIntegrationStatus) => void> = [];
    const getIntegration = vi.fn(
      () =>
        new Promise<CodexIntegrationStatus>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const state = new CodexSettingsState(getIntegration, vi.fn());

    state.load();
    state.load();
    expect(getIntegration).toHaveBeenCalledTimes(1);

    const first = integration({ hooks: { state: "installed", lastEventAt: FIVE_MIN_AGO } });
    resolvers[0]?.(first);
    await flush();
    state.load(); // the tab is shown again
    expect(getIntegration).toHaveBeenCalledTimes(2);
    expect(state.status).toBe(first); // still the last answer, not "checking"
  });

  it("without a service seam it stays at checking and never throws", () => {
    const state = new CodexSettingsState(undefined, vi.fn());
    expect(() => state.load()).not.toThrow();
    expect(state.status).toBe("checking");
  });
});
