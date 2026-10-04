import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestOverSocket, startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const SERVICE_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../service/dist/main.js",
);

let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
});

/** The exit code, or `null` (after killing it) if it is still running at the deadline. */
function exitCodeWithin(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("a second service instance never takes over a live socket", () => {
  it("exits non-zero with a clear log line, leaves the socket in place, and the first keeps serving", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const first = await startServiceForTest({ socketPath, dbPath: join(dir, "operational.db") });
      try {
        const second = spawn(process.execPath, [SERVICE_ENTRY], {
          env: { ...process.env, CCC_SOCKET_PATH: socketPath, CCC_RUNTIME_DIR: dir },
          stdio: "ignore",
        });
        const code = await exitCodeWithin(second, 8_000);

        expect(code).toBe(1);
        expect(statSync(socketPath).isSocket()).toBe(true);
        const response = await requestOverSocket(socketPath, { method: "GET", path: "/" });
        expect(response.status).toBeGreaterThan(0);
        const logPath = join(dir, "logs", "service.log");
        expect(existsSync(logPath)).toBe(true);
        expect(readFileSync(logPath, "utf8")).toContain(
          "startup refused: another service instance is already listening",
        );
      } finally {
        await first.stop();
      }
    });
  });
});
