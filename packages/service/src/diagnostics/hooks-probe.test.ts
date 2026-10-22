import { HOOK_SILENT_THRESHOLD_MS } from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import { claudeStatus, isValidRow } from "../test-support/diagnostics-probe-fixtures.js";
import { type HooksProbePorts, probeHooks } from "./hooks-probe.js";

/**
 * Plan 08-08 Task 1 (D-04, D-35; T-08-19): the hooks row is a pure projection of the Claude
 * integration status the usage services already hold, with the precedence of the settings tab's
 * `hookStatusText` (not installed, unreadable, disabled, runtime missing, no events, silent,
 * receiving). Idle is `unknown`, never `degraded`. An injected clock decides; nothing waits.
 */

const NOW = new Date("2026-10-22T09:00:00.000Z");
const SIGNAL = new AbortController().signal;
const MINUTE = 60_000;

function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * MINUTE).toISOString();
}

function ports(
  overrides: Parameters<typeof claudeStatus>[0],
  now: Date = NOW,
): HooksProbePorts & { refreshed: number } {
  const recorded = {
    refreshed: 0,
    refreshSettingsFacts: () => {
      recorded.refreshed += 1;
      return claudeStatus(overrides);
    },
    now: () => now,
  };
  return recorded;
}

describe("Test 1 (tracer): a fresh install", () => {
  it("reads hooks-not-installed with the claude-hooks-install copy action", async () => {
    const outcome = await probeHooks(ports({}), SIGNAL);
    expect(outcome).toEqual({
      id: "hooks",
      status: "setup-needed",
      reasonCode: "hooks-not-installed",
      setupAction: { kind: "copy-command", command: "claude-hooks-install" },
    });
    expect(isValidRow(outcome)).toBe(true);
  });
});

