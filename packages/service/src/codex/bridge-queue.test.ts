import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type AgentBridgeRequest,
  waitForClaim,
  withdrawRequest,
  writeAgentPins,
  writeBridgeRequest,
} from "./bridge-queue.js";

let fx: BridgeFixture;

beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
});

afterEach(() => {
  fx.cleanup();
});

function agentRequest(runId: string, overrides: Record<string, unknown> = {}): AgentBridgeRequest {
  return {
    runId,
    kind: "agent",
    mode: "agent",
    agent: "claude",
    projectRoot: fx.projectDir,
    cwd: fx.projectDir,
    argv: [fx.claudePath],
    env: { CCC_RUN_ID: "run-product-1", CCC_LAUNCH_SOURCE: "dashboard" },
    sessionId: null,
    liveLog: null,
    pid: null,
    createdAt: new Date().toISOString(),
    protocol: 2,
    ...overrides,
  } as AgentBridgeRequest;
}

const RUN_A = "20261010T120000000Z";
const RUN_B = "20261010T120000001Z";

describe("writeBridgeRequest and waitForClaim (tracer)", () => {
  it("writes the request atomically with mode 0600, a simulated window claims it, and the wait sees the claim after one poll", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const path = writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    expect(path).toBe(join(fx.requestsDir, `${RUN_A}.json`));
    expect(statSync(path as string).mode & 0o777).toBe(0o600);
    // No temp file is left behind: only the final name is in the directory.
    expect(readdirSync(fx.requestsDir)).toEqual([`${RUN_A}.json`]);
    expect(JSON.parse(readFileSync(path as string, "utf8"))).toMatchObject({
      runId: RUN_A,
      kind: "agent",
      mode: "agent",
      agent: "claude",
      protocol: 2,
    });

    let sleeps = 0;
    const result = await waitForClaim(fx.stateDir, RUN_A, {
      deadlineMs: 3500,
      pollMs: 100,
      now: () => 0,
      sleep: () => {
        sleeps += 1;
        // The extension's poll: the window claims the request.
        const claimed = sim.tick();
        expect(claimed).toHaveLength(1);
        return Promise.resolve();
      },
    });
    expect(result).toBe("claimed");
    expect(sleeps).toBe(1);
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([`${RUN_A}.json`]);
  });

  it("creates the queue directories when they are missing", () => {
    const fresh = join(fx.base, "fresh-state");
    expect(existsSync(fresh)).toBe(false);
    expect(writeBridgeRequest(fresh, agentRequest(RUN_A))).toBe(
      join(fresh, "requests", `${RUN_A}.json`),
    );
    expect(statSync(join(fresh, "requests")).mode & 0o777).toBe(0o700);
  });
});

describe("writeBridgeRequest refusals", () => {
  it("returns null and writes nothing when a request of the same run id already exists", () => {
    const first = writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    expect(first).not.toBeNull();
    const before = readFileSync(first as string, "utf8");
    expect(
      writeBridgeRequest(
        fx.stateDir,
        agentRequest(RUN_A, { agent: "codex", argv: [fx.codexPath] }),
      ),
    ).toBeNull();
    expect(readFileSync(first as string, "utf8")).toBe(before);
    expect(readdirSync(fx.requestsDir)).toEqual([`${RUN_A}.json`]);
  });

  it("returns null when the run id was already claimed (a claimed file is never overwritten)", () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    expect(sim.tick()).toHaveLength(1);
    expect(writeBridgeRequest(fx.stateDir, agentRequest(RUN_A))).toBeNull();
    expect(fx.requestFiles()).toEqual([]);
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["kind review", { kind: "review" }],
    ["mode follow", { mode: "follow" }],
    ["protocol 1", { protocol: 1 }],
    ["a bad run id", { runId: "../../etc/passwd" }],
    ["a session id", { sessionId: "abc" }],
    ["a live log", { liveLog: "/Users/USERNAME/x.log" }],
    ["a pid", { pid: 4 }],
    ["an agent that is not claude or codex", { agent: "bash" }],
    ["an argv that is not an array", { argv: "claude" }],
    ["a relative project root", { projectRoot: "project" }],
    ["a non-string env value", { env: { CCC_RUN_ID: 1 } }],
  ])("refuses a request with %s and writes nothing", (_name, overrides) => {
    expect(() => writeBridgeRequest(fx.stateDir, agentRequest(RUN_A, overrides))).toThrow(
      /request shape/,
    );
    expect(fx.requestFiles()).toEqual([]);
  });

  it("refuses a request that is missing one of the fixed keys", () => {
    const request = { ...agentRequest(RUN_A) } as Record<string, unknown>;
    delete request.createdAt;
    expect(() => writeBridgeRequest(fx.stateDir, request as unknown as AgentBridgeRequest)).toThrow(
      /request shape/,
    );
  });
});

