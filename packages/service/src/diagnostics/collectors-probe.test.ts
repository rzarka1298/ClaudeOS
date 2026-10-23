import {
  COLLECTORS_PART_IDS,
  COLLECTORS_PASSIVE_PART_IDS,
  type CodexIntegrationStatus,
  rollupPartStatuses,
  type SubsystemStatus,
} from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import {
  claudeStatus,
  codexStatus,
  isValidRow,
  partsOf,
} from "../test-support/diagnostics-probe-fixtures.js";
import {
  type CollectorsProbePorts,
  probeCollectors,
  SPOOL_DROP_WINDOW_MS,
  type SpoolFacts,
} from "./collectors-probe.js";

/**
 * Plan 08-08 Task 1 (D-04, D-37, D-41; T-08-19, T-08-21): the collectors row projects the same
 * Claude status as the hooks row into telemetry, status line, transcript analysis and spool parts,
 * plus the four Codex parts from the cached Codex status. It never refreshes Codex, never runs
 * `codex doctor`, spawns nothing and returns no path.
 */

const NOW = new Date("2026-10-22T09:00:00.000Z");
const SIGNAL = new AbortController().signal;

function ports(
  claude: Parameters<typeof claudeStatus>[0],
  codex: CodexIntegrationStatus = codexStatus(),
  extra: Partial<CollectorsProbePorts> = {},
): CollectorsProbePorts {
  return {
    integration: async () => claudeStatus(claude),
    spoolFacts: async () => ({ count: 0, lastDropAt: null }),
    // Only a `status()` read exists on the port; anything else is a failure of the test.
    codexStatus: new Proxy(
      { status: () => codex },
      {
        get(target, property) {
          if (property === "status") return target.status;
          throw new Error(`the collectors probe touched ${String(property)} on the Codex port`);
        },
      },
    ),
    minimumClaudeVersion: "2.1.214",
    now: () => NOW,
    ...extra,
  };
}

function byId(outcome: Awaited<ReturnType<typeof probeCollectors>>, partId: string) {
  const part = partsOf(outcome).find((candidate) => candidate.partId === partId);
  if (part === undefined) throw new Error(`no part ${partId}`);
  return part;
}

describe("Test 1 (tracer): a fresh install", () => {
  it("reads setup-needed with the eight parts, the passive ones ok, and the row equal to the roll-up", async () => {
    const outcome = await probeCollectors(ports({}), SIGNAL);
    expect(outcome).toEqual({
      id: "collectors",
      status: "setup-needed",
      reasonCode: "statusline-not-installed",
      setupAction: { kind: "copy-command", command: "claude-hooks-install" },
      parts: [
        { partId: "telemetry", status: "ok", reasonCode: "telemetry-ok" },
        {
          partId: "status-line",
          status: "setup-needed",
          reasonCode: "statusline-not-installed",
          setupAction: { kind: "copy-command", command: "claude-hooks-install" },
        },
        {
          partId: "transcript-analysis",
          status: "setup-needed",
          reasonCode: "analysis-off",
          setupAction: { kind: "go-to-section", section: "security" },
        },
        { partId: "spool", status: "ok", reasonCode: "spool-clean" },
        { partId: "codex-install", status: "setup-needed", reasonCode: "codex-not-installed" },
        {
          partId: "codex-hooks",
          status: "setup-needed",
          reasonCode: "codex-hooks-not-installed",
          setupAction: { kind: "copy-command", command: "codex-hooks-install" },
        },
        {
          partId: "codex-bridge",
          status: "setup-needed",
          reasonCode: "codex-bridge-not-installed",
          setupAction: { kind: "copy-command", command: "codex-bridge-install" },
        },
        {
          partId: "codex-doctor",
          status: "setup-needed",
          reasonCode: "codex-doctor-not-run",
          // D-44: `Check Codex health` lives in the launchers section, so the service says so.
          setupAction: { kind: "go-to-section", section: "launchers" },
        },
      ],
    });
    expect(isValidRow(outcome)).toBe(true);
    const parts = partsOf(outcome) as unknown as { partId: string; status: SubsystemStatus }[];
    expect(parts.map((part) => part.partId)).toEqual([...COLLECTORS_PART_IDS]);
    expect(outcome).toMatchObject({
      status: rollupPartStatuses(parts, COLLECTORS_PASSIVE_PART_IDS),
    });
  });

  it("lifts the row to ok when a non-passive part works and nothing is wrong", async () => {
    const outcome = await probeCollectors(
      ports(
        {
          statusLine: "installed",
          statusLineReported: true,
          transcriptAnalysis: { enabled: true },
        },
        codexStatus({
          codex: { installed: true, version: "0.45.0" },
          hooks: { state: "installed" },
          bridge: { state: "installed" },
          doctor: { overall: "ok", codexVersion: null, checks: [] },
        }),
      ),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ status: "ok" });
    expect(partsOf(outcome).every((part) => part.status === "ok")).toBe(true);
    expect(isValidRow(outcome)).toBe(true);
  });
});