describe("Test 2: the precedence", () => {
  const cases: readonly {
    name: string;
    status: Parameters<typeof claudeStatus>[0];
    reason: string;
    state: string;
  }[] = [
    {
      name: "unreadable settings",
      status: { hooks: "unknown" },
      reason: "hooks-state-unreadable",
      state: "unknown",
    },
    {
      name: "installed but all hooks disabled",
      status: { hooks: "installed", disableAllHooks: true, lastEventAt: ago(1) },
      reason: "hooks-disabled-in-claude",
      state: "degraded",
    },
    {
      name: "installed with the runtime missing",
      status: { hooks: "installed", hookRuntimeMissing: true },
      reason: "hook-runtime-missing",
      state: "failing",
    },
    {
      name: "installed, no event since the service started",
      status: { hooks: "installed", lastEventAt: null },
      reason: "no-events-yet",
      state: "unknown",
    },
    {
      name: "installed, last event 11 minutes ago",
      status: { hooks: "installed", lastEventAt: ago(11) },
      reason: "events-silent",
      state: "unknown",
    },
    {
      name: "installed, last event 2 minutes ago",
      status: { hooks: "installed", lastEventAt: ago(2) },
      reason: "hooks-receiving",
      state: "ok",
    },
  ];

  for (const entry of cases) {
    it(`${entry.name} reads ${entry.reason} (${entry.state})`, async () => {
      const outcome = await probeHooks(ports(entry.status), SIGNAL);
      expect(outcome).toMatchObject({ id: "hooks", status: entry.state, reasonCode: entry.reason });
      expect(isValidRow(outcome)).toBe(true);
    });
  }

  it("not-installed beats every later condition", async () => {
    const outcome = await probeHooks(
      ports({ hooks: "not-installed", disableAllHooks: true, hookRuntimeMissing: true }),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ reasonCode: "hooks-not-installed" });
  });

  it("unreadable beats disabled and runtime-missing", async () => {
    const outcome = await probeHooks(
      ports({ hooks: "unknown", disableAllHooks: true, hookRuntimeMissing: true }),
      SIGNAL,
    );
    expect(outcome).toMatchObject({ reasonCode: "hooks-state-unreadable" });
  });

  it("disabled beats runtime-missing, which beats no-events and silent", async () => {
    const both = await probeHooks(
      ports({ hooks: "installed", disableAllHooks: true, hookRuntimeMissing: true }),
      SIGNAL,
    );
    expect(both).toMatchObject({ reasonCode: "hooks-disabled-in-claude" });
    const runtime = await probeHooks(
      ports({ hooks: "installed", hookRuntimeMissing: true, lastEventAt: ago(30) }),
      SIGNAL,
    );
    expect(runtime).toMatchObject({ reasonCode: "hook-runtime-missing" });
  });

  it("copies the install command for a missing runtime and none for the other states", async () => {
    const runtime = await probeHooks(
      ports({ hooks: "installed", hookRuntimeMissing: true }),
      SIGNAL,
    );
    expect(runtime).toMatchObject({
      setupAction: { kind: "copy-command", command: "claude-hooks-install" },
    });
    for (const status of [
      { hooks: "unknown" as const },
      { hooks: "installed" as const, disableAllHooks: true },
      { hooks: "installed" as const, lastEventAt: null },
      { hooks: "installed" as const, lastEventAt: ago(30) },
      { hooks: "installed" as const, lastEventAt: ago(1) },
    ]) {
      const outcome = await probeHooks(ports(status), SIGNAL);
      expect("setupAction" in outcome).toBe(false);
    }
  });

  it("the silent row carries the threshold as a fact; the others carry no facts", async () => {
    const silent = await probeHooks(ports({ hooks: "installed", lastEventAt: ago(11) }), SIGNAL);
    expect(silent).toMatchObject({ facts: { silenceThresholdMs: HOOK_SILENT_THRESHOLD_MS } });
    expect(HOOK_SILENT_THRESHOLD_MS).toBe(10 * MINUTE);
    const receiving = await probeHooks(ports({ hooks: "installed", lastEventAt: ago(1) }), SIGNAL);
    expect("facts" in receiving).toBe(false);
  });

  it("uses the injected clock: exactly 10 minutes is still receiving, one millisecond more is silent", async () => {
    const edge = new Date(NOW.getTime() - HOOK_SILENT_THRESHOLD_MS).toISOString();
    expect(
      await probeHooks(ports({ hooks: "installed", lastEventAt: edge }), SIGNAL),
    ).toMatchObject({
      reasonCode: "hooks-receiving",
    });
    const justOver = new Date(NOW.getTime() - HOOK_SILENT_THRESHOLD_MS - 1).toISOString();
    expect(
      await probeHooks(ports({ hooks: "installed", lastEventAt: justOver }), SIGNAL),
    ).toMatchObject({
      reasonCode: "events-silent",
    });
    // The real clock is years away from the injected one; only the injected one counts.
    const farFuture = new Date("2040-01-01T00:00:00.000Z");
    expect(
      await probeHooks(ports({ hooks: "installed", lastEventAt: ago(1) }, farFuture), SIGNAL),
    ).toMatchObject({ reasonCode: "events-silent" });
  });

  it("reads an event stamped in the future (clock skew) as receiving, and an unparsable stamp as silent, never ok", async () => {
    const future = new Date(NOW.getTime() + 5 * MINUTE).toISOString();
    expect(
      await probeHooks(ports({ hooks: "installed", lastEventAt: future }), SIGNAL),
    ).toMatchObject({
      reasonCode: "hooks-receiving",
    });
    const odd = await probeHooks(
      ports({ hooks: "installed", lastEventAt: "not-a-date" as never }),
      SIGNAL,
    );
    expect(odd).toMatchObject({ status: "unknown", reasonCode: "events-silent" });
  });
});

describe("Test 2b: what the probe is allowed to do and to return", () => {
  it("re-reads the settings facts once per probe and returns neither the event time nor a path", async () => {
    const port = ports({ hooks: "installed", lastEventAt: ago(3) });
    const outcome = await probeHooks(port, SIGNAL);
    expect(port.refreshed).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(ago(3));
    expect(JSON.stringify(outcome)).not.toMatch(/\/Users\/|\.json|settings/);
  });

  it("reads probe-error, with no message, when the settings read throws", async () => {
    const outcome = await probeHooks(
      {
        refreshSettingsFacts: () => {
          throw new Error("EACCES: /Users/USERNAME/.claude/settings.json");
        },
        now: () => NOW,
      },
      SIGNAL,
    );
    expect(outcome).toEqual({ id: "hooks", status: "unknown", reasonCode: "probe-error" });
  });

  it("does not read at all when the signal has already aborted, and reads probe-timeout", async () => {
    const read = vi.fn(() => claudeStatus({}));
    const controller = new AbortController();
    controller.abort();
    const outcome = await probeHooks(
      { refreshSettingsFacts: read, now: () => NOW },
      controller.signal,
    );
    expect(outcome).toEqual({ id: "hooks", status: "unknown", reasonCode: "probe-timeout" });
    expect(read).not.toHaveBeenCalled();
  });
});
