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
  createSpoolDropTracker,
  probeCollectors,
} from "./collectors-probe.js";

/**
 * Plan 08-08 Task 1 (D-04, D-37, D-41; T-08-19, T-08-21): the collectors row projects the same
 * Claude status as the hooks row into telemetry, status line, transcript analysis and spool parts,
 * plus the four Codex parts from the cached Codex status. It never refreshes Codex, never runs
 * `codex doctor`, spawns nothing and returns no path.
 */

const NOW = new Date("2026-10-22T09:00:00.000Z");
const LATER = new Date("2026-10-22T09:05:00.000Z");
const SIGNAL = new AbortController().signal;

function ports(
  claude: Parameters<typeof claudeStatus>[0],
  codex: CodexIntegrationStatus = codexStatus(),
  extra: Partial<CollectorsProbePorts> = {},
): CollectorsProbePorts {
  return {
    integration: () => claudeStatus(claude),
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
    spoolTracker: createSpoolDropTracker(),
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
          setupAction: { kind: "go-to-section", section: "integrations" },
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

describe("Test 4 (spool, D-37)", () => {
  it("the tracker reads clean for zero, degraded when the count rose, ok again for the same count, and keeps the first time", () => {
    const tracker = createSpoolDropTracker();
    const t0 = new Date("2026-10-22T09:00:00.000Z");
    const t1 = new Date("2026-10-22T09:01:00.000Z");
    const t2 = new Date("2026-10-22T09:02:00.000Z");
    const t3 = new Date("2026-10-22T09:03:00.000Z");
    expect(tracker.observe(0, t0)).toEqual({ count: 0, rose: false, since: null });
    expect(tracker.observe(40, t1)).toEqual({ count: 40, rose: true, since: t1.toISOString() });
    expect(tracker.observe(40, t2)).toEqual({ count: 40, rose: false, since: t1.toISOString() });
    expect(tracker.observe(90, t3)).toEqual({ count: 90, rose: true, since: t1.toISOString() });
  });

  it("treats the first observation as the baseline, whatever it is", () => {
    const tracker = createSpoolDropTracker();
    const at = new Date("2026-10-22T09:00:00.000Z");
    expect(tracker.observe(500, at)).toEqual({ count: 500, rose: false, since: at.toISOString() });
    expect(tracker.observe(500, new Date("2026-10-22T09:09:00.000Z"))).toMatchObject({
      rose: false,
    });
  });

  it("a shrinking count (the file was emptied) is not a rise, and zero reads clean", () => {
    const tracker = createSpoolDropTracker();
    tracker.observe(100, NOW);
    expect(tracker.observe(10, LATER)).toMatchObject({ count: 10, rose: false });
    expect(tracker.observe(0, LATER)).toMatchObject({ count: 0, rose: false });
  });

  it("through the probe: clean for none, degraded with dropCount and dropsSince on a rise, ok with the count kept the next time", async () => {
    const tracker = createSpoolDropTracker();
    let count = 0;
    let at = NOW;
    const make = () =>
      ports({}, codexStatus(), {
        spoolTracker: tracker,
        integration: () => claudeStatus({ spoolDropCount: count }),
        now: () => at,
      });

    const clean = await probeCollectors(make(), SIGNAL);
    expect(byId(clean, "spool")).toEqual({
      partId: "spool",
      status: "ok",
      reasonCode: "spool-clean",
    });

    count = 12;
    at = LATER;
    const rose = await probeCollectors(make(), SIGNAL);
    expect(byId(rose, "spool")).toEqual({
      partId: "spool",
      status: "degraded",
      reasonCode: "spool-dropped-records",
      facts: { dropCount: 12, dropsSince: LATER.toISOString() },
    });
    expect(rose).toMatchObject({ status: "degraded", reasonCode: "spool-dropped-records" });
    expect(isValidRow(rose)).toBe(true);

    at = new Date("2026-10-22T09:09:00.000Z");
    const same = await probeCollectors(make(), SIGNAL);
    expect(byId(same, "spool")).toEqual({
      partId: "spool",
      status: "ok",
      reasonCode: "spool-clean",
      facts: { dropCount: 12, dropsSince: LATER.toISOString() },
    });
    expect(isValidRow(same)).toBe(true);
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

  it("a degraded Codex part raises the row, and the doctor warning points at Integrations", async () => {
    const outcome = await probeCollectors(
      ports({}, codexStatus({ doctor: { overall: "warning", codexVersion: null, checks: [] } })),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "codex-doctor-warning" });
    expect(byId(outcome, "codex-doctor")).toMatchObject({
      setupAction: { kind: "go-to-section", section: "integrations" },
    });
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
    const read = vi.fn(() => claudeStatus({}));
    await probeCollectors(ports({}, codexStatus(), { integration: read }), SIGNAL);
    expect(read).toHaveBeenCalledTimes(1);

    const outcome = await probeCollectors(
      ports({}, codexStatus(), {
        integration: () => {
          throw new Error("EACCES: /Users/USERNAME/.claude/settings.json");
        },
      }),
      SIGNAL,
    );
    expect(outcome).toEqual({ id: "collectors", status: "unknown", reasonCode: "probe-error" });
  });

  it("reads probe-timeout without reading anything when the signal has already aborted", async () => {
    const read = vi.fn(() => claudeStatus({}));
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
