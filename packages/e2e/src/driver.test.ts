import { describe, expect, it } from "vitest";
import {
  assertSandboxConnected,
  type DriverBrowser,
  parseCountInWords,
  pollUntil,
  runPluginCommand,
  type SandboxProbe,
} from "./driver.js";

function fakeClock() {
  let now = 1000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe("pollUntil (Test 6)", () => {
  it("resolves with the first truthy value, polling at the interval", async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await pollUntil(
      () => {
        calls += 1;
        return calls >= 3 ? { ready: true } : null;
      },
      { timeoutMs: 5000, intervalMs: 250, describe: "the pane to render", ...clock },
    );
    expect(value).toEqual({ ready: true });
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([250, 250]);
  });

  it("awaits an async check and treats a throwing check as not ready yet", async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await pollUntil(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("element not found");
        return calls === 2 ? 0 : "done";
      },
      { timeoutMs: 5000, intervalMs: 100, describe: "x", ...clock },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("rejects on timeout with describe and last value when the check never turns truthy", async () => {
    const clock = fakeClock();
    let error: Error | null = null;
    try {
      await pollUntil(() => 0, {
        timeoutMs: 1000,
        intervalMs: 300,
        describe: "the task count to reach 3",
        ...clock,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).not.toBeNull();
    expect(error?.message).toContain("the task count to reach 3");
    expect(error?.message).toContain("0");
    expect(error?.message).toContain("1000");
    // Bounded: it stopped near the timeout instead of looping forever, and never used a real sleep.
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1300);
  });

  it("reports the last thrown message when the check only throws", async () => {
    const clock = fakeClock();
    await expect(
      pollUntil(
        () => {
          throw new Error("no such element");
        },
        { timeoutMs: 500, intervalMs: 100, describe: "the heading", ...clock },
      ),
    ).rejects.toThrow(/the heading[\s\S]*no such element/);
  });
});

describe("parseCountInWords (Test 7)", () => {
  it("parses the three wordings", () => {
    expect(parseCountInWords("Today, 3 tasks")).toEqual({ label: "Today", count: 3 });
    expect(parseCountInWords("Overdue, 1 task")).toEqual({ label: "Overdue", count: 1 });
    expect(parseCountInWords("Blocked, no tasks")).toEqual({ label: "Blocked", count: 0 });
    expect(parseCountInWords("  Next 7 days, 12 tasks ")).toEqual({
      label: "Next 7 days",
      count: 12,
    });
  });

  it("reads a grouped count as the plugin renders it (the 10,000-task baseline failure)", () => {
    expect(parseCountInWords("All, 10,000 tasks")).toEqual({ label: "All", count: 10000 });
    expect(parseCountInWords("Today, 1,234 tasks")).toEqual({ label: "Today", count: 1234 });
  });

  it("returns null for anything else", () => {
    for (const text of [
      "",
      "3 tasks",
      "Today 3 tasks",
      "Today, three tasks",
      "Today, 3 tasks extra",
      "Today, -1 tasks",
      "Today, 3",
      "Today, no task items",
    ]) {
      expect(parseCountInWords(text), text).toBeNull();
    }
  });
});

function probeBrowser(probe: SandboxProbe | null): DriverBrowser {
  return {
    executeObsidian: async () => probe as never,
    executeObsidianCommand: async () => {},
  };
}

const SANDBOX = "/tmp/ccc-uat-z/svc.sock";

describe("assertSandboxConnected (Test 8)", () => {
  it("passes when the environment matches and the override is the same path or null", async () => {
    await expect(
      assertSandboxConnected(
        probeBrowser({ envSocketPath: SANDBOX, pluginSocketOverride: SANDBOX }),
        { expectedSocketPath: SANDBOX },
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertSandboxConnected(probeBrowser({ envSocketPath: SANDBOX, pluginSocketOverride: null }), {
        expectedSocketPath: SANDBOX,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws a fixed category-only message for a mismatched environment", async () => {
    const real = "/home-elsewhere/ccc/svc.sock";
    const error = await assertSandboxConnected(
      probeBrowser({ envSocketPath: real, pluginSocketOverride: SANDBOX }),
      { expectedSocketPath: SANDBOX },
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Sandbox isolation check failed: the renderer socket environment is not the sandbox socket.",
    );
    expect((error as Error).message).not.toContain(real);
  });

  it("throws for a missing environment value and for a different override", async () => {
    await expect(
      assertSandboxConnected(probeBrowser({ envSocketPath: null, pluginSocketOverride: null }), {
        expectedSocketPath: SANDBOX,
      }),
    ).rejects.toThrow(/renderer socket environment/);
    const other = "/home-elsewhere/ccc/svc.sock";
    const error = await assertSandboxConnected(
      probeBrowser({ envSocketPath: SANDBOX, pluginSocketOverride: other }),
      { expectedSocketPath: SANDBOX },
    ).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "Sandbox isolation check failed: the plugin socket override is not the sandbox socket.",
    );
    expect((error as Error).message).not.toContain(other);
  });

  it("throws when the probe returns nothing usable", async () => {
    await expect(
      assertSandboxConnected(probeBrowser(null), { expectedSocketPath: SANDBOX }),
    ).rejects.toThrow(/Sandbox isolation check failed/);
  });

  it("refuses an empty expected path before probing", async () => {
    let probed = false;
    const browser: DriverBrowser = {
      executeObsidian: async () => {
        probed = true;
        return null as never;
      },
      executeObsidianCommand: async () => {},
    };
    await expect(assertSandboxConnected(browser, { expectedSocketPath: "" })).rejects.toThrow();
    expect(probed).toBe(false);
  });
});

describe("runPluginCommand", () => {
  it("runs a registered command and fails naming the id when it is not registered", async () => {
    const ran: string[] = [];
    const browser: DriverBrowser = {
      executeObsidian: async (_fn, ...args) =>
        (args[0] === "claude-command-center:open-overview") as never,
      executeObsidianCommand: async (id) => {
        ran.push(id);
      },
    };
    await runPluginCommand(browser, "claude-command-center:open-overview");
    expect(ran).toEqual(["claude-command-center:open-overview"]);
    await expect(runPluginCommand(browser, "claude-command-center:nope")).rejects.toThrow(
      "Plugin command is not registered: claude-command-center:nope",
    );
    expect(ran).toHaveLength(1);
  });
});
