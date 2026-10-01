import { LAUNCHERS_DETECT_PATH, LAUNCHERS_SAVE_PATH } from "@ccc/domain";
import { listLauncherConfigs } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";

/**
 * Audit (04-11, T-04-10, D-27): a hostile or wildcard bundle-ID override at the
 * save route never reaches a Spotlight query and stores nothing, and detection
 * alone never saves. Every process port is a fake.
 */

let harness: LauncherHarness;

beforeEach(async () => {
  harness = await startLauncherHarness({ script: [] });
});

afterEach(() => {
  harness.close();
});

describe("save-time bundle-ID override validation (audit)", () => {
  it.each(["com.x' || kMDItemDisplayName == '*", "com.google.antigravity*", "com x", ""])(
    "refuses %j, stores nothing, and never queries mdfind with it",
    async (bundleId) => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
        launcherId: "antigravity",
        bundleId,
      });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
      expect(listLauncherConfigs(harness.store.db)).toEqual([]);
      for (const call of harness.runner.calls) {
        if (bundleId !== "") expect(call.args.join(" ")).not.toContain(bundleId);
      }
    },
  );

  it("detection proposes only: a detect request stores no launcher configuration", async () => {
    const reply = await harness.post(LAUNCHERS_DETECT_PATH, {});
    expect(reply.status).toBe(200);
    expect(listLauncherConfigs(harness.store.db)).toEqual([]);
  });
});
