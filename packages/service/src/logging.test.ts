import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, REDACTION_MARKER } from "./logging.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-log-test-"));
  logPath = join(dir, "service.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("logging redaction", () => {
  it("redacts token, secret, installSecret, authorization, and password at top level", () => {
    const logger = createLogger(logPath);
    logger.info(
      {
        token: "top-secret-token",
        secret: "top-secret-secret",
        installSecret: "top-secret-install",
        authorization: "Bearer top-secret-bearer",
        password: "hunter2",
      },
      "test line",
    );
    const [line] = readLines();
    const raw = JSON.stringify(line);
    for (const value of [
      "top-secret-token",
      "top-secret-secret",
      "top-secret-install",
      "top-secret-bearer",
      "hunter2",
    ]) {
      expect(raw).not.toContain(value);
    }
    expect(line?.token).toBe(REDACTION_MARKER);
    expect(line?.secret).toBe(REDACTION_MARKER);
    expect(line?.installSecret).toBe(REDACTION_MARKER);
    expect(line?.authorization).toBe(REDACTION_MARKER);
    expect(line?.password).toBe(REDACTION_MARKER);
  });

  it("redacts token/secret/password nested one level deep", () => {
    const logger = createLogger(logPath);
    logger.info(
      { nested: { token: "nested-token", secret: "nested-secret", password: "nested-pass" } },
      "nested line",
    );
    const [line] = readLines();
    const raw = JSON.stringify(line);
    expect(raw).not.toContain("nested-token");
    expect(raw).not.toContain("nested-secret");
    expect(raw).not.toContain("nested-pass");
  });

  it("redacts req.headers.authorization specifically", () => {
    const logger = createLogger(logPath);
    logger.info({ req: { headers: { authorization: "Bearer nested-header-secret" } } }, "req line");
    const [line] = readLines();
    expect(JSON.stringify(line)).not.toContain("nested-header-secret");
  });

  it("truncates a 200-kilobyte body field rather than logging it whole", () => {
    const logger = createLogger(logPath);
    const bigBody = "x".repeat(200 * 1024);
    logger.info({ body: bigBody }, "big body line");
    const [line] = readLines();
    const loggedBody = line?.body as string;
    expect(loggedBody.length).toBeLessThan(bigBody.length);
    expect(loggedBody).not.toBe(bigBody);
  });
});

// ---------------------------------------------------------------------------
// Approval payload redaction (06-12, D-19, A-6, research C-4 and S11, T-06-09)

const PAYLOAD_KEYS = ["payload", "before", "after", "diff"] as const;

/** Wraps `{ [key]: value }` in `depth` arbitrary parent objects, so the key sits `depth` levels down. */
function nestAt(depth: number, key: string, value: unknown): Record<string, unknown> {
  let node: Record<string, unknown> = { [key]: value };
  const parents = ["request", "body", "detail"];
  for (let level = 0; level < depth; level += 1) {
    node = { [parents[level] ?? "parent"]: node };
  }
  return node;
}

/** Reads the value at `depth` levels down along the parent names used by `nestAt`. */
function readAt(line: Record<string, unknown> | undefined, depth: number, key: string): unknown {
  const parents = ["request", "body", "detail"];
  let node: unknown = line;
  for (let level = depth - 1; level >= 0; level -= 1) {
    node = (node as Record<string, unknown> | undefined)?.[parents[level] ?? "parent"];
  }
  return (node as Record<string, unknown> | undefined)?.[key];
}

describe("approval payload redaction (06-12 Task 3)", () => {
  describe("Test 1: a canary at every depth never reaches the log file", () => {
    for (const key of PAYLOAD_KEYS) {
      for (const depth of [0, 1, 2, 3, 4, 5]) {
        it(`${key} at depth ${depth} is redacted`, () => {
          const canary = `CANARY-${key}-${depth}-ZZ`;
          const logger = createLogger(logPath);
          logger.info(nestAt(depth, key, canary), "canary line");
          expect(readFileSync(logPath, "utf8")).not.toContain(canary);
          const [line] = readLines();
          expect(readAt(line, depth, key)).toBe(REDACTION_MARKER);
        });
      }
    }

    it("redacts a structured canary, not only a string, at depth two", () => {
      const logger = createLogger(logPath);
      logger.info(
        { request: { body: { payload: { note: "CANARY-STRUCTURED", list: ["CANARY-LISTED"] } } } },
        "structured",
      );
      const text = readFileSync(logPath, "utf8");
      expect(text).not.toContain("CANARY-STRUCTURED");
      expect(text).not.toContain("CANARY-LISTED");
    });
  });

  describe("Test 2: no collateral damage", () => {
    it("still logs a fixed reason code, ids, states and hashes unredacted", () => {
      const logger = createLogger(logPath);
      logger.info(
        {
          proposalId: "p000000000000000000000001",
          operation: "diagnostic.test",
          state: "executing",
          payloadHash: "a".repeat(64),
          attempt: 2,
          reason: "token-expired",
          code: "retried-after-restart",
          counts: { expired: 1, purged: 0 },
        },
        "approval line",
      );
      const [line] = readLines();
      expect(line).toMatchObject({
        proposalId: "p000000000000000000000001",
        operation: "diagnostic.test",
        state: "executing",
        payloadHash: "a".repeat(64),
        attempt: 2,
        reason: "token-expired",
        code: "retried-after-restart",
        counts: { expired: 1, purged: 0 },
      });
    });

    it("keeps the credential paths exactly as before", () => {
      const logger = createLogger(logPath);
      logger.info(
        {
          token: "t-1",
          secret: "s-1",
          nested: { token: "t-2", authorization: "a-2", password: "p-2", refreshToken: "r-2" },
          req: { headers: { authorization: "a-3" } },
        },
        "credentials",
      );
      const text = readFileSync(logPath, "utf8");
      for (const value of ["t-1", "s-1", "t-2", "a-2", "p-2", "r-2", "a-3"]) {
        expect(text).not.toContain(value);
      }
    });
  });

  describe("Test 3: structure is the real protection", () => {
    it("an error object carrying a payload in its message would leak, so no caller may pass one", () => {
      const logger = createLogger(logPath);
      logger.error({ err: new Error("write failed for CANARY-IN-MESSAGE") }, "documented leak");
      // This is the gap redaction paths cannot close: the text sits in a message, not under a key.
      expect(readFileSync(logPath, "utf8")).toContain("CANARY-IN-MESSAGE");
    });

    it("a payload deeper than five parent levels is not covered by paths, which is why the engine never logs one", () => {
      const logger = createLogger(logPath);
      logger.info({ a: { b: { c: { d: { e: { f: { payload: "CANARY-TOO-DEEP" } } } } } } }, "documented limit");
      expect(readFileSync(logPath, "utf8")).toContain("CANARY-TOO-DEEP");
    });
  });
});
