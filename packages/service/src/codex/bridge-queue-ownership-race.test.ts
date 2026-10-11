import { renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type AgentBridgeRequest,
  BRIDGE_NONCE_ENV_KEY,
  inspectRequestOwnership,
  writeBridgeRequest,
} from "./bridge-queue.js";

// The extension's claim (an atomic rename requests/ -> claimed/) lands right after the first
// claimed/ read missed, i.e. between the two reads of the old order.
const hook = vi.hoisted(() => ({ onClaimedMiss: null as null | (() => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      try {
        return await actual.readFile(...args);
      } catch (error) {
        if (String(args[0]).includes("/claimed/") && hook.onClaimedMiss !== null) {
          const run = hook.onClaimedMiss;
          hook.onClaimedMiss = null;
          run();
        }
        throw error;
      }
    },
  };
});

let fx: BridgeFixture;
beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
});
afterEach(() => {
  hook.onClaimedMiss = null;
  fx.cleanup();
});

const RUN = "20261010T120000000Z";
const NONCE = "n0nce-n0nce";

describe("inspectRequestOwnership across a claim rename", () => {
  it("a request renamed into claimed/ between the reads is still ours, and claimed", async () => {
    const request = {
      runId: RUN,
      kind: "agent",
      mode: "agent",
      agent: "claude",
      projectRoot: fx.projectDir,
      cwd: fx.projectDir,
      argv: [fx.claudePath],
      env: { [BRIDGE_NONCE_ENV_KEY]: NONCE },
      sessionId: null,
      liveLog: null,
      pid: null,
      createdAt: new Date().toISOString(),
      protocol: 2,
    } as AgentBridgeRequest;
    await writeBridgeRequest(fx.stateDir, request);
    hook.onClaimedMiss = () =>
      renameSync(join(fx.requestsDir, `${RUN}.json`), join(fx.claimedDir, `${RUN}.json`));
    await expect(inspectRequestOwnership(fx.stateDir, RUN, NONCE)).resolves.toBe("claimed");
  });
});
