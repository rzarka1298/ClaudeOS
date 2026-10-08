import { describe, expect, it, vi } from "vitest";
import { createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import {
  createTestApprovalAction,
  TEST_APPROVAL_FAILED_NOTICE,
  TEST_APPROVAL_STARTED_NOTICE,
} from "./wiring.js";

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function setup(test = vi.fn().mockResolvedValue({ outcome: "proposed", proposalId: "x" })) {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const notices: string[] = [];
  const action = createTestApprovalAction(registry, { test }, (m) => notices.push(m));
  return { host, registry, notices, action, test };
}

describe("Test 2: the test approval action (plan 06-23, D-20, R-22)", () => {
  it("posts the start notice at once, calls the API once after the timer, and ignores a second press", async () => {
    const { host, notices, action, test } = setup();

    action.press();
    action.press();
    expect(notices).toEqual([TEST_APPROVAL_STARTED_NOTICE]);
    expect(TEST_APPROVAL_STARTED_NOTICE).toBe(
      "The test request arrives in 5 seconds. Switch to another app to see the notification.",
    );
    expect(test).not.toHaveBeenCalled();

    host.fireTimers();
    await flush();
    expect(test).toHaveBeenCalledTimes(1);

    action.press();
    expect(notices).toHaveLength(2);
  });

  it("counts the timer as one live registration", () => {
    const { host, registry } = setup();
    expect(host.liveCounts().timer).toBe(1);
    expect(registry.liveCount()).toBe(1);
  });
});

describe("Test 3: failure", () => {
  it("posts the fixed failure notice and re-enables the action", async () => {
    const test = vi.fn().mockRejectedValue(new Error("down"));
    const { host, notices, action } = setup(test);

    action.press();
    host.fireTimers();
    await flush();

    expect(notices).toEqual([TEST_APPROVAL_STARTED_NOTICE, TEST_APPROVAL_FAILED_NOTICE]);
    expect(TEST_APPROVAL_FAILED_NOTICE).toBe(
      "Couldn't send the test request. Check the service in Settings → Diagnostics, then try again.",
    );
    action.press();
    expect(notices).toHaveLength(3);
  });
});

describe("Test 5: unload", () => {
  it("cancels the pending call when the registry is disposed first", async () => {
    const { host, registry, action, test } = setup();

    action.press();
    registry.disposeAll();
    host.fireTimers();
    await flush();

    expect(test).not.toHaveBeenCalled();
    expect(host.liveCounts().timer).toBe(0);
  });
});
