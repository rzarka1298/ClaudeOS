import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_DOCTOR_PATH,
  CodexActionErrorBodySchema,
  type CodexDoctorSummary,
  CodexDoctorSummarySchema,
} from "@ccc/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import { logger } from "../logging.js";
import { type Handler, INVALID_BODY_BODY, type RouteContext } from "../route-kit.js";
import {
  DOCTOR_DECOY_ACCOUNT,
  DOCTOR_DECOY_PATH,
  doctorReport,
  writeFakeDoctor,
} from "../test-support/fake-codex-doctor.js";
import { createDoctorProbe, type DoctorRunResult } from "./doctor-probe.js";
import { doctorRoutes } from "./doctor-routes.js";

/**
 * The owner-triggered doctor route (plan 05.1-21, CODEX-03, R4, D-17): POST
 * only, a strict empty body, an allowlisted summary and constant error bodies.
 */

const SECRET = Buffer.from("doctor-routes-test-secret-0123456789ab");
const dir = mkdtempSync(join(tmpdir(), "ccc-dr-"));
const socketPath = join(dir, "s");

const SUMMARY: CodexDoctorSummary = {
  overall: "warning",
  codexVersion: "0.159.2",
  checks: [{ id: "install.version", category: "install", status: "ok" }],
};

let runs = 0;
let nextRun: () => Promise<DoctorRunResult> = () =>
  Promise.resolve({ kind: "ok", summary: SUMMARY, checkedAt: "2026-10-10T12:00:00.000Z" });
let present = true;

/** The router's lookup and constant not-found body, mirrored from `createRequestListener`. */
function listener(table: Record<string, Record<string, Handler>>, ctx: RouteContext) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    const handler = table[path]?.[req.method ?? "GET"];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such route" }));
      return;
    }
    handler(req, res, ctx);
  };
}

const ctx = {
  store: {},
  getSecret: () => SECRET,
  eventBus: createEventBus(),
} as unknown as RouteContext;

let server: Server | null = null;

function startServer(): Promise<void> {
  const table = doctorRoutes(() =>
    present
      ? {
          run: () => {
            runs += 1;
            return nextRun();
          },
        }
      : undefined,
  );
  server = http.createServer(listener(table, ctx));
  return new Promise((resolve) => server?.listen(socketPath, resolve));
}

