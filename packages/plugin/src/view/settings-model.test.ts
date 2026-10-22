import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionMode } from "../motion.js";
import { formatAbsoluteTime } from "../widgets/relative-time.js";
import * as model from "./settings-model.js";
import {
  applyNotifyApprovalsChange,
  applyReducedMotionChange,
  applyTranscriptAnalysisChange,
  asMotionPreference,
  CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE,
  hookStatusText,
  NOTIFY_APPROVALS_SAVE_FAILED,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_OPTIONS,
  REDUCED_MOTION_SAVE_FAILED,
  rebuildSuccessNotice,
  type SettingsClaudeSeam,
  type SettingsModelHost,
  statusLineStatusText,
} from "./settings-model.js";
import * as tab from "./settings-tab.js";

/**
 * Plan 08-02 (research B Pitfall 1): the settings logic lives in an Obsidian-free module that
 * the no-externals visual harness bundle can import. Every moved string is byte-identical to the
 * value the native tab has always shown, and the three apply functions take their outcome
 * channel as a required `notify` parameter.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  motionMode.value = "full";
});

afterEach(() => {
  motionMode.value = "full";
});

function createHost(failSave = false): SettingsModelHost & {
  saves: number;
  motionAtSave: string[];
} {
  const host = {
    settings: { reducedMotion: "auto" as "auto" | "reduced" },
    mql: { matches: false },
    saves: 0,
    motionAtSave: [] as string[],
    saveSettings: async () => {
      host.saves += 1;
      host.motionAtSave.push(motionMode.value);
      if (failSave) throw new Error("saveData: disk is full");
    },
  };
  return host;
}

describe("applyReducedMotionChange (Test 1, tracer)", () => {
  it("persists first, then applies the resolved motion mode, and reports nothing", async () => {
    const host = createHost();
    const notices: string[] = [];

    const outcome = await applyReducedMotionChange(host, "reduced", (message) => {
      notices.push(message);
    });

    expect(outcome).toBe("saved");
    expect(host.saves).toBe(1);
    // The save ran while the mode was still the old one: persist first, apply second.
    expect(host.motionAtSave).toEqual(["full"]);
    expect(host.settings.reducedMotion).toBe("reduced");
    expect(motionMode.value).toBe("reduced");
    expect(notices).toEqual([]);
  });

  it("restores the previous value, leaves the mode alone and notifies on a rejected save", async () => {
    const host = createHost(true);
    const notices: string[] = [];

    const outcome = await applyReducedMotionChange(host, "reduced", (message) => {
      notices.push(message);
    });

    expect(outcome).toBe("reverted");
    expect(host.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("full");
    expect(notices).toEqual([REDUCED_MOTION_SAVE_FAILED]);
  });

  it("still defers to the OS when System is selected", async () => {
    const host = createHost();
    host.settings.reducedMotion = "reduced";
    motionMode.value = "reduced";
    const osReducing = { ...host, mql: { matches: true } };
    await applyReducedMotionChange(osReducing, "auto", () => undefined);
    expect(osReducing.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("reduced");
  });

  it("keeps the moved strings byte-identical", () => {
    expect(REDUCED_MOTION_DESC).toBe(
      "Turn off number easing, the background twinkle and decorative transitions. " +
        "System follows the macOS accessibility setting.",
    );
    expect(REDUCED_MOTION_SAVE_FAILED).toBe("Couldn't save the reduced motion setting.");
  });
});

describe("asMotionPreference and REDUCED_MOTION_OPTIONS (Test 2)", () => {
  it("maps every option value to itself and refuses anything else to auto", () => {
    for (const value of Object.keys(REDUCED_MOTION_OPTIONS)) {
      expect(asMotionPreference(value)).toBe(value);
    }
    for (const bad of [undefined, null, 0, "", "REDUCED", "full", {}, ["reduced"], true]) {
      expect(asMotionPreference(bad)).toBe("auto");
    }
  });

  it("labels the two options exactly as the owner reads them", () => {
    expect(REDUCED_MOTION_OPTIONS).toEqual({ auto: "System", reduced: "Always reduced" });
  });
});

/** The value imports of a TypeScript source: `import ... from "x"` and `export ... from "x"`, minus type-only ones. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /^(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms;
  for (const match of source.matchAll(pattern)) {
    if (match[1] === undefined && match[2] !== undefined) found.push(match[2]);
  }
  for (const match of source.matchAll(/^import\s+["']([^"']+)["']/gm)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

function resolveSibling(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` through relative value imports, with its external imports. */
function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || graph.has(file)) continue;
    const specifiers = valueImports(readFileSync(file, "utf8"));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const next = resolveSibling(file, specifier);
      if (next === null) throw new Error(`unresolved relative import in the settings model graph`);
      queue.push(next);
    }
  }
  return graph;
}

