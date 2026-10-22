import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
  type ProbeOutcome,
} from "@ccc/domain";
import { initializeVault } from "@ccc/vault-repo";
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
    expect(response.paths.vault).not.toContain(tmpdir());
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