function request(
  method: string,
  body: string | null,
  token = true,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: CODEX_DOCTOR_PATH,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${mintToken(SECRET, { nowMs: Date.now() })}` } : {}),
          ...(body === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

beforeAll(async () => {
  await startServer();
});
afterEach(() => {
  runs = 0;
  present = true;
  nextRun = () =>
    Promise.resolve({ kind: "ok", summary: SUMMARY, checkedAt: "2026-10-10T12:00:00.000Z" });
});
afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/v1/codex/doctor (tracer, CODEX-03)", () => {
  it("Test 4: a strict empty body runs the check once and answers the allowlisted summary", async () => {
    const reply = await request("POST", "{}");
    expect(reply.status).toBe(200);
    expect(CodexDoctorSummarySchema.parse(reply.body)).toEqual(SUMMARY);
    expect(reply.body).toEqual(SUMMARY);
    expect(runs).toBe(1);
  });

  it("Test 4: the Codex deps being absent is the constant 503 and nothing runs", async () => {
    present = false;
    const reply = await request("POST", "{}");
    expect(reply.status).toBe(503);
    expect(CodexActionErrorBodySchema.parse(reply.body)).toEqual({ error: "unavailable" });
    expect(runs).toBe(0);
  });

  it("Test 4: no saved executable is the same constant 503", async () => {
    nextRun = () => Promise.resolve({ kind: "unavailable" });
    const reply = await request("POST", "{}");
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: "unavailable" });
  });

  it("Test 4: a failed run is the constant failed body", async () => {
    nextRun = () => Promise.resolve({ kind: "failed" });
    const reply = await request("POST", "{}");
    expect(reply.status).toBe(502);
    expect(CodexActionErrorBodySchema.parse(reply.body)).toEqual({ error: "failed" });
  });

  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "Test 4: %s reaches the constant not-found",
    async (verb) => {
      const reply = await request(verb, null);
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({ error: "no such route" });
      expect(runs).toBe(0);
    },
  );

  it.each([
    ["a key", '{"path":"/x"}'],
    ["an argv member", '{"argv":["--yolo"]}'],
    ["an array", "[]"],
    ["invalid JSON", "{"],
    ["an empty body", ""],
  ])("Test 4: %s is the constant 400 and nothing runs", async (_name, body) => {
    const reply = await request("POST", body);
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual(INVALID_BODY_BODY);
    expect(runs).toBe(0);
  });

  it("requires the bearer token", async () => {
    const reply = await request("POST", "{}", false);
    expect(reply.status).toBe(401);
    expect(runs).toBe(0);
  });

  it("an output the domain schema refuses is a constant 500, never sent", async () => {
    nextRun = () =>
      Promise.resolve({
        kind: "ok",
        summary: {
          overall: "ok",
          codexVersion: null,
          checks: [],
          extra: DOCTOR_DECOY_PATH,
        } as never,
        checkedAt: "2026-10-10T12:00:00.000Z",
      });
    const reply = await request("POST", "{}");
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).not.toContain(DOCTOR_DECOY_PATH);
  });
});

describe("what the response and the logs carry (Test 6, T-05.1-06)", () => {
  it("a real probe over a decoy-laden report answers none of the decoys", async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "ccc-dr-fake-"));
    const fake = writeFakeDoctor(fakeDir, {
      behavior: { kind: "print", stdout: doctorReport() },
      stderrNoise: true,
    });
    const probe = createDoctorProbe({ executablePath: () => fake.path });
    nextRun = () => probe.run();
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const info = vi.spyOn(logger, "info");
    try {
      const reply = await request("POST", "{}");
      expect(reply.status).toBe(200);
      const wire = JSON.stringify(reply.body);
      expect(wire).not.toContain(DOCTOR_DECOY_PATH);
      expect(wire).not.toContain(DOCTOR_DECOY_ACCOUNT);
      expect(CodexDoctorSummarySchema.parse(reply.body).checks).toHaveLength(2);
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...info.mock.calls]);
      expect(logged).not.toContain(DOCTOR_DECOY_PATH);
      expect(logged).not.toContain(DOCTOR_DECOY_ACCOUNT);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("a run that throws is a constant 500 and the log carries no message", async () => {
    nextRun = () => Promise.reject(new Error(`boom ${DOCTOR_DECOY_PATH} ${DOCTOR_DECOY_ACCOUNT}`));
    const error = vi.spyOn(logger, "error");
    try {
      const reply = await request("POST", "{}");
      expect(reply.status).toBe(500);
      const logged = JSON.stringify(error.mock.calls, (_key, value: unknown) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value,
      );
      expect(logged).not.toContain(DOCTOR_DECOY_PATH);
      expect(logged).not.toContain(DOCTOR_DECOY_ACCOUNT);
    } finally {
      error.mockRestore();
    }
  });
});

describe("nothing schedules a doctor run (Test 5, R4: owner-triggered only)", () => {
  const SERVICE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

  function sources(root: string): string[] {
    const found: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test-support" && entry.name !== "node_modules") walk(path);
        } else if (/\.ts$/.test(entry.name) && !/\.(test|audit\.test)\.ts$/.test(entry.name)) {
          found.push(path);
        }
      }
    };
    walk(root);
    return found;
  }

  const files = sources(SERVICE_SRC);
  const rel = (path: string): string => relative(SERVICE_SRC, path);
  const importsProbe = files.filter((path) =>
    /doctor-probe\.js|createDoctorProbe/.test(readFileSync(path, "utf8")),
  );

  it("only the probe, the route file and the composition root name the probe", () => {
    expect(
      importsProbe
        .map(rel)
        .sort()
        .filter((name) => name !== "main.ts"),
    ).toEqual(["codex/doctor-probe.ts", "codex/doctor-routes.ts"]);
  });

  it("no file that names the probe or the routes holds a timer or interval", () => {
    for (const path of files) {
      const name = rel(path);
      if (name === "codex/doctor-probe.ts") continue;
      const text = readFileSync(path, "utf8");
      if (!/doctor-probe\.js|doctor-routes\.js|createDoctorProbe|doctorRoutes/.test(text)) continue;
      if (name === "main.ts") {
        // The composition root has timers of its own; none may sit on a line that names doctor.
        for (const line of text.split("\n")) {
          if (/doctor/i.test(line))
            expect(line, name).not.toMatch(/setInterval|setTimeout|\.run\(|cron/i);
        }
        continue;
      }
      expect(text, name).not.toMatch(/setInterval|setTimeout|croner|\bCron\b/);
    }
  });

  it("the probe itself has no interval, only the cap and kill timeouts", () => {
    const text = readFileSync(join(SERVICE_SRC, "codex", "doctor-probe.ts"), "utf8");
    expect(text).not.toMatch(/setInterval/);
  });

  it("detection never reaches the probe, and the route table holds a POST entry only", () => {
    for (const name of ["codex/detection.ts", "projects/detection.ts"]) {
      expect(readFileSync(join(SERVICE_SRC, name), "utf8"), name).not.toMatch(
        /doctor-probe|doctor-routes|createDoctorProbe|doctor --json/,
      );
    }
    const table = doctorRoutes(() => undefined);
    expect(Object.keys(table)).toEqual([CODEX_DOCTOR_PATH]);
    expect(Object.keys(table[CODEX_DOCTOR_PATH] ?? {})).toEqual(["POST"]);
  });
});
