import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
} from "@ccc/domain";
import { initializeVault } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PER_PROBE_CAP_MS, type Probe, type ProbeLogEntry } from "./run-probes.js";
import {
  createDiagnosticsServices,
  type DiagnosticsPorts,
  type DiagnosticsServiceFacts,
} from "./services.js";

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

describe("Test 5: the salted vault fingerprint and the display paths (D-36)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function readyVault(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-diag-fp-")));
    created.push(root);
    mkdirSync(join(root, ".obsidian"));
    initializeVault(root);
    return root;
  }

  it("carries { salt, digest } with the digest the first 16 hex of SHA-256 over salt + ':' + root, and never the root", async () => {
    const root = readyVault();
    const response = await build({ vault: { readRoot: () => root } }).check("reconnect");
    expect(response.rows[0]).toMatchObject({
      id: "vault",
      status: "ok",
      reasonCode: "vault-ready",
    });
    const fingerprint = response.vaultFingerprint;
    expect(fingerprint).not.toBeNull();
    expect(fingerprint?.salt).toMatch(/^[0-9a-f]{32}$/);
    const expected = createHash("sha256")
      .update(`${fingerprint?.salt}:${root}`)
      .digest("hex")
      .slice(0, 16);
    expect(fingerprint?.digest).toBe(expected);

    const wire = JSON.stringify(response);
    expect(wire).not.toContain(root);
    expect(response.paths.vault?.startsWith("~/") || response.paths.vault?.startsWith("…/")).toBe(
      true,
    );
    // Outside the home folder a display path is the last two segments only, whatever the machine's
    // temporary folder is called (it may itself be `/tmp`, so the folder name is not a leak check).
    expect(response.paths.vault).toBe(`…/${basename(dirname(root))}/${basename(root)}`);
  });

  it("keeps the salt stable within one service and gives another service a different one", async () => {
    const root = readyVault();
    const first = build({ vault: { readRoot: () => root } });
    const a = await first.check("reconnect");
    vi.advanceTimersByTime(2500);
    const b = await first.check("reconnect");
    expect(b.vaultFingerprint).toEqual(a.vaultFingerprint);

    const other = await build({ vault: { readRoot: () => root } }).check("reconnect");
    expect(other.vaultFingerprint?.salt).not.toBe(a.vaultFingerprint?.salt);
    expect(other.vaultFingerprint?.digest).not.toBe(a.vaultFingerprint?.digest);
  });

  it("reports a null fingerprint and a null vault path while no vault is set up", async () => {
    const response = await build().check("reconnect");
    expect(response.vaultFingerprint).toBeNull();
    expect(response.paths.vault).toBeNull();
  });

  it("still fingerprints a persisted root whose folder has gone, so the plugin can tell which vault the service lost", async () => {
    const root = join(readyVault(), "gone");
    const response = await build({ vault: { readRoot: () => root } }).check("reconnect");
    expect(response.rows[0]).toMatchObject({ reasonCode: "vault-root-missing" });
    expect(response.vaultFingerprint).not.toBeNull();
  });

  it("builds the display paths from the service facts with the domain toDisplayPath", async () => {
    const response = await build().check("reconnect");
    expect(response.paths.runtimeDir).toBe("~/.example-runtime");
    expect(response.paths.socket).toBe("~/.example-runtime/svc.sock");
  });
});

describe("FIX2A F9: one bad input does not turn every health call into a failure", () => {
  const facts = (overrides: Partial<DiagnosticsServiceFacts> = {}): DiagnosticsServiceFacts => ({
    version: "0.1.0",
    startedAt: "2026-10-22T08:00:00.000Z",
    storeSchemaVersion: () => 12,
    homeDir: HOME,
    runtimeDir: `${HOME}/.example-runtime`,
    socketPath: `${HOME}/.example-runtime/svc.sock`,
    ...overrides,
  });

  it("a store that throws on the schema version reads null, and the response is still the strict one", async () => {
    class SqliteError extends Error {
      override name = "SqliteError";
    }
    const response = await build({
      serviceFacts: facts({
        storeSchemaVersion: () => {
          throw new SqliteError("SQLITE_BUSY: database is locked: /Users/USERNAME/store.db");
        },
      }),
    }).check("reconnect");
    expect(response.service.storeSchemaVersion).toBeNull();
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    expect(JSON.stringify(response)).not.toContain("SQLITE_BUSY");
  });

  it("a 607-character vault path gets a schema-valid fallback display path instead of failing the response", async () => {
    const root = `${HOME}/${"v".repeat(591)}`;
    expect(root.length).toBe(607);
    const response = await build({ vault: { readRoot: () => root } }).check("reconnect");
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    expect(response.paths.vault).not.toBeNull();
    expect((response.paths.vault ?? "").length).toBeLessThanOrEqual(512);
    expect(response.paths.vault?.startsWith("~/…/v")).toBe(true);
    expect(response.vaultFingerprint).not.toBeNull();
  });

  it("a runtime folder or socket path that is too long falls back too, and the rest of the response stands", async () => {
    const long = `${HOME}/${"r".repeat(700)}/svc.sock`;
    const response = await build({
      serviceFacts: facts({ runtimeDir: `${HOME}/${"r".repeat(700)}`, socketPath: long }),
    }).check("reconnect");
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
    expect(response.paths.socket).toBe("~/…/svc.sock");
    expect(response.paths.runtimeDir.length).toBeLessThanOrEqual(512);
  });

  it("a readRoot that throws reads the vault row probe-error, with no root, no fingerprint and no message, and the others still answer", async () => {
    const hooks: Probe = () => Promise.resolve(HOOKS_OK);
    const response = await build({
      hooks,
      vault: {
        readRoot: () => {
          throw new Error("SqliteError: database is locked at /Users/USERNAME/store.db");
        },
      },
    }).check("reconnect");
    expect(response.rows[0]).toMatchObject({
      id: "vault",
      status: "unknown",
      reasonCode: "probe-error",
    });
    expect(response.rows[1]).toMatchObject({ id: "hooks", status: "ok" });
    expect(response.paths.vault).toBeNull();
    expect(response.vaultFingerprint).toBeNull();
    expect(JSON.stringify(response)).not.toContain("locked");
  });

  it("reads the persisted root once per check, so the row, the path and the fingerprint describe one value", async () => {
    let reads = 0;
    const root = `${HOME}/vault`;
    await build({
      vault: {
        readRoot: () => {
          reads += 1;
          return root;
        },
      },
    }).check("reconnect");
    expect(reads).toBe(1);
  });
});

