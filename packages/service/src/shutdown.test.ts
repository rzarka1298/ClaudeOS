import { describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownDeps } from "./shutdown.js";

function harness() {
  const events: string[] = [];
  let releaseExecution: () => void = () => undefined;
  let serverDone: () => void = () => undefined;
  const deps: ShutdownDeps = {
    stopApprovals: () =>
      new Promise<void>((resolve) => {
        releaseExecution = () => {
          events.push("execution-settled");
          resolve();
        };
      }),
    stopUsage: async () => {
      events.push("usage");
    },
    stopClaude: async () => {
      events.push("claude");
    },
    stopIntake: () => events.push("intake"),
    closeServer: (done) => {
      serverDone = done;
    },
    closeResources: () => events.push("store-closed"),
    exit: (code) => events.push(`exit-${code}`),
    onError: () => events.push("error"),
    keepAlive: {
      start: () => {
        events.push("keepalive-start");
        return 1;
      },
      stop: () => events.push("keepalive-stop"),
    },
  };
  return {
    events,
    deps,
    release: () => releaseExecution(),
    closeServer: () => serverDone(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("graceful shutdown (wave-5 Codex)", () => {
  it("holds a referenced keep-alive and never exits while an execution is in flight", async () => {
    const h = harness();
    const shutdown = createShutdown(h.deps);
    shutdown();
    shutdown(); // a second signal is a no-op
    h.closeServer(); // listener already closed, no connections
    await tick();
    expect(h.events).toEqual(["keepalive-start", "intake"]);
    h.release();
    await tick();
    expect(h.events).toEqual([
      "keepalive-start",
      "intake",
      "execution-settled",
      "usage",
      "claude",
      "store-closed",
      "keepalive-stop",
      "exit-0",
    ]);
  });

  it("still tears down in order when the approvals drain rejects", async () => {
    const h = harness();
    const stopApprovals = vi.fn().mockRejectedValue(new Error("boom"));
    createShutdown({ ...h.deps, stopApprovals })();
    h.closeServer();
    await tick();
    expect(h.events).toEqual([
      "keepalive-start",
      "intake",
      "error",
      "usage",
      "claude",
      "store-closed",
      "keepalive-stop",
      "exit-0",
    ]);
  });

  it("holds a real referenced timer by default until the drain finishes", async () => {
    const h = harness();
    const { keepAlive: _omit, ...rest } = h.deps;
    const spy = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    createShutdown(rest)();
    const handle = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(true);
    h.release();
    h.closeServer();
    await tick();
    expect(clear).toHaveBeenCalledWith(handle);
    spy.mockRestore();
    clear.mockRestore();
  });
});
