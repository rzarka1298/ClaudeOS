import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type FakeAppServerScenario,
  readFakeLog,
  writeFakeAppServer,
} from "../test-support/fake-codex-app-server.js";
import {
  CODEX_APP_SERVER_STOP_DEADLINE_MS,
  createRateLimitsClient,
  RATE_LIMITS_DISPOSE_GRACE_MS,
} from "./rate-limits-client.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** True while a process with this pid exists (signal 0 sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startRead(scenario: FakeAppServerScenario) {
  const dir = mkdtempSync(join(tmpdir(), "ccc-rl-dispose-"));
  dirs.push(dir);
  const server = writeFakeAppServer(dir, scenario);
  const client = createRateLimitsClient({
    executablePath: () => server.path,
    capMs: 20_000,
    killWaitMs: 2_000,
  });
  const pending = client.read();
  const deadline = Date.now() + 4000;
  while (readFakeLog(server.logPath).filter((e) => e.t === "line").length < 3) {
    if (Date.now() > deadline) throw new Error("the fake never saw the read request");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const start = readFakeLog(server.logPath).find((e) => e.t === "start");
  if (start?.t !== "start") throw new Error("no start entry");
  return { client, pending, pid: start.pid, dir };
}

describe("createRateLimitsClient dispose() awaits the child's exit", () => {
  it("the deadline covers the grace, the forced kill and a margin", () => {
    expect(RATE_LIMITS_DISPOSE_GRACE_MS).toBe(500);
    expect(CODEX_APP_SERVER_STOP_DEADLINE_MS).toBeGreaterThan(RATE_LIMITS_DISPOSE_GRACE_MS + 500);
    expect(CODEX_APP_SERVER_STOP_DEADLINE_MS).toBeLessThan(5_000);
  });

  it("a cooperative child is gone when dispose() resolves", async () => {
    const { client, pending, pid } = await startRead({ read: { kind: "hang" } });
    expect(alive(pid)).toBe(true);
    await client.dispose();
    expect(alive(pid)).toBe(false);
    expect(await pending).toMatchObject({ kind: "unavailable", reason: "read-failed" });
  }, 8000);

  it("a SIGTERM-ignoring child is SIGKILLed after the grace and gone when dispose() resolves", async () => {
    const { client, pending, pid } = await startRead({
      read: { kind: "hang" },
      ignoreTermination: true,
    });
    const started = Date.now();
    await client.dispose();
    const took = Date.now() - started;
    expect(alive(pid)).toBe(false);
    expect(took).toBeGreaterThanOrEqual(RATE_LIMITS_DISPOSE_GRACE_MS - 50);
    expect(took).toBeLessThan(CODEX_APP_SERVER_STOP_DEADLINE_MS);
    await pending;
    // A second dispose is a no-op that resolves.
    await client.dispose();
  }, 8000);

  it("dispose() with no read in flight resolves at once", async () => {
    const client = createRateLimitsClient({ executablePath: () => null });
    await client.dispose();
  });

  it("no fake app-server is left behind", () => {
    let out = "";
    try {
      out = execFileSync("pgrep", ["-f", "ccc-rl-dispose-"], { encoding: "utf8" });
    } catch {
      // pgrep exits 1 when nothing matches.
    }
    expect(out.trim()).toBe("");
  });
});
