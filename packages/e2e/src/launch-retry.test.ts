import { describe, expect, it } from "vitest";
import { ensureLaunched, isLaunchDeath } from "./launch-retry.js";

const DEATH = new Error(
  "invalid session id: session deleted as the browser has closed the connection\nfrom disconnected: not connected to DevTools",
);

function ports(probes: Array<Error | null>) {
  const calls: string[] = [];
  const warnings: string[] = [];
  return {
    calls,
    warnings,
    ports: {
      probe: async () => {
        calls.push("probe");
        const next = probes.shift();
        if (next) throw next;
        return 1;
      },
      relaunch: async () => {
        calls.push("relaunch");
      },
      warn: (message: string) => warnings.push(message),
    },
  };
}

describe("launch retry", () => {
  it("recognises only the closed-connection death", () => {
    expect(isLaunchDeath(DEATH)).toBe(true);
    expect(isLaunchDeath(new Error("invalid session id when running execute/sync"))).toBe(false);
    expect(isLaunchDeath(new Error("timeout"))).toBe(false);
  });

  it("does nothing when the first probe answers", async () => {
    const t = ports([null]);
    expect(await ensureLaunched(t.ports)).toBe(false);
    expect(t.calls).toEqual(["probe"]);
    expect(t.warnings).toEqual([]);
  });

  it("relaunches once, warns, and re-probes after a launch death", async () => {
    const t = ports([DEATH, null]);
    expect(await ensureLaunched(t.ports)).toBe(true);
    expect(t.calls).toEqual(["probe", "relaunch", "probe"]);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("run-problem warning");
  });

  it("does not retry a second death", async () => {
    const t = ports([DEATH, DEATH]);
    await expect(ensureLaunched(t.ports)).rejects.toBe(DEATH);
    expect(t.calls.filter((call) => call === "relaunch")).toHaveLength(1);
  });

  it("does not retry any other failure", async () => {
    const other = new Error("boom");
    const t = ports([other]);
    await expect(ensureLaunched(t.ports)).rejects.toBe(other);
    expect(t.calls).toEqual(["probe"]);
  });
});

import { isSessionDeath, retryOnSessionDeath } from "./launch-retry.js";

describe("retryOnSessionDeath", () => {
  const dead = new Error("Timed out; last observed: threw: WebDriverError: invalid session id");
  it("runs the body once when it passes", async () => {
    let runs = 0;
    const warnings: string[] = [];
    await retryOnSessionDeath(
      async () => {
        runs += 1;
      },
      async () => {},
      (m) => warnings.push(m),
    );
    expect(runs).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("relaunches and reruns once after a window death, with a warning", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    let first = true;
    const result = await retryOnSessionDeath(
      async () => {
        calls.push("body");
        if (first) {
          first = false;
          throw dead;
        }
        return "ok";
      },
      async () => void calls.push("relaunch"),
      (m) => warnings.push(m),
    );
    expect(result).toBe("ok");
    expect(calls).toEqual(["body", "relaunch", "body"]);
    expect(warnings).toHaveLength(1);
  });

  it("does not rerun a second death or an unrelated failure", async () => {
    await expect(
      retryOnSessionDeath(
        async () => {
          throw dead;
        },
        async () => {},
        () => {},
      ),
    ).rejects.toBe(dead);
    let runs = 0;
    const other = new Error("expected 1 to be 2");
    await expect(
      retryOnSessionDeath(
        async () => {
          runs += 1;
          throw other;
        },
        async () => {},
        () => {},
      ),
    ).rejects.toBe(other);
    expect(runs).toBe(1);
    expect(isSessionDeath(other)).toBe(false);
  });
});
