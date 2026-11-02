import { describe, expect, it } from "vitest";
import { HEALTH_PATH } from "./auth.js";
import {
  APPROVAL_PRESENCE_REASONS,
  APPROVAL_PRESENCE_STATES,
  COLLECTORS_PART_IDS,
  COLLECTORS_PART_REASONS,
  COLLECTORS_PASSIVE_PART_IDS,
  COLLECTORS_REASON_STATUS,
  COLLECTORS_REASONS,
  DIAGNOSTICS_ERROR_CODES,
  DIAGNOSTICS_HEALTH_PATH,
  DiagnosticsErrorBodySchema,
  DiagnosticsHealthResponseSchema,
  type DisplayedRow,
  HEALTH_STALE_AFTER_MS,
  HealthTriggerSchema,
  HOOK_SILENT_THRESHOLD_MS,
  HOOKS_REASON_STATUS,
  HOOKS_REASONS,
  LAUNCHER_PART_IDS,
  LAUNCHERS_REASON_STATUS,
  LAUNCHERS_REASONS,
  NOT_IN_VERSION_GLYPH,
  OVERLAY_ONLY_REASONS,
  rollupPartStatuses,
  rollupStatus,
  SCHEDULER_PART_IDS,
  SCHEDULER_PASSIVE_PART_IDS,
  SCHEDULER_REASON_STATUS,
  SCHEDULER_REASONS,
  SERVICE_REASON_STATUS,
  SERVICE_SIDE_REASONS,
  SETTINGS_SECTION_IDS,
  SETUP_COMMAND_IDS,
  SetupActionSchema,
  SUBSYSTEM_IDS,
  SUBSYSTEM_STATUS_DISPLAY,
  SUBSYSTEM_STATUSES,
  type SubsystemStatus,
  summariseRows,
  VAULT_REASON_STATUS,
  VAULT_REASONS,
  VaultFingerprintSchema,
} from "./diagnostics.js";
import { RUN_ERROR_CODES, type RunErrorCode } from "./research.js";

const T0 = "2026-10-22T09:00:00.000Z";

function row(id: string, reasonCode: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "setup-needed" as const,
    reasonCode,
    checkedAt: T0,
    freshness: "live",
    ...extra,
  };
}

/**
 * The fresh-install collectors parts, exactly as 08-08 Task 1 Test 1 builds them: the passive
 * telemetry and spool parts read ok, everything else is not set up (D-34a).
 */
function freshCollectorsParts() {
  const part = (partId: string, reasonCode: string, status: "ok" | "setup-needed") => ({
    partId,
    status,
    reasonCode,
  });
  return [
    part("telemetry", "telemetry-ok", "ok"),
    part("status-line", "statusline-not-installed", "setup-needed"),
    part("transcript-analysis", "analysis-off", "setup-needed"),
    part("spool", "spool-clean", "ok"),
    part("codex-install", "codex-not-installed", "setup-needed"),
    part("codex-hooks", "codex-hooks-not-installed", "setup-needed"),
    part("codex-bridge", "codex-bridge-not-installed", "setup-needed"),
    part("codex-doctor", "codex-doctor-not-run", "setup-needed"),
  ];
}

/** Three scheduler parts at a fresh install: never run, no key, default sources (passive, D-34a). */
function freshSchedulerParts() {
  return [
    { partId: "last-run", status: "setup-needed", reasonCode: "never-run" },
    { partId: "research-key", status: "setup-needed", reasonCode: "research-key-missing" },
    { partId: "sources", status: "ok", reasonCode: "sources-configured" },
  ];
}

/** Four launcher parts, none set up. */
function freshLauncherParts() {
  return ["antigravity", "claude-code", "claude-desktop", "codex"].map((partId) => ({
    partId,
    status: "setup-needed" as const,
    reasonCode: "launcher-not-set-up",
  }));
}

/**
 * The fresh-install response (D-34) with real parts on every row that has parts
 * (FIX1A M3: a parts-less row can only say the probe did not finish). Vault and
 * hooks are setup-needed; collectors, scheduler and launchers are setup-needed
 * by their parts (passive ok parts do not lift a row, D-34a).
 */
function freshInstall() {
  return {
    generatedAt: T0,
    service: { version: "0.1.0", startedAt: T0, storeSchemaVersion: 12 },
    rows: [
      row("vault", "vault-not-set-up"),
      row("hooks", "hooks-not-installed"),
      row("collectors", "statusline-not-installed", { parts: freshCollectorsParts() }),
      row("scheduler", "never-run", { parts: freshSchedulerParts() }),
      row("launchers", "launcher-not-set-up", { parts: freshLauncherParts() }),
    ],
    keychain: { installSecret: "present", researchKey: "absent" },
    paths: {
      vault: null,
      runtimeDir: "~/.claude-command-center",
      socket: "~/.claude-command-center/svc.sock",
    },
    vaultFingerprint: null,
    counts: { projects: 0, scanFolders: 0, openTasks: null, reports: 0 },
  };
}