describe("Test 3: telemetry", () => {
  it("shape-changed is degraded and the row follows it", async () => {
    const outcome = await probeCollectors(
      ports({ telemetry: { kind: "shape-changed", version: "2.2.0" } }),
      SIGNAL,
    );
    expect(byId(outcome, "telemetry")).toMatchObject({
      status: "degraded",
      reasonCode: "telemetry-shape-changed",
    });
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "telemetry-shape-changed" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("an unsupported version carries the dotted claude and minimum versions as facts", async () => {
    const outcome = await probeCollectors(
      ports({ telemetry: { kind: "unsupported-version", version: "2.0.9" } }),
      SIGNAL,
    );
    expect(byId(outcome, "telemetry")).toEqual({
      partId: "telemetry",
      status: "degraded",
      reasonCode: "telemetry-unsupported-version",
      facts: { claudeVersion: "2.0.9", minimumVersion: "2.1.214" },
    });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("leaves out a version that is not dotted rather than failing the row or echoing free text", async () => {
    const outcome = await probeCollectors(
      ports({ telemetry: { kind: "unsupported-version", version: "/Users/USERNAME/bin/claude" } }),
      SIGNAL,
    );
    const part = byId(outcome, "telemetry");
    expect(part).toMatchObject({ reasonCode: "telemetry-unsupported-version" });
    expect(JSON.stringify(part)).not.toContain("USERNAME");
    expect(isValidRow(outcome)).toBe(true);
  });
});

describe("Test 3b: status line and transcript analysis", () => {
  it("maps the status line states", async () => {
    const reporting = await probeCollectors(
      ports({ statusLine: "installed", statusLineReported: true }),
      SIGNAL,
    );
    expect(byId(reporting, "status-line")).toMatchObject({
      status: "ok",
      reasonCode: "statusline-reporting",
    });
    const waiting = await probeCollectors(
      ports({ statusLine: "installed", statusLineReported: false }),
      SIGNAL,
    );
    expect(byId(waiting, "status-line")).toMatchObject({
      status: "unknown",
      reasonCode: "statusline-awaiting-report",
    });
    const unreadable = await probeCollectors(ports({ statusLine: "unknown" }), SIGNAL);
    expect(byId(unreadable, "status-line")).toMatchObject({
      status: "unknown",
      reasonCode: "statusline-state-unreadable",
    });
    for (const outcome of [reporting, waiting, unreadable]) expect(isValidRow(outcome)).toBe(true);
  });

  it("transcript analysis on is ok with no action", async () => {
    const on = await probeCollectors(ports({ transcriptAnalysis: { enabled: true } }), SIGNAL);
    expect(byId(on, "transcript-analysis")).toEqual({
      partId: "transcript-analysis",
      status: "ok",
      reasonCode: "analysis-on",
    });
  });
});

describe("Test 4 (spool, D-37a): stateless and independent of the trigger", () => {
  const HOUR = 60 * 60_000;
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  const spoolOf = async (facts: SpoolFacts, at: Date = NOW) =>
    byId(
      await probeCollectors(
        ports({}, codexStatus(), { spoolFacts: async () => facts, now: () => at }),
        SIGNAL,
      ),
      "spool",
    );

  it("reads clean, with no facts, when nothing was dropped", async () => {
    expect(await spoolOf({ count: 0, lastDropAt: null })).toEqual({
      partId: "spool",
      status: "ok",
      reasonCode: "spool-clean",
    });
  });

  it("drops made while the service was down read degraded on the very first probe (no baseline to consume)", async () => {
    expect(await spoolOf({ count: 40, lastDropAt: ago(2 * HOUR) })).toEqual({
      partId: "spool",
      status: "degraded",
      reasonCode: "spool-dropped-records",
      facts: { dropCount: 40, lastDropAt: ago(2 * HOUR) },
    });
  });

  it("a second probe, a reconnect or a restart does not consume it: the same file reads the same", async () => {
    const facts = { count: 40, lastDropAt: ago(HOUR) };
    const first = await spoolOf(facts);
    const second = await spoolOf(facts, new Date(NOW.getTime() + 5 * 60_000));
    expect(second).toEqual(first);
    expect(second).toMatchObject({ status: "degraded", reasonCode: "spool-dropped-records" });
  });

  it("the window is 24 hours: 24 hours exactly is still degraded, a millisecond more reads clean with the count kept", async () => {
    expect(SPOOL_DROP_WINDOW_MS).toBe(24 * HOUR);
    expect(await spoolOf({ count: 7, lastDropAt: ago(24 * HOUR) })).toMatchObject({
      status: "degraded",
      reasonCode: "spool-dropped-records",
    });
    expect(await spoolOf({ count: 7, lastDropAt: ago(25 * HOUR) })).toEqual({
      partId: "spool",
      status: "ok",
      reasonCode: "spool-clean",
      facts: { dropCount: 7, lastDropAt: ago(25 * HOUR) },
    });
    expect(await spoolOf({ count: 7, lastDropAt: ago(24 * HOUR + 1) })).toMatchObject({
      reasonCode: "spool-clean",
    });
  });

  it("a drop stamped in the future (clock skew) is not hidden", async () => {
    expect(
      await spoolOf({ count: 3, lastDropAt: new Date(NOW.getTime() + HOUR).toISOString() }),
    ).toMatchObject({ reasonCode: "spool-dropped-records" });
  });

  it("a non-empty file with no usable time cannot be said to be recent: clean, with the count kept", async () => {
    expect(await spoolOf({ count: 9, lastDropAt: null })).toEqual({
      partId: "spool",
      status: "ok",
      reasonCode: "spool-clean",
      facts: { dropCount: 9 },
    });
    expect(await spoolOf({ count: 9, lastDropAt: "not a time" })).toMatchObject({
      reasonCode: "spool-clean",
      facts: { dropCount: 9 },
    });
  });

  it("the degraded spool lifts the row to degraded; rows built from it are valid rows", async () => {
    const outcome = await probeCollectors(
      ports({}, codexStatus(), {
        spoolFacts: async () => ({ count: 12, lastDropAt: ago(HOUR) }),
      }),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "spool-dropped-records" });
    expect(isValidRow(outcome)).toBe(true);
  });

  it("a spool read that fails reads probe-error on the spool part only, with no message", async () => {
    const outcome = await probeCollectors(
      ports({}, codexStatus(), {
        spoolFacts: () => Promise.reject(new Error("EACCES: /Users/USERNAME/spool")),
      }),
      SIGNAL,
    );
    expect(byId(outcome, "spool")).toEqual({
      partId: "spool",
      status: "unknown",
      reasonCode: "probe-error",
    });
    expect(JSON.stringify(outcome)).not.toContain("USERNAME");
    expect(isValidRow(outcome)).toBe(true);
  });

  it("the module keeps no baseline between probes (no tracker is exported)", async () => {
    const module = await import("./collectors-probe.js");
    expect(Object.keys(module)).not.toContain("createSpoolDropTracker");
  });
});

describe("Test 5: the Codex parts", () => {
  const cases: readonly {
    name: string;
    codex: CodexIntegrationStatus;
    part: string;
    status: string;
    reason: string;
  }[] = [
    {
      name: "installed",
      codex: codexStatus({ codex: { installed: true, version: "0.45.0" } }),
      part: "codex-install",
      status: "ok",
      reason: "codex-installed",
    },
    {
      name: "not installed",
      codex: codexStatus(),
      part: "codex-install",
      status: "setup-needed",
      reason: "codex-not-installed",
    },
    {
      name: "bridge installed",
      codex: codexStatus({ bridge: { state: "installed" } }),
      part: "codex-bridge",
      status: "ok",
      reason: "codex-bridge-ready",
    },
    {
      name: "bridge installed-idle",
      codex: codexStatus({ bridge: { state: "installed-idle" } }),
      part: "codex-bridge",
      status: "ok",
      reason: "codex-bridge-ready",
    },
    {
      name: "bridge outdated",
      codex: codexStatus({ bridge: { state: "outdated" } }),
      part: "codex-bridge",
      status: "degraded",
      reason: "codex-bridge-outdated",
    },
    {
      name: "bridge in a different folder",
      codex: codexStatus({ bridge: { state: "different-folder" } }),
      part: "codex-bridge",
      status: "degraded",
      reason: "codex-bridge-different-folder",
    },
    {
      name: "hooks receiving",
      codex: codexStatus({ hooks: { state: "installed" } }),
      part: "codex-hooks",
      status: "ok",
      reason: "codex-hooks-receiving",
    },
    {
      name: "hooks installed, no events",
      codex: codexStatus({ hooks: { state: "installed-no-events" } }),
      part: "codex-hooks",
      status: "unknown",
      reason: "codex-hooks-no-events",
    },
    {
      name: "hooks unreadable",
      codex: codexStatus({ hooks: { state: "unknown" } }),
      part: "codex-hooks",
      status: "unknown",
      reason: "codex-hooks-state-unreadable",
    },
    {
      name: "doctor ok",
      codex: codexStatus({ doctor: { overall: "ok", codexVersion: null, checks: [] } }),
      part: "codex-doctor",
      status: "ok",
      reason: "codex-doctor-ok",
    },
    {
      name: "doctor warning",
      codex: codexStatus({ doctor: { overall: "warning", codexVersion: null, checks: [] } }),
      part: "codex-doctor",
      status: "degraded",
      reason: "codex-doctor-warning",
    },
    {
      name: "doctor failed",
      codex: codexStatus({ doctor: { overall: "fail", codexVersion: null, checks: [] } }),
      part: "codex-doctor",
      status: "degraded",
      reason: "codex-doctor-failed",
    },
    {
      name: "doctor unrecognised",
      codex: codexStatus({ doctor: { overall: "unrecognised", codexVersion: null, checks: [] } }),
      part: "codex-doctor",
      status: "unknown",
      reason: "codex-doctor-unrecognised",
    },
    {
      name: "doctor never run",
      codex: codexStatus({ doctor: null }),
      part: "codex-doctor",
      status: "setup-needed",
      reason: "codex-doctor-not-run",
    },
  ];

  for (const entry of cases) {
    it(`${entry.name}: ${entry.part} reads ${entry.reason}`, async () => {
      const outcome = await probeCollectors(ports({}, entry.codex), SIGNAL);
      expect(byId(outcome, entry.part)).toMatchObject({
        status: entry.status,
        reasonCode: entry.reason,
      });
      expect(isValidRow(outcome)).toBe(true);
    });
  }

  it("a degraded Codex part raises the row, and the doctor warning points at the launchers section (D-44)", async () => {
    const outcome = await probeCollectors(
      ports({}, codexStatus({ doctor: { overall: "warning", codexVersion: null, checks: [] } })),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "codex-doctor-warning" });
    expect(byId(outcome, "codex-doctor")).toMatchObject({
      setupAction: { kind: "go-to-section", section: "launchers" },
    });
  });

  it("every codex-doctor reason that offers an action sends go-to-section launchers, and nothing else does", async () => {
    const overalls = ["warning", "fail"] as const;
    for (const overall of overalls) {
      const outcome = await probeCollectors(
        ports({}, codexStatus({ doctor: { overall, codexVersion: null, checks: [] } })),
        SIGNAL,
      );
      expect(byId(outcome, "codex-doctor")).toMatchObject({
        setupAction: { kind: "go-to-section", section: "launchers" },
      });
    }
    const notRun = await probeCollectors(ports({}, codexStatus({ doctor: null })), SIGNAL);
    expect(byId(notRun, "codex-doctor")).toMatchObject({
      reasonCode: "codex-doctor-not-run",
      setupAction: { kind: "go-to-section", section: "launchers" },
    });
    const ok = await probeCollectors(
      ports({}, codexStatus({ doctor: { overall: "ok", codexVersion: null, checks: [] } })),
      SIGNAL,
    );
    expect(byId(ok, "codex-doctor")).not.toHaveProperty("setupAction");
    // No integrations-section action is sent for a doctor reason any more.
    const text = JSON.stringify([notRun, ok]);
    expect(text).not.toContain('"section":"integrations"');
  });

  it("reads only status(): the fake Codex port throws on any other member", async () => {
    // `ports` wraps the Codex port in a Proxy that throws for anything but `status`.
    const outcome = await probeCollectors(ports({}), SIGNAL);
    expect(outcome.id).toBe("collectors");
  });

  it("returns no Codex version, doctor check id, path or timestamp", async () => {
    const outcome = await probeCollectors(
      ports(
        {},
        codexStatus({
          codex: { installed: true, version: "0.45.0" },
          bridge: { state: "installed", lastWindowAt: "2026-10-22T08:00:00.000Z" },
          hooks: {
            state: "installed",
            lastEventAt: "2026-10-22T08:30:00.000Z",
            installedSince: "2026-10-01T00:00:00.000Z",
          },
          doctor: {
            overall: "warning",
            codexVersion: "0.45.0",
            checks: [{ id: "auth.token", category: "auth", status: "warning" }],
          },
        }),
      ),
      SIGNAL,
    );
    const text = JSON.stringify(outcome);
    for (const forbidden of ["0.45.0", "auth.token", "2026-10-22T08", "2026-10-01"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("what the collectors probe is allowed to do", () => {
  it("reads the integration status once and reads probe-error, with no message, when it throws", async () => {
    const read = vi.fn(async () => claudeStatus({}));
    await probeCollectors(ports({}, codexStatus(), { integration: read }), SIGNAL);
    expect(read).toHaveBeenCalledTimes(1);

    const outcome = await probeCollectors(
      ports({}, codexStatus(), {
        integration: () =>
          Promise.reject(new Error("EACCES: /Users/USERNAME/.claude/settings.json")),
      }),
      SIGNAL,
    );
    expect(outcome).toEqual({ id: "collectors", status: "unknown", reasonCode: "probe-error" });
  });

  it("reads probe-timeout without reading anything when the signal has already aborted", async () => {
    const read = vi.fn(async () => claudeStatus({}));
    const controller = new AbortController();
    controller.abort();
    const outcome = await probeCollectors(
      ports({}, codexStatus(), { integration: read }),
      controller.signal,
    );
    expect(outcome).toEqual({ id: "collectors", status: "unknown", reasonCode: "probe-timeout" });
    expect(read).not.toHaveBeenCalled();
  });
});
