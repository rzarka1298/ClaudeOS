import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { allOkHealth, healthResponse as fixtureResponse } from "../test-support/health-fixtures.js";
import { configureHealth, HealthApiError } from "./api.js";
import {
  clearedRows,
  clearHealth,
  healthPhase,
  healthResponse,
  onHealthLive,
  refreshHealth,
  registerHealthView,
  resetHealthState,
  rowsFor,
  serviceRowFor,
  watchConnection,
} from "./state.js";

/**
 * The Diagnostics health state (plan 08-13 Task 1; D-03, D-05, D-43): the plugin-computed service
 * row, the cleared rows, a sequence-token refresh that only the newest fetch may publish, and the
 * reconnect hook that fetches only while a section is mounted.
 */

const LIVE = { kind: "live" } as const;
const PATHY = "connect ENOENT /Users/someone/Library/Application Support/ccc/service.sock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetHealthState();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  configureHealth(null);
  resetHealthState();
  connectionState.value = { kind: "connecting" };
});

describe("serviceRowFor (D-03, D-43)", () => {
  it("reads ok with the response time when live", () => {
    const response = fixtureResponse();
    expect(serviceRowFor(LIVE, response)).toEqual({
      id: "service",
      status: "ok",
      reasonCode: "service-live",
      checkedAt: response.generatedAt,
      freshness: "live",
    });
  });

  it("reads ok with no time when live and nothing has been fetched yet", () => {
    expect(serviceRowFor(LIVE, null)).toMatchObject({
      status: "ok",
      reasonCode: "service-live",
      checkedAt: null,
    });
  });

  it("reads unknown while connecting, with nothing checked", () => {
    expect(serviceRowFor({ kind: "connecting" }, fixtureResponse())).toEqual({
      id: "service",
      status: "unknown",
      reasonCode: "service-connecting",
      checkedAt: null,
      freshness: "unavailable",
    });
  });

  it("reads failing when disconnected, and no part of the reason text survives", () => {
    const row = serviceRowFor({ kind: "disconnected", reason: PATHY }, fixtureResponse());
    expect(row).toEqual({
      id: "service",
      status: "failing",
      reasonCode: "service-unreachable",
      checkedAt: null,
      freshness: "unavailable",
    });
    expect(JSON.stringify(row)).not.toContain("Users");
    expect(JSON.stringify(row)).not.toContain("ENOENT");
  });
});

