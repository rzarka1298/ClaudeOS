import { randomUUID } from "node:crypto";
import {
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  type CodexBridgeStatus,
  type CodexDoctorSummary,
  type CodexHookStatus,
  type CodexInstall,
  CodexIntegrationStatusSchema,
  CodexIntegrationUpdatedPayloadSchema,
} from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexComposition,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import {
  assertNoForbiddenAccess,
  createFakeCodexHome,
  type RecordedCall,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import type { BridgeStatus } from "./bridge-state.js";
import { createCodexHomePort } from "./codex-home.js";
import { buildCodexIntegrationStatus } from "./integration-routes.js";

/**
 * Plan 05.1-28 Task 2, integration status: one read-only GET assembled from the
 * bridge status view, the hook status, the cached install result and the last
 * doctor summary. It spawns nothing, reads no Codex file and carries no path.
 */

const BRIDGE: CodexBridgeStatus = { state: "installed", lastWindowAt: "2026-10-10T12:00:00.000Z" };
const HOOKS: CodexHookStatus = {
  state: "installed-no-events",
  lastEventAt: null,
  installedSince: "2026-10-10T11:00:00.000Z",
};
const INSTALL: CodexInstall = { installed: true, version: "0.159.2" };
const DOCTOR: CodexDoctorSummary = { overall: "ok", codexVersion: "0.159.2", checks: [] };

describe("buildCodexIntegrationStatus", () => {
  it("combines the four readers into the strict status", () => {
    const status = buildCodexIntegrationStatus({
      bridge: () => BRIDGE,
      hooks: () => HOOKS,
      install: () => INSTALL,
      doctor: () => DOCTOR,
    });
    expect(status).toEqual({ bridge: BRIDGE, hooks: HOOKS, codex: INSTALL, doctor: DOCTOR });
    expect(CodexIntegrationStatusSchema.safeParse(status).success).toBe(true);
  });

  it("carries a null doctor until the owner ran the check", () => {
    const status = buildCodexIntegrationStatus({
      bridge: () => BRIDGE,
      hooks: () => HOOKS,
      install: () => INSTALL,
      doctor: () => null,
    });
    expect(status.doctor).toBeNull();
  });

  it("refuses a reader that returns an off-schema value instead of passing it on", () => {
    expect(() =>
      buildCodexIntegrationStatus({
        bridge: () =>
          ({ ...BRIDGE, home: "/Users/USERNAME/.codex" }) as unknown as CodexBridgeStatus,
        hooks: () => HOOKS,
        install: () => INSTALL,
        doctor: () => null,
      }),
    ).toThrow();
  });
});

const open: CodexComposition[] = [];

afterEach(async () => {
  for (const composition of open.splice(0)) await composition.close();
});

/** A bridge status the tests move by hand. */
function bridgeStatus(state: BridgeStatus["state"]): BridgeStatus {
  return {
    state,
    protocol: null,
    capabilities: null,
    launcherPresent: state !== "not-installed",
    dir: "/Users/USERNAME/state/codex-bridge",
    dirSource: "primary",
    launchable: true,
    windows: [],
  };
}

/** An installed hook copy the tests can add and remove (two `lstat` answers). */
function fakeHookCopy(): {
  fs: { lstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean; mtimeMs: number } };
  present: { value: boolean };
} {
  const present = { value: false };
  return {
    present,
    fs: {
      lstat() {
        if (!present.value) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return { isFile: () => true, isSymbolicLink: () => false, mtimeMs: Date.now() - 60_000 };
      },
    },
  };
}