describe("waitForClaim", () => {
  it("returns timeout at the deadline, polling no faster than the interval, on the injected clock", async () => {
    let t = 1_000;
    const sleeps: number[] = [];
    const result = await waitForClaim(fx.stateDir, RUN_A, {
      deadlineMs: 1000,
      pollMs: 100,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    expect(result).toBe("timeout");
    expect(sleeps.length).toBe(10);
    expect(sleeps.every((ms) => ms === 100)).toBe(true);
    expect(t).toBe(2_000);
  });

  it("never sleeps past the deadline", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const result = await waitForClaim(fx.stateDir, RUN_A, {
      deadlineMs: 250,
      pollMs: 100,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    expect(result).toBe("timeout");
    expect(sleeps).toEqual([100, 100, 50]);
  });

  it("returns claimed at once, without sleeping, when the claimed file already exists", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    sim.tick();
    let sleeps = 0;
    const result = await waitForClaim(fx.stateDir, RUN_A, {
      deadlineMs: 3500,
      now: () => 0,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    expect(result).toBe("claimed");
    expect(sleeps).toBe(0);
  });

  it("returns aborted for an already-aborted signal and when the signal fires during a sleep", async () => {
    const early = new AbortController();
    early.abort();
    expect(
      await waitForClaim(fx.stateDir, RUN_A, {
        deadlineMs: 3500,
        signal: early.signal,
        now: () => 0,
        sleep: () => Promise.resolve(),
      }),
    ).toBe("aborted");

    const late = new AbortController();
    expect(
      await waitForClaim(fx.stateDir, RUN_A, {
        deadlineMs: 3500,
        pollMs: 100,
        signal: late.signal,
        now: () => 0,
        sleep: () => {
          late.abort();
          return Promise.resolve();
        },
      }),
    ).toBe("aborted");
  });

  it("does not throw when the state directory does not exist", async () => {
    let t = 0;
    const result = await waitForClaim(join(fx.base, "nowhere"), RUN_A, {
      deadlineMs: 200,
      pollMs: 100,
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    });
    expect(result).toBe("timeout");
  });

  it("really waits on the default clock and sleep, and stops when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const result = await waitForClaim(fx.stateDir, RUN_A, {
      deadlineMs: 5000,
      pollMs: 1000,
      signal: controller.signal,
    });
    expect(result).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(900);
  });
});

describe("withdrawRequest", () => {
  it("removes an unclaimed request", () => {
    writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    expect(withdrawRequest(fx.stateDir, RUN_A)).toBe("withdrawn");
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });

  it("reports claimed, and keeps the claimed file, when a window claimed it meanwhile", () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    writeBridgeRequest(fx.stateDir, agentRequest(RUN_A));
    sim.tick();
    expect(withdrawRequest(fx.stateDir, RUN_A)).toBe("claimed");
    expect(fx.claimedFiles()).toEqual([`${RUN_A}.json`]);
  });

  it("reports gone for a request that never existed, and never throws on a missing directory", () => {
    expect(withdrawRequest(fx.stateDir, RUN_B)).toBe("gone");
    expect(withdrawRequest(join(fx.base, "nowhere"), RUN_B)).toBe("gone");
  });

  it("refuses a run id that is not the run id shape (no path can be built from it)", () => {
    expect(withdrawRequest(fx.stateDir, "../claimed/x")).toBe("gone");
  });
});

describe("writeAgentPins", () => {
  it("writes agent-pins.json atomically with mode 0600 and the helper's exact shape", () => {
    expect(writeAgentPins(fx.stateDir, { claude: fx.claudePath, codex: fx.codexPath })).toBe(true);
    const file = join(fx.stateDir, "agent-pins.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      schemaVersion: 1,
      claude: fx.claudePath,
      codex: fx.codexPath,
    });
    expect(readdirSync(fx.stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("omits an agent that has no saved launcher and rewrites on change only", () => {
    writeAgentPins(fx.stateDir, { claude: fx.claudePath });
    const file = join(fx.stateDir, "agent-pins.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      schemaVersion: 1,
      claude: fx.claudePath,
    });
    const before = statSync(file).ino;
    expect(writeAgentPins(fx.stateDir, { claude: fx.claudePath })).toBe(true);
    // An identical file is not rewritten (the inode is unchanged), yet the pin is in place.
    expect(statSync(file).ino).toBe(before);
    writeAgentPins(fx.stateDir, { claude: fx.claudePath, codex: fx.codexPath });
    expect(JSON.parse(readFileSync(file, "utf8")).codex).toBe(fx.codexPath);
  });

  it("refuses a pin that is not an absolute path and writes nothing", () => {
    expect(writeAgentPins(fx.stateDir, { claude: "claude" })).toBe(false);
    expect(existsSync(join(fx.stateDir, "agent-pins.json"))).toBe(false);
  });
});