describe("rowsFor and clearedRows (D-03)", () => {
  it("lists the six rows in the fixed order when live with a response", () => {
    const rows = rowsFor(LIVE, fixtureResponse());
    expect(rows.map((row) => row.id)).toEqual([
      "service",
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(rows.map((row) => row.status)).toEqual([
      "ok",
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
    ]);
  });

  it("clears the five service-dependent rows when the service is not live, with no last-good value", () => {
    for (const connection of [
      { kind: "connecting" } as const,
      { kind: "disconnected", reason: PATHY } as const,
    ]) {
      const rows = rowsFor(connection, allOkHealth());
      expect(rows.slice(1)).toEqual(clearedRows());
      for (const row of rows.slice(1)) {
        expect(row).toMatchObject({
          status: "unknown",
          reasonCode: "service-not-running",
          checkedAt: null,
          freshness: "unavailable",
        });
        expect(row).not.toHaveProperty("parts");
        expect(row).not.toHaveProperty("setupAction");
        expect(row).not.toHaveProperty("facts");
      }
    }
  });

  it("clears the rows when live but nothing has been fetched", () => {
    expect(rowsFor(LIVE, null).slice(1)).toEqual(clearedRows());
  });
});

describe("refreshHealth (D-05)", () => {
  it("publishes the response, sends the trigger it was given and ends ready", async () => {
    const response = fixtureResponse();
    const get = vi.fn(() => Promise.resolve(response));
    configureHealth({ api: { get } });
    const outcome = await refreshHealth("gesture", { vaultBasePath: null });
    expect(outcome).toEqual({ kind: "ok", timedOut: 0 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("gesture");
    expect(healthResponse.value).toBe(response);
    expect(healthPhase.value).toBe("ready");
  });

  it("is loading while the first fetch is in flight", async () => {
    const pending = deferred<ReturnType<typeof fixtureResponse>>();
    configureHealth({ api: { get: () => pending.promise } });
    const run = refreshHealth("gesture", { vaultBasePath: null });
    expect(healthPhase.value).toBe("loading");
    pending.resolve(fixtureResponse());
    await run;
    expect(healthPhase.value).toBe("ready");
  });

  it("clears the rows and ends in error on a failed fetch, with a closed code", async () => {
    configureHealth({ api: { get: () => Promise.reject(new HealthApiError("timeout")) } });
    healthResponse.value = fixtureResponse();
    const outcome = await refreshHealth("gesture", { vaultBasePath: null });
    expect(outcome).toEqual({ kind: "error", code: "timeout" });
    expect(healthResponse.value).toBeNull();
    expect(healthPhase.value).toBe("error");
  });

  it("maps an error that carries no closed code to internal, never its message", async () => {
    configureHealth({ api: { get: () => Promise.reject(new Error(PATHY)) } });
    const outcome = await refreshHealth("gesture", { vaultBasePath: null });
    expect(outcome).toEqual({ kind: "error", code: "internal" });
    expect(JSON.stringify(outcome)).not.toContain("Users");
  });

  it("lets only the newest fetch publish: an older answer arriving late is dropped", async () => {
    const first = deferred<ReturnType<typeof fixtureResponse>>();
    const second = deferred<ReturnType<typeof fixtureResponse>>();
    const answers = [first, second];
    configureHealth({ api: { get: () => (answers.shift() as typeof first).promise } });
    const olderRun = refreshHealth("gesture", { vaultBasePath: null });
    const newerRun = refreshHealth("reconnect", { vaultBasePath: null });
    const newer = fixtureResponse({ generatedAt: "2026-10-22T09:05:00.000Z" });
    second.resolve(newer);
    first.resolve(fixtureResponse({ generatedAt: "2026-10-22T08:00:00.000Z" }));
    const [olderOutcome, newerOutcome] = await Promise.all([olderRun, newerRun]);
    expect(healthResponse.value).toBe(newer);
    // The older caller is told what the newest check found, not left without an answer.
    expect(olderOutcome).toEqual(newerOutcome);
    expect(newerOutcome).toEqual({ kind: "ok", timedOut: 0 });
  });

  it("drops an answer that arrives after the section was cleared (the service went away)", async () => {
    const pending = deferred<ReturnType<typeof fixtureResponse>>();
    configureHealth({ api: { get: () => pending.promise } });
    const run = refreshHealth("reconnect", { vaultBasePath: null });
    clearHealth();
    pending.resolve(fixtureResponse());
    expect(await run).toEqual({ kind: "superseded" });
    expect(healthResponse.value).toBeNull();
    expect(healthPhase.value).toBe("idle");
  });
});

describe("the reconnect hook (Amendment A1)", () => {
  it("fetches nothing while no section is mounted", async () => {
    const get = vi.fn(() => Promise.resolve(fixtureResponse()));
    configureHealth({ api: { get } });
    onHealthLive();
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches once with reconnect, and never gesture, while a section is mounted", async () => {
    const get = vi.fn(() => Promise.resolve(fixtureResponse()));
    configureHealth({ api: { get } });
    const release = registerHealthView({ vaultBasePath: () => null });
    onHealthLive();
    onHealthLive();
    await vi.waitFor(() => expect(healthPhase.value).toBe("ready"));
    expect(get.mock.calls.length).toBeGreaterThan(0);
    expect(get.mock.calls.every((call) => (call as unknown[])[0] === "reconnect")).toBe(true);
    release();
    get.mockClear();
    onHealthLive();
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
  });

  it("a failed reconnect fetch does not throw out of the hook", async () => {
    configureHealth({ api: { get: () => Promise.reject(new HealthApiError("timeout")) } });
    const release = registerHealthView({ vaultBasePath: () => null });
    expect(() => onHealthLive()).not.toThrow();
    await vi.waitFor(() => expect(healthPhase.value).toBe("error"));
    release();
  });
});

describe("watchConnection (D-03)", () => {
  it("clears the held response as soon as the service is not live", () => {
    const stop = watchConnection();
    healthResponse.value = fixtureResponse();
    healthPhase.value = "ready";
    connectionState.value = { kind: "disconnected", reason: PATHY };
    expect(healthResponse.value).toBeNull();
    expect(healthPhase.value).toBe("idle");
    stop();
  });

  it("leaves a response alone while the service stays live, and stops when released", () => {
    const stop = watchConnection();
    healthResponse.value = fixtureResponse();
    connectionState.value = { kind: "live" };
    expect(healthResponse.value).not.toBeNull();
    stop();
    connectionState.value = { kind: "connecting" };
    expect(healthResponse.value).not.toBeNull();
  });
});
