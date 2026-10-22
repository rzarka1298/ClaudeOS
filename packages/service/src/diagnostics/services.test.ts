import {
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PER_PROBE_CAP_MS, type Probe, type ProbeLogEntry } from "./run-probes.js";
import { createDiagnosticsServices, type DiagnosticsPorts } from "./services.js";

/**
 * Plan 08-07 Task 2 (D-05, T-08-16): the services around the capped runner. Concurrent requests
 * share one run, a result younger than 2 s is served as `cached` with its original check time, a
 * hung probe reads `probe-timeout` while the others keep their answers, and the trigger reaches
 * every probe. Fake timers, no real waiting.
 */

const HOOKS_OK: ProbeOutcome = { id: "hooks", status: "ok", reasonCode: "hooks-receiving" };
const HOME = "/Users/USERNAME";
let log: ProbeLogEntry[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
  log = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function build(extra: Partial<DiagnosticsPorts> = {}) {
  return createDiagnosticsServices({
    vault: { readRoot: () => null },
    serviceFacts: {
      version: "0.1.0",
      startedAt: "2026-10-22T08:00:00.000Z",
      storeSchemaVersion: () => 12,
      homeDir: HOME,
      runtimeDir: `${HOME}/.example-runtime`,
      socketPath: `${HOME}/.example-runtime/svc.sock`,
    },
    now: () => new Date(Date.now()),
    log: (entry) => log.push(entry),
    ...extra,
  });
}

describe("the assembled response", () => {
  it("answers the strict schema with a row per subsystem, unwired ports reading subsystem-not-wired", async () => {
    const response = await build().check("reconnect");
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    expect(response.rows.map((row) => row.id)).toEqual([
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(response.rows.map((row) => row.reasonCode)).toEqual([
      "vault-not-set-up",
      "subsystem-not-wired",
      "subsystem-not-wired",
      "subsystem-not-wired",
      "subsystem-not-wired",
    ]);
    expect(response.service).toEqual({
      version: "0.1.0",
      startedAt: "2026-10-22T08:00:00.000Z",
      storeSchemaVersion: 12,
    });
    expect(response.paths.runtimeDir).toBe("~/.example-runtime");
    expect(response.counts).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
    });
    expect(response.keychain).toEqual({ installSecret: "unknown", researchKey: "unknown" });
  });

  it("carries a null schema version as null, never zero", async () => {
    const response = await build({
      serviceFacts: {
        version: "0.1.0",
        startedAt: "2026-10-22T08:00:00.000Z",
        storeSchemaVersion: () => null,
        homeDir: HOME,
        runtimeDir: `${HOME}/.example-runtime`,
        socketPath: `${HOME}/.example-runtime/svc.sock`,
      },
    }).check("reconnect");
    expect(response.service.storeSchemaVersion).toBeNull();
  });

  it("gives the wired probe its answer and passes it the trigger", async () => {
    const seen: HealthTrigger[] = [];
    const hooks: Probe = (_signal, trigger) => {
      seen.push(trigger);
      return Promise.resolve(HOOKS_OK);
    };
    const response = await build({ hooks }).check("gesture");
    expect(seen).toEqual(["gesture"]);
    expect(response.rows[1]).toMatchObject({
      id: "hooks",
      status: "ok",
      reasonCode: "hooks-receiving",
    });
  });
});

describe("Test 6: single-flight and the 2 second result cache", () => {
  it("runs the probes once for two concurrent calls, serves a third within 2 s as cached with the original check time, and runs again after 2 s", async () => {
    let runs = 0;
    const hooks: Probe = () => {
      runs += 1;
      return Promise.resolve(HOOKS_OK);
    };
    const services = build({ hooks });

    const [a, b] = await Promise.all([services.check("gesture"), services.check("gesture")]);
    expect(runs).toBe(1);
    expect(a.rows.map((row) => row.freshness)).toEqual(["live", "live", "live", "live", "live"]);
    expect(b).toEqual(a);

    vi.advanceTimersByTime(1999);
    const c = await services.check("gesture");
    expect(runs).toBe(1);
    expect(c.rows.map((row) => row.freshness)).toEqual([
      "cached",
      "cached",
      "cached",
      "cached",
      "cached",
    ]);
    expect(c.rows.map((row) => row.checkedAt)).toEqual(a.rows.map((row) => row.checkedAt));
    expect(c.generatedAt).toBe(a.generatedAt);
    expect(DiagnosticsHealthResponseSchema.safeParse(c).success).toBe(true);

    vi.advanceTimersByTime(1);
    const d = await services.check("gesture");
    expect(runs).toBe(2);
    expect(d.rows[0]?.freshness).toBe("live");
    expect(d.rows[0]?.checkedAt).not.toBe(a.rows[0]?.checkedAt);
  });

  it("keeps a reconnect from joining or upgrading to a gesture run", async () => {
    const triggers: HealthTrigger[] = [];
    const hooks: Probe = (_signal, trigger) => {
      triggers.push(trigger);
      return Promise.resolve(HOOKS_OK);
    };
    const services = build({ hooks });
    await Promise.all([services.check("reconnect"), services.check("gesture")]);
    expect([...triggers].sort()).toEqual(["gesture", "reconnect"]);
    // A reconnect after a gesture reads its own young result, not the gesture's.
    await services.check("reconnect");
    expect(triggers).toHaveLength(2);
  });

  it("does not cache a failed run", async () => {
    let broken = true;
    const services = build({
      now: () => {
        if (broken) throw new Error("boom");
        return new Date(Date.now());
      },
    });
    await expect(services.check("reconnect")).rejects.toThrow("boom");
    broken = false;
    const next = await services.check("reconnect");
    expect(next.rows[0]?.reasonCode).toBe("vault-not-set-up");
    expect(next.rows[0]?.freshness).toBe("live");
  });
});

describe("caps through the services", () => {
  it("cuts a hung probe at 2 s as probe-timeout while the others keep their answers, and leaves no timer", async () => {
    const hung: Probe = () => new Promise(() => undefined);
    const hooks: Probe = () => Promise.resolve(HOOKS_OK);
    const services = build({ hooks, launchers: hung });
    const pending = services.check("reconnect");
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    const response = await pending;
    expect(response.rows[1]).toMatchObject({ reasonCode: "hooks-receiving", freshness: "live" });
    expect(response.rows[4]).toMatchObject({
      id: "launchers",
      status: "unknown",
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
    expect(log).toEqual([{ subsystem: "launchers", code: "probe-timeout" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads probe-error for a throwing probe and still answers the strict response", async () => {
    const services = build({
      collectors: () => Promise.reject(new TypeError("/Users/USERNAME/secret")),
    });
    const response = await services.check("reconnect");
    expect(response.rows[2]).toMatchObject({ reasonCode: "probe-error", freshness: "unavailable" });
    expect(JSON.stringify([response, log])).not.toContain("secret");
    expect(log).toEqual([{ subsystem: "collectors", code: "probe-error", errorName: "TypeError" }]);
  });

  it("serves a cached timeout row as unavailable, not cached", async () => {
    const services = build({ scheduler: () => new Promise(() => undefined) });
    const first = services.check("reconnect");
    await vi.advanceTimersByTimeAsync(PER_PROBE_CAP_MS);
    await first;
    const again = await services.check("reconnect");
    expect(again.rows[3]).toMatchObject({ reasonCode: "probe-timeout", freshness: "unavailable" });
    expect(again.rows[0]?.freshness).toBe("cached");
  });
});
