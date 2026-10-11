import { describe, expect, it } from "vitest";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startServiceForTest cleanup (F8)", () => {
  it("kills the spawned service when the socket never becomes reachable", async () => {
    await withTempSocketDir(async ({ socketPath }) => {
      // Zero polls: the first connect happens before the service listens, so the wait fails.
      const error = await startServiceForTest({
        socketPath,
        dbPath: `${socketPath}.db`,
        waitAttempts: 0,
      }).then(
        () => null,
        (caught: unknown) => caught as { childPid?: number },
      );
      expect(error).not.toBeNull();
      const pid = error?.childPid;
      expect(typeof pid).toBe("number");
      await new Promise((r) => setTimeout(r, 500));
      expect(alive(pid as number)).toBe(false);
    });
  });
});
