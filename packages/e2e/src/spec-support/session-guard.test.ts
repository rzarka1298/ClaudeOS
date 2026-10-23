import { describe, expect, it } from "vitest";
import { type GuardTest, installSessionGuard, sessionLostMessage } from "./session-guard.js";

const LOST = new Error(
  "invalid session id: session deleted as the browser has closed the connection",
);

function harness(probe: () => Promise<unknown>) {
  let before: (() => Promise<void>) | undefined;
  let after: ((this: { currentTest?: GuardTest }) => void) | undefined;
  installSessionGuard(
    {
      beforeEach: (hook) => {
        before = hook;
      },
      afterEach: (hook) => {
        after = hook;
      },
    },
    probe,
  );
  return {
    beforeCase: async () => before?.(),
    afterCase: (test: GuardTest) => after?.call({ currentTest: test }),
  };
}

describe("installSessionGuard (FIX8)", () => {
  it("lets a case start while the session answers", async () => {
    const guard = harness(async () => true);
    await expect(guard.beforeCase()).resolves.toBeUndefined();
  });

  it("names the case that was running when the session died, and stops every later case with that message", async () => {
    let probes = 0;
    const guard = harness(async () => {
      probes += 1;
      return true;
    });
    await guard.beforeCase();
    guard.afterCase({ title: "[08-UAT#25] hooks", err: LOST });
    await expect(guard.beforeCase()).rejects.toThrow(
      /Obsidian closed during "\[08-UAT#25\] hooks"/,
    );
    await expect(guard.beforeCase()).rejects.toThrow(
      /Obsidian closed during "\[08-UAT#25\] hooks"/,
    );
    // Once lost it does not even probe again.
    expect(probes).toBe(1);
  });

  it("stops a case before it starts when the probe finds the session gone", async () => {
    const guard = harness(async () => {
      throw LOST;
    });
    await expect(guard.beforeCase()).rejects.toThrow(/Obsidian closed during an earlier case/);
  });

  it("does not treat an ordinary failure as a lost session", async () => {
    const guard = harness(async () => true);
    guard.afterCase({ title: "x", err: new Error("expected 1 to equal 2") });
    await expect(guard.beforeCase()).resolves.toBeUndefined();
  });

  it("passes an unrelated probe error through unchanged", async () => {
    const guard = harness(async () => {
      throw new Error("some other failure");
    });
    await expect(guard.beforeCase()).rejects.toThrow("some other failure");
  });

  it("words the message for a missing title", () => {
    expect(sessionLostMessage(undefined)).toContain("an earlier case");
  });
});