describe("GET integration through the composed services", () => {
  it("Test 4: reads no Codex file and spawns nothing", async () => {
    const calls: RecordedCall[] = [];
    const home = createFakeCodexHome({ withDecoys: true, database: { ddl: "current" } });
    const recorder = recordingFs();
    const port = createCodexHomePort({ root: home.root, fs: recorder.fs });
    const c = await startCodexComposition({
      appServer: { read: { kind: "hang" } },
      deps: { port },
    });
    open.push(c);
    const reply = await c.get(CODEX_INTEGRATION_PATH);
    expect(reply.status).toBe(200);
    CodexIntegrationStatusSchema.parse(reply.body);
    expect(c.spawner.calls).toEqual([]);
    expect(c.appServerStarts()).toBe(0);
    calls.push(...recorder.calls);
    assertNoForbiddenAccess(calls, home);
    expect(calls).toEqual([]);
    home.cleanup();
  });

  it("Test 4: a bridge change publishes the integration event once, an unchanged re-read publishes nothing", async () => {
    const bridge = { current: bridgeStatus("not-installed") };
    const c = await startCodexComposition({
      deps: { readBridgeStatus: () => bridge.current },
    });
    open.push(c);
    await c.get(CODEX_INTEGRATION_PATH);
    expect(c.events("codex.integration.updated")).toHaveLength(0);

    bridge.current = bridgeStatus("installed");
    const changed = CodexIntegrationStatusSchema.parse((await c.get(CODEX_INTEGRATION_PATH)).body);
    expect(changed.bridge.state).toBe("installed");
    const events = c.events("codex.integration.updated");
    expect(events).toHaveLength(1);
    expect(CodexIntegrationUpdatedPayloadSchema.parse(events[0]?.payload)).toEqual(changed);

    await c.get(CODEX_INTEGRATION_PATH);
    expect(c.events("codex.integration.updated")).toHaveLength(1);
  });

  it("Test 4: the first hook record and a changed hook copy each publish the event once", async () => {
    const copy = fakeHookCopy();
    copy.present.value = true;
    const c = await startCodexComposition({ deps: { statusFs: copy.fs } });
    open.push(c);
    const before = CodexIntegrationStatusSchema.parse((await c.get(CODEX_INTEGRATION_PATH)).body);
    expect(before.hooks.state).toBe("installed-no-events");
    expect(c.events("codex.integration.updated")).toHaveLength(0);

    const accepted = await c.post(CODEX_HOOK_EVENTS_PATH, {
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-integration-0001",
      turn_id: "turn-1",
    });
    expect(accepted.status).toBe(202);
    expect(await waitFor(() => c.events("codex.integration.updated").length === 1)).toBe(true);
    const arrived = CodexIntegrationUpdatedPayloadSchema.parse(
      c.events("codex.integration.updated")[0]?.payload,
    );
    expect(arrived.hooks.state).toBe("installed");

    copy.present.value = false;
    c.codex?.onIntegrationRefresh();
    expect(c.events("codex.integration.updated")).toHaveLength(2);
    const removed = CodexIntegrationUpdatedPayloadSchema.parse(
      c.events("codex.integration.updated")[1]?.payload,
    );
    expect(removed.hooks.state).toBe("not-installed");
    c.codex?.onIntegrationRefresh();
    expect(c.events("codex.integration.updated")).toHaveLength(2);
  });

  it("Test 4: a launcher change refreshes the cached install result and publishes once", async () => {
    const detection = {
      detectCodex: async () => ({
        executables: [
          {
            candidateId: "user-install",
            displayPath: "~/.local/bin/codex",
            version: "0.159.2",
            location: "user-install" as const,
          },
        ],
        doctor: "unknown" as const,
        bridge: "not-installed" as const,
        suggestedTerminal: { kind: "terminal-app" as const },
      }),
      candidatePath: () => null,
    };
    const c = await startCodexComposition({ deps: { detection } });
    open.push(c);
    const before = CodexIntegrationStatusSchema.parse((await c.get(CODEX_INTEGRATION_PATH)).body);
    expect(before.codex).toEqual({ installed: false, version: null });

    c.codex?.onLaunchersChanged();
    expect(await waitFor(() => c.events("codex.integration.updated").length === 1)).toBe(true);
    const after = CodexIntegrationUpdatedPayloadSchema.parse(
      c.events("codex.integration.updated")[0]?.payload,
    );
    expect(after.codex).toEqual({ installed: true, version: "0.159.2" });
    expect(c.events("codex.integration.updated")).toHaveLength(1);
  });
});
