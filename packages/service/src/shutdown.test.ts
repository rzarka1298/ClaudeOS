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

describe("wave-6: shutdown with an open event stream", () => {
  it("ends event streams at shutdown start so the listener closes, while an execution still drains", async () => {
    const http = await import("node:http");
    const { createEventBus } = await import("./events/event-bus.js");
    const { createEventStreamHandler } = await import("./events/event-stream-route.js");
    const bus = createEventBus();
    const handler = createEventStreamHandler(bus);
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const agent = new http.Agent({ keepAlive: true });
    const ended = new Promise<void>((resolve) => {
      http.get({ host: "127.0.0.1", port, agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("close", () => resolve());
      });
    });
    await vi.waitFor(() => expect(bus.subscriberCount()).toBe(1));

    const events: string[] = [];
    let release: () => void = () => undefined;
    const shutdown = createShutdown({
      stopApprovals: () =>
        new Promise<void>((resolve) => {
          release = () => {
            events.push("execution-settled");
            resolve();
          };
        }),
      stopUsage: async () => undefined,
      stopClaude: async () => undefined,
      stopIntake: () => undefined,
      closeServer: (done) => {
        server.close(done);
      },
      closeConnections: () => {
        bus.closeAll();
        server.closeIdleConnections();
      },
      closeResources: () => events.push("store-closed"),
      exit: (code) => events.push(`exit-${code}`),
      onError: () => events.push("error"),
      keepAlive: { start: () => 1, stop: () => undefined },
    });
    shutdown();
    await ended;
    expect(bus.subscriberCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]); // the execution still holds the exit
    release();
    await vi.waitFor(
      () => expect(events).toEqual(["execution-settled", "store-closed", "exit-0"]),
      {
        timeout: 2000,
      },
    );
    agent.destroy();
  });

  it("still stops the Claude services when the usage services reject", async () => {
    const h = harness();
    const stopUsage = vi.fn().mockRejectedValue(new Error("boom"));
    createShutdown({ ...h.deps, stopUsage })();
    h.release();
    h.closeServer();
    await tick();
    expect(h.events).toContain("claude");
    expect(h.events).toContain("error");
    expect(h.events.at(-1)).toBe("exit-0");
  });
});
