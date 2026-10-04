import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logging.js";
import { logSocketClaimRefusal, SocketInUseError, SocketProbeError } from "./socket-server.js";

// The socket lives under the owner's home folder; a startup refusal must
// never put that path (or any path) into the service log — only the error
// name and code.
const HOME_SOCKET = join(homedir(), ".claude-command-center", "service.sock");

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-socket-log-"));
  logPath = join(dir, "service.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("logSocketClaimRefusal", () => {
  it.each([
    ["SocketInUseError", new SocketInUseError(HOME_SOCKET), "SOCKET_IN_USE"],
    ["SocketProbeError", new SocketProbeError(HOME_SOCKET, "ETIMEDOUT"), "ETIMEDOUT"],
  ])("logs %s with its name and code and no path", (name, err, code) => {
    const logger = createLogger(logPath);
    expect(logSocketClaimRefusal(logger, err)).toBe(true);
    logger.flush();
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const [record] = lines;
    expect(record?.error).toBe(name);
    expect(record?.code).toBe(code);
    const raw = JSON.stringify(record);
    expect(raw).not.toContain("/");
    expect(raw).not.toContain(homedir());
    expect(raw).not.toContain("service.sock");
  });

  it("returns false and logs nothing for any other error", () => {
    const logger = createLogger(logPath);
    expect(logSocketClaimRefusal(logger, new Error("boom"))).toBe(false);
    logger.flush();
    expect(readLines()).toHaveLength(0);
  });
});
