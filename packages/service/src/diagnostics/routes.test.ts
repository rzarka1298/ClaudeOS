import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTICS_HEALTH_PATH,
  DiagnosticsErrorBodySchema,
  DiagnosticsHealthResponseSchema,
  HEALTH_PATH,
  type HealthTrigger,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logged: { level: string; args: unknown[] }[] = [];
vi.mock("../logging.js", async () => {
  const actual = await vi.importActual<typeof import("../logging.js")>("../logging.js");
  const capture =
    (level: string) =>
    (...args: unknown[]) => {
      logged.push({ level, args });
    };
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
      debug: capture("debug"),
    },
  };
});

import {
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
} from "../test-support/approval-fixtures.js";
import { freshInstallResponse } from "../test-support/diagnostics-fixtures.js";
import { diagnosticsRoutes } from "./routes.js";
import type { DiagnosticsServices } from "./services.js";

/**
 * Plan 08-07 Task 1 Test 2 (route; D-02, D-43, T-08-14, T-08-15): the diagnostics health route
 * through the real request listener. The uniform 401, the constant 404 for another method, the
 * closed 503 and 500 bodies, the error-class-name-only log line, and the trigger query (Amendment
 * A1): only an exact `gesture` is a gesture.
 */

const UNAUTHENTICATED = { error: "authentication required" };
const NO_ROUTE = { error: "no such route" };
/** Text a thrown error carries; it must reach neither a response nor a log line. */
const SECRET_PATH = "/Users/USERNAME/private-vault/notes.md";

let baseDir: string;
let store: OperationalStore;
let harness: RouteHarness | undefined;
let calls: HealthTrigger[];
let behaviour: () => Promise<unknown>;

beforeAll(() => {
  const base = join(homedir(), ".ccc-test");
  mkdirSync(base, { recursive: true });
  baseDir = mkdtempSync(join(base, "diag-routes-"));
  store = openStore(join(baseDir, "operational.db"));
  applyMigrations(store.db);
});

afterAll(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  logged.length = 0;
  calls = [];
  behaviour = () => Promise.resolve(freshInstallResponse());
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(withServices = true): Promise<RouteHarness> {
  const services: DiagnosticsServices = {
    check: (trigger) => {
      calls.push(trigger);
      return behaviour() as ReturnType<DiagnosticsServices["check"]>;
    },
  };
  harness = await startRouteHarness(store, withServices ? { diagnostics: services } : {});
  return harness;
}

function get(h: RouteHarness, path: string, token: string | null | undefined = h.token) {
  return requestOverSocket<unknown>(h.socketPath, {
    method: "GET",
    path,
    ...(token === null || token === undefined ? {} : { token }),
  });
}

describe("auth, methods and the route table", () => {
  it("answers the uniform 401 without a valid bearer token and never runs the services", async () => {
    const h = await start();
    expect((await get(h, DIAGNOSTICS_HEALTH_PATH, null)).body).toEqual(UNAUTHENTICATED);
    const bad = await get(h, DIAGNOSTICS_HEALTH_PATH, "not-a-token");
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual(UNAUTHENTICATED);
    expect(calls).toEqual([]);
  });

  it("answers the constant 404 to every other method", async () => {
    const h = await start();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const reply = await requestOverSocket<unknown>(h.socketPath, {
        method,
        path: DIAGNOSTICS_HEALTH_PATH,
        token: h.token,
        body: {},
      });
      expect(reply.status, method).toBe(404);
      expect(reply.body, method).toEqual(NO_ROUTE);
    }
    expect(calls).toEqual([]);
  });

  it("registers exactly one fixed path, GET only, beside the untouched Phase 1 health path", () => {
    expect(Object.keys(diagnosticsRoutes)).toEqual([DIAGNOSTICS_HEALTH_PATH]);
    expect(Object.keys(diagnosticsRoutes[DIAGNOSTICS_HEALTH_PATH] ?? {})).toEqual(["GET"]);
    expect(DIAGNOSTICS_HEALTH_PATH).not.toBe(HEALTH_PATH);
  });
});

describe("the closed answers", () => {
  it("answers a body that parses with the strict domain schema", async () => {
    const h = await start();
    const reply = await get(h, DIAGNOSTICS_HEALTH_PATH);
    expect(reply.status).toBe(200);
    expect(DiagnosticsHealthResponseSchema.safeParse(reply.body).success).toBe(true);
  });

  it("answers 503 service-disconnected when the diagnostics services are absent", async () => {
    const h = await start(false);
    const reply = await get(h, DIAGNOSTICS_HEALTH_PATH);
    expect(reply.status).toBe(503);
    expect(DiagnosticsErrorBodySchema.parse(reply.body)).toEqual({ error: "service-disconnected" });
  });

  it("answers 500 internal to an unexpected throw and logs the route and the error class name only", async () => {
    behaviour = () => Promise.reject(new TypeError(`ENOENT: open '${SECRET_PATH}'`));
    const h = await start();
    const reply = await get(h, DIAGNOSTICS_HEALTH_PATH);
    expect(reply.status).toBe(500);
    expect(DiagnosticsErrorBodySchema.parse(reply.body)).toEqual({ error: "internal" });
    expect(reply.raw).not.toContain(SECRET_PATH);

    const errors = logged.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    const [fields] = errors[0]?.args ?? [];
    expect(fields).toEqual({ route: DIAGNOSTICS_HEALTH_PATH, errorName: "TypeError" });
    expect(JSON.stringify(logged)).not.toContain(SECRET_PATH);
  });

  it("answers 500 internal to a synchronous throw as well", async () => {
    behaviour = () => {
      throw new RangeError(SECRET_PATH);
    };
    const h = await start();
    const reply = await get(h, DIAGNOSTICS_HEALTH_PATH);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: "internal" });
    expect(JSON.stringify(logged)).not.toContain(SECRET_PATH);
  });
});

describe("the trigger query (Amendment A1)", () => {
  it("passes gesture only for an exact trigger=gesture", async () => {
    const h = await start();
    expect((await get(h, `${DIAGNOSTICS_HEALTH_PATH}?trigger=gesture`)).status).toBe(200);
    expect(calls).toEqual(["gesture"]);
  });

  it("treats a missing, empty, unrecognised, mis-cased or repeated trigger as reconnect", async () => {
    const h = await start();
    const paths = [
      DIAGNOSTICS_HEALTH_PATH,
      `${DIAGNOSTICS_HEALTH_PATH}?trigger=`,
      `${DIAGNOSTICS_HEALTH_PATH}?trigger=bogus`,
      `${DIAGNOSTICS_HEALTH_PATH}?trigger=Gesture`,
      `${DIAGNOSTICS_HEALTH_PATH}?trigger=gesture%20`,
      `${DIAGNOSTICS_HEALTH_PATH}?trigger=gesture&trigger=reconnect`,
      `${DIAGNOSTICS_HEALTH_PATH}?other=gesture`,
    ];
    for (const path of paths) {
      expect((await get(h, path)).status, path).toBe(200);
    }
    expect(calls).toEqual(paths.map(() => "reconnect"));
  });

  it("passes an explicit reconnect through", async () => {
    const h = await start();
    await get(h, `${DIAGNOSTICS_HEALTH_PATH}?trigger=reconnect`);
    expect(calls).toEqual(["reconnect"]);
  });
});