describe("Task 1 (tracer): a fresh-install health response", () => {
  it("Test 1: parses through the strict contract", () => {
    const parsed = DiagnosticsHealthResponseSchema.safeParse(freshInstall());
    expect(parsed.success).toBe(true);
  });

  it("Test 2: summarises to zero failing and zero degraded", () => {
    const service = { id: "service", status: "ok" as const, reasonCode: "service-live" };
    const rows = [service, ...freshInstall().rows];
    expect(summariseRows(rows)).toEqual({
      failing: 0,
      degraded: 0,
      unknown: 0,
      setupNeeded: 5,
      ok: 1,
    });
  });

  it("Test 3: the health path is its own route, not the Phase 1 health path", () => {
    expect(DIAGNOSTICS_HEALTH_PATH).toBe("/api/v1/diagnostics/health");
    expect(DIAGNOSTICS_HEALTH_PATH).not.toBe(HEALTH_PATH);
  });

  it("Test 4: a row with an extra key, or a status that differs from its reason's, is refused", () => {
    const extraKey = freshInstall();
    extraKey.rows[0] = { ...extraKey.rows[0], message: "boom" } as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(extraKey).success).toBe(false);

    const wrongStatus = freshInstall();
    wrongStatus.rows[1] = { ...wrongStatus.rows[1], status: "ok" } as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongStatus).success).toBe(false);

    const extraTop = { ...freshInstall(), error: "x" };
    expect(DiagnosticsHealthResponseSchema.safeParse(extraTop).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2: every reason, every part, the roll-up, setup actions and the display map

const SHARED: Record<string, SubsystemStatus> = {
  "probe-timeout": "unknown",
  "probe-error": "unknown",
  "subsystem-not-wired": "unknown",
  "service-not-running": "unknown",
};

/** Hand-written expectations, row by row from the UI-SPEC "Reason copy" tables. */
const EXPECTED: Record<string, Record<string, SubsystemStatus>> = {
  service: {
    "service-live": "ok",
    "service-connecting": "unknown",
    "service-unreachable": "failing",
  },
  vault: {
    "vault-ready": "ok",
    "vault-not-set-up": "setup-needed",
    "managed-tree-incomplete": "degraded",
    "not-an-obsidian-vault": "degraded",
    "vault-mismatch": "degraded",
    "vault-root-missing": "failing",
    "vault-root-not-directory": "failing",
    "vault-root-unreadable": "failing",
    "vault-root-not-writable": "failing",
    "vault-root-refused": "failing",
    "vault-check-unavailable": "unknown",
    ...SHARED,
  },
  hooks: {
    "hooks-receiving": "ok",
    "hooks-not-installed": "setup-needed",
    "hooks-disabled-in-claude": "degraded",
    "hook-runtime-missing": "failing",
    "hooks-state-unreadable": "unknown",
    "no-events-yet": "unknown",
    "events-silent": "unknown",
    ...SHARED,
  },
  collectors: {
    "telemetry-ok": "ok",
    "telemetry-shape-changed": "degraded",
    "telemetry-unsupported-version": "degraded",
    "statusline-reporting": "ok",
    "statusline-not-installed": "setup-needed",
    "statusline-awaiting-report": "unknown",
    "statusline-state-unreadable": "unknown",
    "analysis-on": "ok",
    "analysis-off": "setup-needed",
    "spool-clean": "ok",
    "spool-dropped-records": "degraded",
    "codex-installed": "ok",
    "codex-not-installed": "setup-needed",
    "codex-hooks-receiving": "ok",
    "codex-hooks-not-installed": "setup-needed",
    "codex-hooks-no-events": "unknown",
    "codex-hooks-state-unreadable": "unknown",
    "codex-bridge-ready": "ok",
    "codex-bridge-not-installed": "setup-needed",
    "codex-bridge-outdated": "degraded",
    "codex-bridge-different-folder": "degraded",
    "codex-doctor-ok": "ok",
    "codex-doctor-not-run": "setup-needed",
    "codex-doctor-warning": "degraded",
    "codex-doctor-failed": "degraded",
    "codex-doctor-unrecognised": "unknown",
    ...SHARED,
  },
  scheduler: {
    "last-run-succeeded": "ok",
    "run-in-flight": "ok",
    "never-run": "setup-needed",
    "run-summariser-unconfigured": "setup-needed",
    "run-summariser-failed": "degraded",
    "run-summariser-refused": "degraded",
    "run-summariser-invalid-output": "degraded",
    "run-all-sources-failed": "degraded",
    "run-vault-write-failed": "degraded",
    "run-interrupted": "unknown",
    "research-key-present": "ok",
    "research-key-missing": "setup-needed",
    "research-key-check-failed": "unknown",
    "research-key-not-checked": "unknown",
    "sources-configured": "ok",
    "sources-config-unusable": "degraded",
    ...SHARED,
  },
  launchers: {
    "launcher-ready": "ok",
    "launcher-not-set-up": "setup-needed",
    "launcher-untested": "setup-needed",
    "bundle-not-found": "failing",
    "executable-not-found": "failing",
    "terminal-not-found": "failing",
    "bundle-check-unavailable": "unknown",
    ...SHARED,
  },
};

const TABLES: Record<
  string,
  { reasons: readonly string[]; table: Record<string, SubsystemStatus> }
> = {
  service: { reasons: Object.keys(SERVICE_REASON_STATUS), table: SERVICE_REASON_STATUS },
  vault: { reasons: VAULT_REASONS, table: VAULT_REASON_STATUS },
  hooks: { reasons: HOOKS_REASONS, table: HOOKS_REASON_STATUS },
  collectors: { reasons: COLLECTORS_REASONS, table: COLLECTORS_REASON_STATUS },
  scheduler: { reasons: SCHEDULER_REASONS, table: SCHEDULER_REASON_STATUS },
  launchers: { reasons: LAUNCHERS_REASONS, table: LAUNCHERS_REASON_STATUS },
};

describe("Task 2 Test 1 (tables): every reason has exactly the UI-SPEC status", () => {
  it.each(Object.keys(EXPECTED))("%s", (id) => {
    const entry = TABLES[id];
    expect(entry?.table).toEqual(EXPECTED[id]);
    // The ordered list and the status table name exactly the same codes.
    expect([...(entry?.reasons ?? [])].sort()).toEqual(Object.keys(EXPECTED[id] ?? {}).sort());
  });
});

describe("Task 2 Test 2 (roll-up)", () => {
  it("failing beats degraded beats unknown beats ok", () => {
    expect(rollupStatus(["ok", "degraded", "failing", "unknown"])).toBe("failing");
    expect(rollupStatus(["ok", "degraded", "unknown", "setup-needed"])).toBe("degraded");
    expect(rollupStatus(["ok", "unknown", "setup-needed"])).toBe("unknown");
    expect(rollupStatus(["ok", "ok"])).toBe("ok");
  });

  it("is setup-needed only when every part is setup-needed; a mix with ok is ok", () => {
    expect(rollupStatus(["setup-needed", "setup-needed"])).toBe("setup-needed");
    expect(rollupStatus(["ok", "setup-needed", "setup-needed"])).toBe("ok");
  });

  it("never invents ok for nothing", () => {
    expect(rollupStatus([])).toBe("unknown");
  });

  it("refuses a collectors row whose status disagrees with its parts' roll-up", () => {
    const good = collectorsResponse({
      parts: collectorParts({ spool: "spool-dropped-records" }),
      status: "degraded",
      reasonCode: "spool-dropped-records",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(good).success).toBe(true);

    const wrongRollup = collectorsResponse({
      parts: collectorParts({ spool: "spool-dropped-records" }),
      status: "ok",
      reasonCode: "telemetry-ok",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongRollup).success).toBe(false);
  });

  it("requires the row's reason to be the deciding part's reason", () => {
    const wrongReason = collectorsResponse({
      parts: collectorParts({ spool: "spool-dropped-records" }),
      status: "degraded",
      reasonCode: "telemetry-shape-changed",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongReason).success).toBe(false);
  });

  it("refuses a part whose status differs from its reason's, or whose reason belongs to another part", () => {
    const parts = collectorParts({});
    const wrongStatus = collectorsResponse({
      parts: parts.map((p) => (p.partId === "telemetry" ? { ...p, status: "failing" } : p)),
      status: "failing",
      reasonCode: "telemetry-ok",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongStatus).success).toBe(false);

    const wrongPart = collectorsResponse({
      parts: parts.map((p) => (p.partId === "telemetry" ? { ...p, reasonCode: "analysis-on" } : p)),
      status: "ok",
      reasonCode: "analysis-on",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongPart).success).toBe(false);
  });
});

/** All eight collectors parts at their ok reasons, with per-part overrides. */
const OK_COLLECTOR_REASONS: Record<string, string> = {
  telemetry: "telemetry-ok",
  "status-line": "statusline-reporting",
  "transcript-analysis": "analysis-on",
  spool: "spool-clean",
  "codex-install": "codex-installed",
  "codex-hooks": "codex-hooks-receiving",
  "codex-bridge": "codex-bridge-ready",
  "codex-doctor": "codex-doctor-ok",
};

function collectorParts(overrides: Record<string, string>) {
  return Object.entries(OK_COLLECTOR_REASONS).map(([partId, reason]) => {
    const reasonCode = overrides[partId] ?? reason;
    return {
      partId,
      status: EXPECTED.collectors?.[reasonCode] as SubsystemStatus,
      reasonCode,
    };
  });
}

function collectorsResponse(rowOverrides: Record<string, unknown>) {
  const base = freshInstall();
  base.rows[2] = row("collectors", "telemetry-ok", rowOverrides) as never;
  return base;
}

describe("Task 2 Test 3 (parts)", () => {
  it("collectors parts are exactly the eight, scheduler three, launchers five", () => {
    expect([...COLLECTORS_PART_IDS]).toEqual([
      "telemetry",
      "status-line",
      "transcript-analysis",
      "spool",
      "codex-install",
      "codex-hooks",
      "codex-bridge",
      "codex-doctor",
    ]);
    expect([...SCHEDULER_PART_IDS]).toEqual(["last-run", "research-key", "sources"]);
    expect([...LAUNCHER_PART_IDS]).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
      "terminal",
    ]);
  });

  it("has six subsystems in the fixed order and no codex subsystem (D-41)", () => {
    expect([...SUBSYSTEM_IDS]).toEqual([
      "service",
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(SUBSYSTEM_IDS as readonly string[]).not.toContain("codex");
  });

  it("each collectors part has its own reason list and together they cover the table", () => {
    const union = new Set<string>(Object.values(COLLECTORS_PART_REASONS).flat());
    for (const reason of Object.keys(EXPECTED.collectors ?? {})) {
      if (reason in SHARED) continue;
      expect(union.has(reason), reason).toBe(true);
    }
  });

  it("refuses parts that are missing, out of order, duplicated or unknown", () => {
    const parts = collectorParts({});
    const reorder = [...parts].reverse();
    const missing = parts.slice(0, 7);
    const unknown = [
      ...parts.slice(0, 7),
      { partId: "codex", status: "ok", reasonCode: "codex-doctor-ok" },
    ];
    for (const bad of [reorder, missing, unknown]) {
      const response = collectorsResponse({ parts: bad, status: "ok", reasonCode: "telemetry-ok" });
      expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
    }
  });

  it("accepts launchers with four parts, or five with terminal last", () => {
    const part = (partId: string) => ({
      partId,
      status: "setup-needed",
      reasonCode: "launcher-not-set-up",
    });
    const four = ["antigravity", "claude-code", "claude-desktop", "codex"].map(part);
    const five = [...four, part("terminal")];
    for (const parts of [four, five]) {
      const response = freshInstall();
      response.rows[4] = row("launchers", "launcher-not-set-up", { parts }) as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    }
    const misplaced = freshInstall();
    misplaced.rows[4] = row("launchers", "launcher-not-set-up", {
      parts: [part("terminal"), ...four],
    }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(misplaced).success).toBe(false);
  });

  it("accepts scheduler parts and refuses a launcher reason on a scheduler part", () => {
    const parts = [
      { partId: "last-run", status: "setup-needed", reasonCode: "never-run" },
      { partId: "research-key", status: "setup-needed", reasonCode: "research-key-missing" },
      { partId: "sources", status: "ok", reasonCode: "sources-configured" },
    ];
    const ok = freshInstall();
    ok.rows[3] = row("scheduler", "sources-configured", { parts, status: "ok" }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(ok).success).toBe(false); // passive sources cannot lift the row
    ok.rows[3] = row("scheduler", "never-run", { parts }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(ok).success).toBe(true);
    const bad = freshInstall();
    bad.rows[3] = row("scheduler", "never-run", {
      parts: [{ ...parts[0], reasonCode: "launcher-not-set-up" }, parts[1], parts[2]],
    }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Task 2 Test 4 (run errors)", () => {
  it("maps every RUN_ERROR_CODES member to a run-<code> scheduler reason", () => {
    const expected: Record<RunErrorCode, SubsystemStatus> = {
      "summariser-unconfigured": "setup-needed",
      "summariser-failed": "degraded",
      "summariser-refused": "degraded",
      "summariser-invalid-output": "degraded",
      "all-sources-failed": "degraded",
      "vault-write-failed": "degraded",
      interrupted: "unknown",
    };
    for (const code of RUN_ERROR_CODES) {
      expect(SCHEDULER_REASON_STATUS[`run-${code}`], code).toBe(expected[code]);
    }
    expect(Object.keys(expected).sort()).toEqual([...RUN_ERROR_CODES].sort());
  });

  it("fails the build when a run error code has no reason (compile-time check)", () => {
    // If a RunErrorCode is added without a `run-<code>` entry, this assignment stops compiling.
    const covered: Record<`run-${RunErrorCode}`, SubsystemStatus> = SCHEDULER_REASON_STATUS;
    expect(Object.keys(covered).length).toBeGreaterThanOrEqual(RUN_ERROR_CODES.length);
  });
});

describe("Task 2 Test 5 (setup actions)", () => {
  it("accepts the three closed kinds with their ids", () => {
    for (const command of SETUP_COMMAND_IDS) {
      expect(SetupActionSchema.safeParse({ kind: "copy-command", command }).success).toBe(true);
    }
    expect([...SETUP_COMMAND_IDS]).toEqual([
      "claude-hooks-install",
      "codex-hooks-install",
      "codex-bridge-install",
      "research-key-setup",
    ]);
    for (const section of [...SETTINGS_SECTION_IDS, "research"]) {
      expect(SetupActionSchema.safeParse({ kind: "go-to-section", section }).success).toBe(true);
    }
    expect([...SETTINGS_SECTION_IDS]).toEqual([
      "projects",
      "launchers",
      "integrations",
      "approvals-tasks",
      "paths",
      "visual",
      "security",
      "schedules",
      "diagnostics",
    ]);
    expect(
      SetupActionSchema.safeParse({ kind: "run-plugin-command", command: "vault-setup" }).success,
    ).toBe(true);
  });

  it("refuses command text, an unknown id or section, an unknown plugin command and a fourth kind", () => {
    const bad: unknown[] = [
      { kind: "copy-command", command: "claude-hooks-install", text: "./scripts/x.sh" },
      { kind: "copy-command", command: "./scripts/claude-hooks/install.sh" },
      { kind: "copy-command", command: "rm -rf /" },
      { kind: "go-to-section", section: "elsewhere" },
      { kind: "run-plugin-command", command: "format-disk" },
      { kind: "open-url", url: "https://example.com" },
      { kind: "go-to-section" },
    ];
    for (const value of bad) {
      expect(SetupActionSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("carries a setup action on a row and on a part", () => {
    const response = freshInstall();
    response.rows[1] = row("hooks", "hooks-not-installed", {
      setupAction: { kind: "copy-command", command: "claude-hooks-install" },
    }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);

    const onPart = collectorsResponse({
      parts: collectorParts({ "status-line": "statusline-not-installed" }).map((p) =>
        p.partId === "status-line"
          ? { ...p, setupAction: { kind: "copy-command", command: "claude-hooks-install" } }
          : p,
      ),
      status: "ok",
      reasonCode: "telemetry-ok",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(onPart).success).toBe(true);
  });
});

describe("Task 2 Test 6 (no free text)", () => {
  it.each(["message", "error", "reason", "path", "detail", "stderr"])(
    "refuses a row that carries a %s key",
    (key) => {
      const response = freshInstall();
      response.rows[0] = { ...response.rows[0], [key]: "/Users/USERNAME/vault" } as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
    },
  );

  it("accepts typed facts and nothing else", () => {
    const facts = {
      claudeVersion: "2.1.5",
      minimumVersion: "2.0.0",
      dropCount: 3,
      dropsSince: T0,
      lastDropAt: T0,
      silenceThresholdMs: 600000,
      sourceCount: 4,
      lastSuccessAt: T0,
      lastFailureAt: T0,
    };
    const response = freshInstall();
    response.rows[1] = row("hooks", "hooks-not-installed", { facts }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);

    const refused: Record<string, unknown>[] = [
      { claudeVersion: "/Users/USERNAME/bin/claude" },
      { claudeVersion: "version 2.1.5 (Claude Code)" },
      { minimumVersion: "latest" },
      { dropCount: -1 },
      { dropCount: 1.5 },
      { dropsSince: "yesterday" },
      { lastDropAt: "yesterday" },
      { lastDropAt: "2026-10-22" },
      // FIX2A F2: free text after a version number is not a version; only alpha, beta and rc are words.
      { claudeVersion: "2.1.5-SomeName" },
      { minimumVersion: "2.0.0-beta.x" },
      { silenceThresholdMs: "10 minutes" },
      { sourceCount: "4" },
      { lastSuccessAt: "2026-10-22" },
      { note: "free text" },
      { path: "~/x" },
    ];
    for (const bad of refused) {
      const r = freshInstall();
      r.rows[1] = row("hooks", "hooks-not-installed", { facts: { ...facts, ...bad } }) as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses an absolute or control-character path and a non-display string anywhere in paths", () => {
    for (const vault of ["/Users/USERNAME/vault", "vault", "~/ok\u0000", "https://example.com"]) {
      const r = freshInstall();
      r.paths.vault = vault as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, vault).toBe(false);
    }
  });

  it("refuses a service block or counts with free text, a negative or a fractional count", () => {
    const a = freshInstall();
    (a.service as Record<string, unknown>).version = "latest build";
    expect(DiagnosticsHealthResponseSchema.safeParse(a).success).toBe(false);
    const b = freshInstall();
    (b.counts as Record<string, unknown>).projects = -1;
    expect(DiagnosticsHealthResponseSchema.safeParse(b).success).toBe(false);
    const c = freshInstall();
    (c.keychain as Record<string, unknown>).researchKey = "sk-ant-secret";
    expect(DiagnosticsHealthResponseSchema.safeParse(c).success).toBe(false);
  });

  it("admits a null store schema version (08-07: an empty table is unknown, never zero) and nothing but an integer or null", () => {
    const ok = freshInstall();
    (ok.service as Record<string, unknown>).storeSchemaVersion = null;
    expect(DiagnosticsHealthResponseSchema.safeParse(ok).success).toBe(true);
    for (const bad of [-1, 1.5, "12", undefined]) {
      const r = freshInstall();
      (r.service as Record<string, unknown>).storeSchemaVersion = bad;
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, String(bad)).toBe(false);
    }
  });
});

describe("Task 2 Test 6b (vault fingerprint, D-36)", () => {
  const salt = "0123456789abcdef0123456789abcdef";
  const digest = "fedcba9876543210";

  it("is null or a 32-hex salt and 16-hex digest", () => {
    expect(VaultFingerprintSchema.safeParse(null).success).toBe(true);
    expect(VaultFingerprintSchema.safeParse({ salt, digest }).success).toBe(true);
    const r = freshInstall();
    (r as Record<string, unknown>).vaultFingerprint = { salt, digest };
    expect(DiagnosticsHealthResponseSchema.safeParse(r).success).toBe(true);
  });

  it("refuses path-shaped, longer, shorter, uppercase and extra-key values", () => {
    const bad: unknown[] = [
      { salt, digest: "/Users/USERNAME/vault" },
      { salt, digest: `${digest}0` },
      { salt, digest: digest.slice(1) },
      { salt: salt.toUpperCase(), digest },
      { salt: `${salt}0`, digest },
      { salt, digest, path: "~/vault" },
      { salt },
      "fedcba9876543210",
    ];
    for (const value of bad) {
      expect(VaultFingerprintSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("Task 2 Test 7 (display map)", () => {
  it("holds the five words, glyphs and meaning lines of the UI-SPEC", () => {
    expect(SUBSYSTEM_STATUS_DISPLAY).toEqual({
      ok: { word: "Working", glyph: "✓", meaning: "Checked and behaving as expected." },
      "setup-needed": {
        word: "Needs setup",
        glyph: "⊕",
        meaning: "Not set up yet. Nothing is wrong; the next step is shown.",
      },
      degraded: {
        word: "Degraded",
        glyph: "▽",
        meaning: "Working, but with a problem that reduces what you see.",
      },
      failing: {
        word: "Failing",
        glyph: "✕",
        meaning: "Not working. The reason and the fix are shown.",
      },
      unknown: {
        word: "Unknown",
        glyph: "?",
        meaning: "Couldn't be checked, or no evidence yet. Never assumed working.",
      },
    });
    expect(Object.keys(SUBSYSTEM_STATUS_DISPLAY).sort()).toEqual([...SUBSYSTEM_STATUSES].sort());
  });

  it("uses five distinct glyphs, a disjoint not-in-version glyph and a ten-minute silence threshold", () => {
    const glyphs = Object.values(SUBSYSTEM_STATUS_DISPLAY).map((d) => d.glyph);
    expect(new Set(glyphs).size).toBe(5);
    expect(NOT_IN_VERSION_GLYPH).toBe("∅");
    expect(glyphs).not.toContain(NOT_IN_VERSION_GLYPH);
    expect(HOOK_SILENT_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });
});

describe("Task 2: the closed error body", () => {
  it("lists the four codes and refuses another code or an extra key", () => {
    expect([...DIAGNOSTICS_ERROR_CODES]).toEqual([
      "service-disconnected",
      "timeout",
      "internal",
      "unrecognised-response",
    ]);
    for (const code of DIAGNOSTICS_ERROR_CODES) {
      expect(DiagnosticsErrorBodySchema.safeParse({ error: code }).success).toBe(true);
    }
    expect(DiagnosticsErrorBodySchema.safeParse({ error: "boom" }).success).toBe(false);
    expect(
      DiagnosticsErrorBodySchema.safeParse({ error: "internal", message: "/Users/you" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-34a: passive parts do not lift a setup-needed row (D-34 vs D-06)

describe("D-34a (passive parts)", () => {
  const PASSIVE = ["telemetry", "spool"];

  it("the passive collectors parts are exactly telemetry and spool", () => {
    expect([...COLLECTORS_PASSIVE_PART_IDS]).toEqual(PASSIVE);
  });

  it("the passive scheduler part is exactly sources, so a fresh scheduler reads setup-needed", () => {
    expect([...SCHEDULER_PASSIVE_PART_IDS]).toEqual(["sources"]);
    const parts = [
      { partId: "last-run", status: "setup-needed", reasonCode: "never-run" },
      { partId: "research-key", status: "setup-needed", reasonCode: "research-key-missing" },
      { partId: "sources", status: "ok", reasonCode: "sources-configured" },
    ] as const;
    expect(rollupPartStatuses(parts, SCHEDULER_PASSIVE_PART_IDS)).toBe("setup-needed");
    const run = [
      { ...parts[0], status: "ok", reasonCode: "last-run-succeeded" } as const,
      parts[1],
      parts[2],
    ];
    expect(rollupPartStatuses(run, SCHEDULER_PASSIVE_PART_IDS)).toBe("ok");
    const broken = [
      parts[0],
      parts[1],
      { ...parts[2], status: "degraded", reasonCode: "sources-config-unusable" } as const,
    ];
    expect(rollupPartStatuses(broken, SCHEDULER_PASSIVE_PART_IDS)).toBe("degraded");
  });

  it("a row whose non-passive parts are all setup-needed reads setup-needed despite passive ok parts", () => {
    const parts = freshCollectorsParts();
    expect(rollupPartStatuses(parts, PASSIVE)).toBe("setup-needed");
  });

  it("the fresh-install collectors row of 08-08 Task 1 Test 1 is accepted as setup-needed", () => {
    const response = collectorsResponse({
      parts: freshCollectorsParts(),
      status: "setup-needed",
      reasonCode: "statusline-not-installed",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    // The whole fresh-install response, with the real parts, parses and summarises as four setup states
    // (the scheduler's default sources are configured, so its row is ok).
    const fresh = freshInstall();
    expect(DiagnosticsHealthResponseSchema.safeParse(fresh).success).toBe(true);
    expect(summariseRows(fresh.rows).setupNeeded).toBe(5);
    // The old ok roll-up is now refused for those parts.
    const asOk = collectorsResponse({
      parts: freshCollectorsParts(),
      status: "ok",
      reasonCode: "telemetry-ok",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(asOk).success).toBe(false);
  });

  it("an active ok part still lifts the row: one working Codex part makes it ok", () => {
    const parts = freshCollectorsParts().map((p) =>
      p.partId === "codex-install"
        ? { ...p, status: "ok" as const, reasonCode: "codex-installed" }
        : p,
    );
    expect(rollupPartStatuses(parts, PASSIVE)).toBe("ok");
    const response = collectorsResponse({ parts, status: "ok", reasonCode: "codex-installed" });
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
  });

  it("a row that is entirely passive-ok reads ok", () => {
    expect(
      rollupPartStatuses(
        [
          { partId: "telemetry", status: "ok" },
          { partId: "spool", status: "ok" },
        ],
        PASSIVE,
      ),
    ).toBe("ok");
  });

  it("a passive part that is degraded, failing or unknown still raises the row", () => {
    const withPassive = (partId: string, status: SubsystemStatus) =>
      freshCollectorsParts().map((p) => (p.partId === partId ? { ...p, status } : p));
    expect(rollupPartStatuses(withPassive("spool", "degraded"), PASSIVE)).toBe("degraded");
    expect(rollupPartStatuses(withPassive("telemetry", "failing"), PASSIVE)).toBe("failing");
    expect(rollupPartStatuses(withPassive("telemetry", "unknown"), PASSIVE)).toBe("unknown");

    const degraded = collectorsResponse({
      parts: freshCollectorsParts().map((p) =>
        p.partId === "spool"
          ? { ...p, status: "degraded", reasonCode: "spool-dropped-records" }
          : p,
      ),
      status: "degraded",
      reasonCode: "spool-dropped-records",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(degraded).success).toBe(true);
  });

  it("no parts at all is unknown, and a launchers mix of ok and setup-needed is still ok", () => {
    expect(rollupPartStatuses([], PASSIVE)).toBe("unknown");
    expect(
      rollupPartStatuses(
        [
          { partId: "antigravity", status: "ok" },
          { partId: "claude-code", status: "setup-needed" },
          { partId: "claude-desktop", status: "setup-needed" },
          { partId: "codex", status: "setup-needed" },
        ],
        [],
      ),
    ).toBe("ok");

    const part = (partId: string, reasonCode: string, status: SubsystemStatus) => ({
      partId,
      status,
      reasonCode,
    });
    const parts = [
      part("antigravity", "launcher-ready", "ok"),
      part("claude-code", "launcher-not-set-up", "setup-needed"),
      part("claude-desktop", "launcher-not-set-up", "setup-needed"),
      part("codex", "launcher-not-set-up", "setup-needed"),
    ];
    const response = freshInstall();
    response.rows[4] = row("launchers", "launcher-ready", { parts, status: "ok" }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    response.rows[4] = row("launchers", "launcher-not-set-up", { parts }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
  });

  it("scheduler has no passive parts: ok with a setup-needed part stays ok", () => {
    expect(
      rollupPartStatuses(
        [
          { partId: "last-run", status: "setup-needed" },
          { partId: "research-key", status: "setup-needed" },
          { partId: "sources", status: "ok" },
        ],
        [],
      ),
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// FIX1A

describe("FIX1A M2: the scheduler key-not-checked reason and the health trigger", () => {
  it("research-key-not-checked is a scheduler reason with status unknown, and a research-key part may carry it", () => {
    expect(SCHEDULER_REASONS).toContain("research-key-not-checked");
    expect(SCHEDULER_REASON_STATUS["research-key-not-checked"]).toBe("unknown");
    const parts = [
      { partId: "last-run", status: "setup-needed", reasonCode: "never-run" },
      { partId: "research-key", status: "unknown", reasonCode: "research-key-not-checked" },
      { partId: "sources", status: "ok", reasonCode: "sources-configured" },
    ];
    const response = freshInstall();
    // Roll-up: unknown beats ok; the deciding part is the key.
    response.rows[3] = row("scheduler", "research-key-not-checked", {
      status: "unknown",
      parts,
    }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    // Not a valid reason on another scheduler part.
    const wrongPart = freshInstall();
    wrongPart.rows[3] = row("scheduler", "research-key-not-checked", {
      status: "unknown",
      parts: [
        { partId: "last-run", status: "unknown", reasonCode: "research-key-not-checked" },
        parts[1],
        parts[2],
      ],
    }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongPart).success).toBe(false);
  });

  it("HealthTriggerSchema is exactly gesture or reconnect", () => {
    expect(HealthTriggerSchema.options).toEqual(["gesture", "reconnect"]);
    expect(HealthTriggerSchema.safeParse("gesture").success).toBe(true);
    expect(HealthTriggerSchema.safeParse("reconnect").success).toBe(true);
    for (const bad of ["", "Gesture", "timer", undefined, null, 1]) {
      expect(HealthTriggerSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe("FIX1A M3: a row of parts needs its parts unless the probe did not finish", () => {
  const cases = [
    { index: 2, id: "collectors", ok: "telemetry-ok" },
    { index: 3, id: "scheduler", ok: "last-run-succeeded" },
    { index: 4, id: "launchers", ok: "launcher-ready" },
  ] as const;

  it.each(cases)("$id: a parts-less $ok row claiming ok is refused", ({ index, id, ok }) => {
    const response = freshInstall();
    response.rows[index] = row(id, ok, { status: "ok" }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
  });

  it.each(cases)(
    "$id: a parts-less not-set-up or other own-reason row is refused",
    ({ index, id }) => {
      const own = {
        collectors: "statusline-not-installed",
        scheduler: "never-run",
        launchers: "launcher-not-set-up",
      }[id];
      const response = freshInstall();
      response.rows[index] = row(id, own) as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
    },
  );

  it.each(cases)("$id: a parts-less probe-did-not-finish row is accepted", ({ index, id }) => {
    for (const reason of ["probe-timeout", "probe-error", "subsystem-not-wired"]) {
      const response = freshInstall();
      response.rows[index] = row(id, reason, { status: "unknown" }) as never;
      expect(DiagnosticsHealthResponseSchema.safeParse(response).success, reason).toBe(true);
    }
  });

  it("vault and hooks rows stay parts-less by design", () => {
    expect(DiagnosticsHealthResponseSchema.safeParse(freshInstall()).success).toBe(true);
  });
});

describe("FIX1A MINOR 3: an unrecognised status is unknown, never ok", () => {
  it("summariseRows counts it as unknown", () => {
    const rows = [{ status: "ok" }, { status: "bogus" }, { status: undefined }, { status: "fine" }];
    expect(summariseRows(rows as never)).toEqual({
      failing: 0,
      degraded: 0,
      unknown: 3,
      setupNeeded: 0,
      ok: 1,
    });
  });

  it("rollupStatus reads an unrecognised status as unknown, and it still loses to degraded or failing", () => {
    expect(rollupStatus(["bogus"] as never)).toBe("unknown");
    expect(rollupStatus(["ok", "bogus"] as never)).toBe("unknown");
    expect(rollupStatus(["setup-needed", "bogus"] as never)).toBe("unknown");
    expect(rollupStatus(["degraded", "bogus"] as never)).toBe("degraded");
    expect(rollupStatus(["failing", "bogus"] as never)).toBe("failing");
  });
});

describe("FIX1A MINOR 4: service-side reasons are separate from the plugin-overlay-only ones", () => {
  it("lists the three overlay-only codes", () => {
    expect([...OVERLAY_ONLY_REASONS].sort()).toEqual(
      ["service-not-running", "vault-check-unavailable", "vault-mismatch"].sort(),
    );
  });

  it("the full lists still hold every reason, so the plugin's copy table covers the overlay", () => {
    for (const code of OVERLAY_ONLY_REASONS) {
      const holders = [
        VAULT_REASONS,
        HOOKS_REASONS,
        COLLECTORS_REASONS,
        SCHEDULER_REASONS,
        LAUNCHERS_REASONS,
      ].filter((list) => (list as readonly string[]).includes(code));
      expect(holders.length, code).toBeGreaterThan(0);
    }
    expect(VAULT_REASONS).toContain("vault-mismatch");
    expect(VAULT_REASONS).toContain("vault-check-unavailable");
    for (const list of [
      VAULT_REASONS,
      HOOKS_REASONS,
      COLLECTORS_REASONS,
      SCHEDULER_REASONS,
      LAUNCHERS_REASONS,
    ]) {
      expect(list).toContain("service-not-running");
    }
  });

  it("the service-side lists are the full lists minus the overlay-only codes", () => {
    const full = {
      vault: VAULT_REASONS,
      hooks: HOOKS_REASONS,
      collectors: COLLECTORS_REASONS,
      scheduler: SCHEDULER_REASONS,
      launchers: LAUNCHERS_REASONS,
    };
    for (const [id, all] of Object.entries(full)) {
      const service = SERVICE_SIDE_REASONS[id as keyof typeof SERVICE_SIDE_REASONS];
      const expected = (all as readonly string[]).filter(
        (code) => !(OVERLAY_ONLY_REASONS as readonly string[]).includes(code),
      );
      expect([...service], id).toEqual(expected);
    }
  });

  it.each([
    [0, "vault", "vault-mismatch", "degraded"],
    [0, "vault", "vault-check-unavailable", "unknown"],
    [0, "vault", "service-not-running", "unknown"],
    [1, "hooks", "service-not-running", "unknown"],
    [2, "collectors", "service-not-running", "unknown"],
    [3, "scheduler", "service-not-running", "unknown"],
    [4, "launchers", "service-not-running", "unknown"],
  ] as const)("the service response refuses row %i (%s) with %s", (index, id, reason, status) => {
    const response = freshInstall();
    response.rows[index] = row(id, reason, { status }) as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(false);
  });

  it("the plugin's overlay type allows the overlay-only reasons (compile-time)", () => {
    const cleared: DisplayedRow = {
      id: "hooks",
      status: "unknown",
      reasonCode: "service-not-running",
      checkedAt: T0,
      freshness: "unavailable",
    };
    const mismatch: DisplayedRow = {
      id: "vault",
      status: "degraded",
      reasonCode: "vault-mismatch",
      checkedAt: T0,
      freshness: "live",
    };
    expect([cleared.reasonCode, mismatch.reasonCode]).toEqual([
      "service-not-running",
      "vault-mismatch",
    ]);
  });
});

describe("FIX6A M1: the shared health staleness window", () => {
  it("is five minutes, one constant for the service and the plugin", () => {
    expect(HEALTH_STALE_AFTER_MS).toBe(5 * 60 * 1000);
  });
});

describe("09-19 Task 1: the approval presence members of the health response (D-04)", () => {
  it("Test 1: approvalPresence parses for each closed state; any other value is refused; absent still parses", () => {
    for (const state of ["available", "unavailable", "unknown"]) {
      const r = { ...freshInstall(), approvalPresence: state };
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, state).toBe(true);
    }
    expect(DiagnosticsHealthResponseSchema.safeParse(freshInstall()).success).toBe(true);
    for (const bad of ["Available", "yes", "", 1, null, true, "available "]) {
      const r = { ...freshInstall(), approvalPresence: bad };
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, String(bad)).toBe(false);
    }
  });

  it("keeps the subsystem ids at six and the row tuple unchanged", () => {
    expect(SUBSYSTEM_IDS).toEqual([
      "service",
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(APPROVAL_PRESENCE_STATES).toEqual(["available", "unavailable", "unknown"]);
  });

  it("Test 1b: the reason is one of the closed codes, never free text", () => {
    for (const reason of APPROVAL_PRESENCE_REASONS) {
      const r = {
        ...freshInstall(),
        approvalPresence: "unavailable",
        approvalPresenceReason: reason,
      };
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, reason).toBe(true);
    }
    for (const bad of ["no touch id here", "", null, 3, "Not-Enrolled"]) {
      const r = { ...freshInstall(), approvalPresence: "unavailable", approvalPresenceReason: bad };
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, String(bad)).toBe(false);
    }
  });

  it("Test 1c: the pin fingerprint is exactly eight lowercase hex characters", () => {
    const ok = {
      ...freshInstall(),
      approvalPresence: "available",
      approvalPresencePin: "0a1b2c3d",
    };
    expect(DiagnosticsHealthResponseSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      "0A1B2C3D",
      "0a1b2c3",
      "0a1b2c3d4",
      "zzzzzzzz",
      "MIIBIjAN",
      null,
      12345678,
    ]) {
      const r = { ...freshInstall(), approvalPresence: "available", approvalPresencePin: bad };
      expect(DiagnosticsHealthResponseSchema.safeParse(r).success, String(bad)).toBe(false);
    }
  });
});
