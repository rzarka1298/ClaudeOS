import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import { type AgentBridgeRequest, writeBridgeRequest } from "./bridge-queue.js";

// Temp-file deletion never settles (a stalled volume): publication must not wait for it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: (path: string) =>
      String(path).endsWith(".tmp") ? new Promise<void>(() => {}) : actual.unlink(path),
  };
});

let fx: BridgeFixture;
beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
});
afterEach(() => fx.cleanup());

function request(runId: string): AgentBridgeRequest {
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
  } as AgentBridgeRequest;
}

describe("writeBridgeRequest with a stalled temp-file cleanup (Codex final review)", () => {
  it("returns the published path without waiting for the temp file to be deleted", async () => {
    const stalled = Symbol("stalled");
    const outcome = await Promise.race([
      writeBridgeRequest(fx.stateDir, request("20261010T120000000Z")),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(stalled), 500)),
    ]);
    expect(outcome).not.toBe(stalled);
    expect(existsSync(join(fx.stateDir, "requests", "20261010T120000000Z.json"))).toBe(true);
  });
});
