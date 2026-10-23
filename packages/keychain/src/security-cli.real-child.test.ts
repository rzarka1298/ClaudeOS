import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { classifyPresenceResult, presenceSpawnOptions } from "./security-cli.js";

// FIX3A (test weakness a): the abort test in security-cli.test.ts only checks that the signal is
// handed to a MOCKED execa. This one spawns a REAL, harmless, long-running fixed binary
// (`/bin/sleep 10`, never `security`) through the SAME option object `hasSecret` uses, and proves
// that firing the signal kills the child promptly and that the outcome reads `error`.

const SLEEP = "/bin/sleep";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("hasSecret's spawn options, against a real child", () => {
  it("firing the caller's signal kills the child within one second and classifies it as error", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = execa(SLEEP, ["10"], presenceSpawnOptions(controller.signal));
    const pid = pending.pid;
    expect(typeof pid).toBe("number");
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.isCanceled).toBe(true);
    expect(classifyPresenceResult(result)).toBe("error");
    // The process is really gone, not merely abandoned.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid as number)).toBe(false);
  });

  it("the options carry the kill signal, the cap and ignored stdio, and add cancelSignal only when given one", () => {
    const controller = new AbortController();
    const withSignal = presenceSpawnOptions(controller.signal);
    expect(withSignal).toMatchObject({
      reject: false,
      killSignal: "SIGKILL",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cancelSignal: controller.signal,
    });
    expect(withSignal.timeout).toBeGreaterThan(0);
    expect(withSignal.timeout).toBeLessThanOrEqual(1500);
    expect(presenceSpawnOptions(undefined)).not.toHaveProperty("cancelSignal");
  });

  it("without a signal the same options still bound the child by the cap (a tiny cap here)", async () => {
    const options = { ...presenceSpawnOptions(undefined), timeout: 150 };
    const started = Date.now();
    const result = await execa(SLEEP, ["10"], options);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect(classifyPresenceResult(result)).toBe("error");
  });
});

describe("classifyPresenceResult", () => {
  it("maps exit 0 to present, exit 44 to absent, and everything else to error", () => {
    expect(classifyPresenceResult({ exitCode: 0, failed: false })).toBe("present");
    expect(classifyPresenceResult({ exitCode: 44 })).toBe("absent");
    expect(classifyPresenceResult({ exitCode: 1 })).toBe("error");
    expect(classifyPresenceResult({ exitCode: 0, failed: true })).toBe("error");
    expect(classifyPresenceResult({ exitCode: 44, isTerminated: true })).toBe("error");
    expect(classifyPresenceResult({ exitCode: 0, timedOut: true })).toBe("error");
  });
});
