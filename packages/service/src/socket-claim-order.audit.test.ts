import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A second service instance must refuse to start BEFORE it changes anything
// a live instance depends on: the launch-script sweep, the store (migrations,
// run recovery, spool drain) and the socket file itself.
describe("main.ts claims the socket path before any startup side effect", () => {
  it("awaits claimSocketPath right after ensureRuntimeDir and before the sweep, the store and the listener", () => {
    const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    const ensureRuntime = src.indexOf("ensureRuntimeDir(runtimeDir");
    const claim = src.indexOf("await claimSocketPath(socketPath)");
    expect(ensureRuntime).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(ensureRuntime);
    expect(claim).toBeLessThan(src.indexOf("ensureScriptDir(runtimeDir"));
    expect(claim).toBeLessThan(src.indexOf("openStore(dbPath)"));
    expect(claim).toBeLessThan(src.indexOf("drainSpool("));
    expect(claim).toBeLessThan(src.indexOf("startSocketServer("));
  });

  it("logs socket refusals through the path-free logSocketClaimRefusal, never the raw error", () => {
    const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    expect(src).toContain("logSocketClaimRefusal(logger, err)");
    expect(src).not.toContain("err.socketPath");
  });
});
