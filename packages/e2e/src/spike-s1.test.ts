import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideS1, pollUntil, type S1Evidence } from "./spike-s1.js";

// Codex finding 3: S1 used to report pass whenever notification permission was granted, after a
// fixed 2.5 s wait that ends before the plugin's 5 s test-approval delay. These tests pin the
// corrected rule: pass only when the plugin itself created a notification and attached a click
// handler, and otherwise fail with the evidence.

const good: S1Evidence = {
  permission: "granted",
  buttonFound: true,
  blur: { method: "electron-remote-blur", hasFocusAfter: false },
  waitedMs: 5500,
  timedOut: false,
  pluginNotificationsCreated: 1,
  pluginClickHandlerExists: true,
};

describe("decideS1", () => {
  it("passes only with granted permission, a plugin notification and its click handler", () => {
    expect(decideS1(good).verdict).toBe("pass");
  });

  it("fails on the earlier negative run: permission granted, zero plugin notifications, no handler", () => {
    const earlier: S1Evidence = {
      ...good,
      blur: { method: "none", hasFocusAfter: true },
      waitedMs: 2500,
      pluginNotificationsCreated: 0,
      pluginClickHandlerExists: false,
    };
    const decision = decideS1(earlier);
    expect(decision.verdict).toBe("fail");
    expect(decision.reason).toMatch(/focus/i);
  });

  it("fails when the plugin created a notification but attached no click handler", () => {
    const decision = decideS1({ ...good, pluginClickHandlerExists: false });
    expect(decision.verdict).toBe("fail");
    expect(decision.reason).toMatch(/click handler/i);
  });

  it("fails when the handler flag is true but no notification was created", () => {
    expect(decideS1({ ...good, pluginNotificationsCreated: 0 }).verdict).toBe("fail");
  });

  it("fails on a timed-out wait even if the window was unfocused, naming the wait", () => {
    const decision = decideS1({
      ...good,
      timedOut: true,
      waitedMs: 15000,
      pluginNotificationsCreated: 0,
      pluginClickHandlerExists: false,
    });
    expect(decision.verdict).toBe("fail");
    expect(decision.reason).toMatch(/15000/);
  });

  it("fails when permission is not granted or the test-approval button was never found", () => {
    expect(decideS1({ ...good, permission: "denied" }).verdict).toBe("fail");
    expect(decideS1({ ...good, permission: "default" }).verdict).toBe("fail");
    const noButton = decideS1({ ...good, buttonFound: false });
    expect(noButton.verdict).toBe("fail");
    expect(noButton.reason).toMatch(/button/i);
  });
});

describe("pollUntil", () => {
  const instantSleep = async (): Promise<void> => undefined;

  it("returns as soon as the condition holds, without waiting the whole bound", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => ++calls,
      (n) => n >= 3,
      {
        timeoutMs: 15000,
        intervalMs: 500,
        sleep: instantSleep,
      },
    );
    expect(result).toEqual({ value: 3, timedOut: false, waitedMs: 1000 });
  });

  it("gives up after the bound with timedOut set and a bounded number of probes", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => ++calls,
      () => false,
      {
        timeoutMs: 15000,
        intervalMs: 500,
        sleep: instantSleep,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs).toBe(15000);
    expect(calls).toBe(31);
  });

  it("probes once even with a zero bound and sleeps only the interval", async () => {
    const sleeps: number[] = [];
    const result = await pollUntil(
      async () => 1,
      () => false,
      {
        timeoutMs: 0,
        intervalMs: 500,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result.timedOut).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("rejects a non-positive interval, which would never terminate", async () => {
    await expect(
      pollUntil(
        async () => 1,
        () => false,
        { timeoutMs: 100, intervalMs: 0, sleep: instantSleep },
      ),
    ).rejects.toThrow();
  });
});

describe("the S1 spec wiring (source)", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "smoke", "spikes.e2e.ts"),
    "utf8",
  );

  it("decides through decideS1 after a bounded poll that outlasts the plugin's 5 s delay", () => {
    expect(source).toContain("decideS1(");
    expect(source).toContain("pollUntil(");
    const wait = /S1_WAIT_MS\s*=\s*([\d_]+)/.exec(source);
    expect(Number((wait?.[1] ?? "0").replaceAll("_", ""))).toBeGreaterThanOrEqual(10000);
    // the old unconditional pass on permission alone and the fixed 2.5 s pause are gone
    expect(source).not.toContain('evidence.permission === "granted" ? "pass"');
    expect(source).not.toContain("pause(2500)");
  });

  it("unfocuses the window before it presses the test-approval button", () => {
    const unfocus = source.indexOf("unfocusWindow()");
    expect(unfocus).toBeGreaterThan(-1);
    expect(unfocus).toBeLessThan(source.indexOf('"Send a test approval"'));
  });
});
