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