describe("FIX2A m1: the result cache runs on a monotonic clock", () => {
  it("a wall-clock step back does not freeze a stale result, and a step forward does not expire a fresh one", async () => {
    let runs = 0;
    const hooks: Probe = () => {
      runs += 1;
      return Promise.resolve(HOOKS_OK);
    };
    let wall = Date.parse("2026-10-22T09:00:00.000Z");
    let monotonic = 1000;
    const services = build({
      hooks,
      now: () => new Date(wall),
      monotonicNowMs: () => monotonic,
    });
    await services.check("reconnect");
    expect(runs).toBe(1);

    // The wall clock jumps back an hour; 500 ms really passed: still cached.
    wall -= 60 * 60_000;
    monotonic += 500;
    await services.check("reconnect");
    expect(runs).toBe(1);

    // Now 2.5 s really passed, whatever the wall clock says (it is still an hour back): recompute.
    monotonic += 2000;
    await services.check("reconnect");
    expect(runs).toBe(2);

    // The wall clock jumps forward a day; 100 ms really passed: not expired.
    wall += 24 * 60 * 60_000;
    monotonic += 100;
    await services.check("reconnect");
    expect(runs).toBe(2);
  });

  it("defaults to the process's monotonic clock, not the injected wall clock", async () => {
    let runs = 0;
    const hooks: Probe = () => {
      runs += 1;
      return Promise.resolve(HOOKS_OK);
    };
    // A wall clock that goes backwards on every read would make a wall-clock TTL serve cached results for ever.
    let wall = Date.parse("2026-10-22T09:00:00.000Z");
    const services = build({
      hooks,
      now: () => {
        wall -= 10 * 60_000;
        return new Date(wall);
      },
    });
    await services.check("reconnect");
    await vi.advanceTimersByTimeAsync(3000);
    await services.check("reconnect");
    expect(runs).toBe(2);
  });
});