describe("the model is Obsidian-free (Test 3)", () => {
  const entry = join(HERE, "settings-model.ts");
  const source = readFileSync(entry, "utf8");

  it("imports nothing from obsidian, directly or through any relative value import", () => {
    const graph = importGraph(entry);
    expect(graph.size).toBeGreaterThanOrEqual(1);
    for (const [file, specifiers] of graph) {
      expect(specifiers, `imports of ${file.slice(HERE.length)}`).not.toContain("obsidian");
    }
  });

  it("imports only the domain, preact signals and Obsidian-free siblings", () => {
    const allowed = [/^@ccc\/domain(\/[A-Za-z0-9.-]+\.js)?$/, /^@preact\/signals$/, /^\.{1,2}\//];
    for (const specifier of valueImports(source)) {
      expect(
        allowed.some((pattern) => pattern.test(specifier)),
        specifier,
      ).toBe(true);
    }
  });

  it("would notice an Obsidian import: the native tab's graph contains one", () => {
    const all = [...importGraph(join(HERE, "settings-tab.ts")).values()].flat();
    expect(all).toContain("obsidian");
  });

  it("constructs no Notice (comments aside)", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bNotice\b/);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the rest of the native tab's logic moved, strings unchanged.
// The expected texts below are the pre-move outputs of `settings-tab.ts`, captured in the red
// step (plan 08-02, T-08-03); only a timestamp is built from the shared formatter, because its
// rendering depends on the machine's locale and time zone.

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const MINUTE = 60_000;
const SILENT_SUFFIX =
  " Claude Code skips hooks in folders you haven't trusted and when hooks are turned off in its settings.";

type HookInput = Parameters<typeof hookStatusText>[0];
const installed = {
  hooks: "installed",
  lastEventAt: null as string | null,
  telemetry: { kind: "ok" },
} as const;
const hookState = (patch: Record<string, unknown>): HookInput =>
  ({ ...installed, ...patch }) as unknown as HookInput;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("hookStatusText and statusLineStatusText keep their outputs (Test 1)", () => {
  it("returns the pre-move text for every integration state", () => {
    expect(hookStatusText("checking", NOW)).toBe("Checking…");
    expect(hookStatusText("unavailable", NOW)).toBe(
      "Status unavailable — the companion service isn't running.",
    );
    expect(
      hookStatusText(
        hookState({ telemetry: { kind: "unsupported-version", version: "2.0.1" } }),
        NOW,
      ),
    ).toBe("Claude Code 2.0.1 is older than the minimum supported 2.1.214.");
    for (const version of ["x; rm", null]) {
      expect(
        hookStatusText(hookState({ telemetry: { kind: "unsupported-version", version } }), NOW),
      ).toBe("Your Claude Code version is older than the minimum supported 2.1.214.");
    }
    expect(
      hookStatusText(hookState({ telemetry: { kind: "shape-changed", version: "2.1.220" } }), NOW),
    ).toBe(
      "Claude Code 2.1.220 changed its hook event format. Session tracking is paused rather than guessed.",
    );
    expect(hookStatusText(hookState({ hooks: "not-installed" }), NOW)).toBe(
      "Not installed. Session tracking and waiting-for-approval states need them.",
    );
    expect(hookStatusText(hookState({}), NOW)).toBe(
      `Installed, but no events have arrived yet.${SILENT_SUFFIX}`,
    );
    expect(hookStatusText(hookState({ lastEventAt: ago(5 * MINUTE) }), NOW)).toBe(
      "Installed. Last event 5 minutes ago.",
    );
    // The silence threshold is inclusive at ten minutes.
    expect(hookStatusText(hookState({ lastEventAt: ago(10 * MINUTE) }), NOW)).toBe(
      "Installed. Last event 10 minutes ago.",
    );
    const silentAt = ago(10 * MINUTE + 1);
    expect(hookStatusText(hookState({ lastEventAt: silentAt }), NOW)).toBe(
      `Installed, but no events have arrived since ${formatAbsoluteTime(silentAt)}.${SILENT_SUFFIX}`,
    );
  });

  it("returns the pre-move text for the status-line wrapper", () => {
    type LineInput = Parameters<typeof statusLineStatusText>[0];
    const line = (statusLine: string, statusLineReported: boolean): LineInput =>
      ({ statusLine, statusLineReported }) as unknown as LineInput;
    expect(statusLineStatusText("checking", NOW)).toBe("Checking…");
    expect(statusLineStatusText("unavailable", NOW)).toBe(
      "Status unavailable — the companion service isn't running.",
    );
    expect(statusLineStatusText(line("not-installed", false), NOW)).toBe(
      'Not installed. Plan usage reads "Account capacity unavailable". The wrapper keeps your current status line exactly as it is.',
    );
    expect(statusLineStatusText(line("installed", false), NOW)).toBe(
      "Installed. Waiting for the first response in a Claude Code session.",
    );
    expect(statusLineStatusText(line("installed", true), NOW)).toBe(
      "Installed. Plan usage is available.",
    );
  });
});

describe("rebuildSuccessNotice keeps its counts (Test 3)", () => {
  it("formats the same sentences as before", () => {
    expect(rebuildSuccessNotice(212, 0)).toBe("Task index rebuilt. 212 tasks found.");
    expect(rebuildSuccessNotice(1, 0)).toBe("Task index rebuilt. 1 task found.");
    expect(rebuildSuccessNotice(0, 0)).toBe("Task index rebuilt. 0 tasks found.");
    expect(rebuildSuccessNotice(212, 3)).toBe(
      "Task index rebuilt. 212 tasks found. 3 notes need attention.",
    );
    expect(rebuildSuccessNotice(1, 1)).toBe(
      "Task index rebuilt. 1 task found. 1 note needs attention.",
    );
  });
});

describe("applyNotifyApprovalsChange and applyTranscriptAnalysisChange (Test 2)", () => {
  function claudeSeam(
    setTranscriptAnalysis: SettingsClaudeSeam["setTranscriptAnalysis"],
  ): SettingsClaudeSeam {
    return {
      getIntegration: async () => ({}) as ClaudeIntegrationStatus,
      setTranscriptAnalysis,
      deleteUsageAnalytics: async () => undefined,
      copyText: async () => undefined,
    };
  }

  it("approval notifications: persists first and keeps the new value", async () => {
    const host = createHost();
    const notices: string[] = [];
    const outcome = await applyNotifyApprovalsChange(host, false, (m) => notices.push(m));
    expect(outcome).toBe("saved");
    expect(host.saves).toBe(1);
    expect(host.settings.notifyApprovals).toBe(false);
    expect(notices).toEqual([]);
  });

  it("approval notifications: restores the previous value and notifies when the save fails", async () => {
    const host = createHost(true);
    const notices: string[] = [];
    // The setting reads as on when it was never written (the default).
    const outcome = await applyNotifyApprovalsChange(host, false, (m) => notices.push(m));
    expect(outcome).toBe("reverted");
    expect(host.settings.notifyApprovals).toBe(true);
    expect(notices).toEqual([NOTIFY_APPROVALS_SAVE_FAILED]);
  });

  it("transcript analysis: asks the service, reports nothing and writes no preference key", async () => {
    const calls: boolean[] = [];
    const host = {
      ...createHost(),
      claude: claudeSeam(async (enabled) => {
        calls.push(enabled);
        return { enabled };
      }),
    };
    const notices: string[] = [];
    const outcome = await applyTranscriptAnalysisChange(host, true, (m) => notices.push(m));
    expect(outcome).toBe("saved");
    expect(calls).toEqual([true]);
    expect(notices).toEqual([]);
    expect(Object.keys(host.settings).sort()).toEqual(["reducedMotion"]);
  });

  it("transcript analysis: reverts with the fixed failure text when the service rejects or is absent", async () => {
    const notices: string[] = [];
    const rejecting = {
      ...createHost(),
      claude: claudeSeam(async () => {
        throw new Error("service said no");
      }),
    };
    expect(await applyTranscriptAnalysisChange(rejecting, true, (m) => notices.push(m))).toBe(
      "reverted",
    );
    expect(await applyTranscriptAnalysisChange(createHost(), true, (m) => notices.push(m))).toBe(
      "reverted",
    );
    expect(notices).toEqual([
      CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE,
      CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE,
    ]);
    expect(CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE).toBe(
      "Couldn't change transcript analysis. The companion service didn't respond.",
    );
  });
});

describe("the native tab still exports every moved name (Test 4)", () => {
  const tabTestSource = readFileSync(join(HERE, "settings-tab.test.ts"), "utf8");
  const imported = [
    ...(/import\s*\{([^}]*)\}\s*from\s*"\.\/settings-tab\.js"/s.exec(tabTestSource)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name !== ""),
  ];

  it("finds the names the existing tab tests import", () => {
    expect(imported.length).toBeGreaterThan(40);
  });

  it("exports each of them from settings-tab.ts", () => {
    const exported = new Set(Object.keys(tab));
    const typeOnly = new Set(["SettingsClaudeSeam", "SettingsTabHost"]);
    for (const name of imported) {
      if (typeOnly.has(name)) continue;
      expect(exported.has(name), name).toBe(true);
    }
  });

  it("equals the model's value for every moved text constant", () => {
    const moved = Object.entries(model).filter(([, value]) => typeof value === "string");
    expect(moved.length).toBeGreaterThan(30);
    for (const [name, value] of moved) {
      expect((tab as Record<string, unknown>)[name], name).toBe(value);
    }
    expect(tab.REDUCED_MOTION_OPTIONS).toBe(model.REDUCED_MOTION_OPTIONS);
    expect(tab.asMotionPreference).toBe(model.asMotionPreference);
    expect(tab.hookStatusText).toBe(model.hookStatusText);
    expect(tab.statusLineStatusText).toBe(model.statusLineStatusText);
    expect(tab.rebuildSuccessNotice).toBe(model.rebuildSuccessNotice);
  });
});