describe("09-19 Task 1: the approval presence member (D-04, T-09-42, T-09-43)", () => {
  type Port = NonNullable<DiagnosticsPorts["approvalPresence"]>;
  type Check = Awaited<ReturnType<Port["check"]>>;

  function portOf(options: {
    precheck?: ReturnType<Port["precheck"]>;
    check?: () => Promise<Check>;
  }) {
    const calls = { precheck: 0, check: 0 };
    const port: Port = {
      precheck: () => {
        calls.precheck += 1;
        return options.precheck ?? null;
      },
      check: () => {
        calls.check += 1;
        return (options.check ?? (() => Promise.resolve(AVAILABLE)))();
      },
    };
    return { port, calls };
  }
  const AVAILABLE: Check = { state: "available", reason: null, fingerprint: "0a1b2c3d" };

  it("without the port the member is absent (an unwired service never claims anything)", async () => {
    const response = await build().check("gesture");
    expect(response.approvalPresence).toBeUndefined();
    expect(response.approvalPresenceReason).toBeUndefined();
    expect(response.approvalPresencePin).toBeUndefined();
  });

  it("Test 2 (tracer): an absent helper is unavailable on any trigger and the check is never called", async () => {
    const { port, calls } = portOf({ precheck: "helper-missing" });
    const services = build({ approvalPresence: port });
    for (const trigger of ["reconnect", "gesture"] as const) {
      vi.advanceTimersByTime(2001);
      const response = await services.check(trigger);
      expect(response.approvalPresence).toBe("unavailable");
      expect(response.approvalPresenceReason).toBe("helper-missing");
      expect(response.approvalPresencePin).toBeUndefined();
    }
    expect(calls.check).toBe(0);
  });

  it("Test 2: a sandbox service reads unavailable with the sandbox reason and never calls the check", async () => {
    const { port, calls } = portOf({ precheck: "sandbox" });
    const response = await build({ approvalPresence: port }).check("gesture");
    expect(response).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "sandbox",
    });
    expect(calls.check).toBe(0);
  });

  it("Test 2: with the helper present a reconnect reads unknown without calling the check; a gesture calls it once and reports its answer", async () => {
    const { port, calls } = portOf({});
    const services = build({ approvalPresence: port });
    const reconnect = await services.check("reconnect");
    expect(reconnect.approvalPresence).toBe("unknown");
    expect(reconnect.approvalPresenceReason).toBeUndefined();
    expect(calls.check).toBe(0);
    vi.advanceTimersByTime(2001);
    const gesture = await services.check("gesture");
    expect(gesture).toMatchObject({
      approvalPresence: "available",
      approvalPresencePin: "0a1b2c3d",
    });
    expect(gesture.approvalPresenceReason).toBeUndefined();
    expect(calls.check).toBe(1);
  });

  it("Test 2: a second gesture inside two seconds is served from the cache (one check)", async () => {
    const { port, calls } = portOf({});
    const services = build({ approvalPresence: port });
    await services.check("gesture");
    vi.advanceTimersByTime(1999);
    const second = await services.check("gesture");
    expect(second.approvalPresence).toBe("available");
    expect(calls.check).toBe(1);
    vi.advanceTimersByTime(2);
    await services.check("gesture");
    expect(calls.check).toBe(2);
  });

  it("a reconnect after a gesture reads that gesture's answer while it is young, and unknown once it is older than five minutes", async () => {
    const { port, calls } = portOf({
      check: () =>
        Promise.resolve({ state: "unavailable", reason: "not-enrolled", fingerprint: null }),
    });
    const services = build({ approvalPresence: port });
    await services.check("gesture");
    vi.advanceTimersByTime(3000);
    const young = await services.check("reconnect");
    expect(young).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "not-enrolled",
    });
    vi.advanceTimersByTime(5 * 60 * 1000);
    const old = await services.check("reconnect");
    expect(old.approvalPresence).toBe("unknown");
    expect(old.approvalPresenceReason).toBeUndefined();
    expect(calls.check).toBe(1);
  });

  it("a reconnect never reads available from memory once the helper has gone", async () => {
    let helperGone: Port["precheck"] extends () => infer R ? R : never = null;
    const { port } = portOf({});
    const services = build({ approvalPresence: { ...port, precheck: () => helperGone } });
    await services.check("gesture");
    vi.advanceTimersByTime(3000);
    helperGone = "helper-missing";
    const response = await services.check("reconnect");
    expect(response).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "helper-missing",
    });
  });

  it("Test 3: a check that throws is unavailable (check-failed), never available", async () => {
    const { port } = portOf({ check: () => Promise.reject(new Error("boom")) });
    const response = await build({ approvalPresence: port }).check("gesture");
    expect(response).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "check-failed",
    });
    expect(response.approvalPresencePin).toBeUndefined();
  });

  it("Test 3: a check that exceeds its deadline is unavailable (check-failed) and leaves no timer", async () => {
    const { port } = portOf({ check: () => new Promise(() => undefined) });
    const pending = build({ approvalPresence: port }).check("gesture");
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "check-failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer outside the contract is unavailable, not available (a misbehaving port cannot fabricate availability)", async () => {
    for (const bad of [
      { state: "AVAILABLE", reason: null, fingerprint: null },
      { state: "available", reason: "because", fingerprint: null },
      { state: "available", reason: null, fingerprint: "MIIBIjANBgkqhkiG9w0BAQEFAAOC" },
      null,
      "available",
    ]) {
      const { port } = portOf({ check: () => Promise.resolve(bad as never) });
      const response = await build({ approvalPresence: port }).check("gesture");
      expect(response.approvalPresence, JSON.stringify(bad)).toBe("unavailable");
      expect(response.approvalPresencePin).toBeUndefined();
    }
  });

  it("an unavailable answer keeps its closed reason and the fingerprint of the pin (so a swapped key can be compared)", async () => {
    const { port } = portOf({
      check: () =>
        Promise.resolve({ state: "unavailable", reason: "pin-changed", fingerprint: "deadbeef" }),
    });
    const response = await build({ approvalPresence: port }).check("gesture");
    expect(response).toMatchObject({
      approvalPresence: "unavailable",
      approvalPresenceReason: "pin-changed",
      approvalPresencePin: "deadbeef",
    });
    expect(DiagnosticsHealthResponseSchema.safeParse(response).success).toBe(true);
  });

  it("an available answer without a reason is the only way to read available", async () => {
    const { port } = portOf({
      check: () =>
        Promise.resolve({ state: "available", reason: "not-enrolled", fingerprint: null }),
    });
    const response = await build({ approvalPresence: port }).check("gesture");
    expect(response.approvalPresence).toBe("unavailable");
  });
});
