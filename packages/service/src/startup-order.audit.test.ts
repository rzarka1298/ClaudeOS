import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Audit (05-16 merge reconcile, area 6, D-22): the merged `main.ts` must start
 * in one fixed order. A second instance refuses before touching anything
 * (claim), Phase 4's stale-script sweep and the store/migrations run next,
 * SVC-11 recovery precedes every consumer of run rows, the approved roots are
 * recomputed from the store, only then do the Claude and usage services start,
 * and the listener and socket come last.
 */
describe("main.ts startup order (D-22)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  const STEPS = [
    "await claimSocketPath(socketPath)",
    "sweepStaleScripts(scriptDir",
    "openStore(dbPath)",
    "recoverInterruptedRuns(store.db",
    "recomputeApprovedRoots(store)",
    "await startClaudeServices(",
    "startUsageServices({",
    "startApprovalServices({",
    "await approvals.recover()",
    "approvals.start()",
    "claudeServices.proposerSlot.bind(",
    "createTaskServices({",
    "taskHost.startupWalk()",
    "createRequestListener({",
    "await startSocketServer({",
  ] as const;

  it("calls each startup step exactly once in the documented order", () => {
    const positions = STEPS.map((step) => {
      const first = src.indexOf(step);
      expect(first, `${step} must appear in main.ts`).toBeGreaterThan(-1);
      expect(src.indexOf(step, first + 1), `${step} must appear once`).toBe(-1);
      return first;
    });
    for (let i = 1; i < positions.length; i += 1) {
      const earlier = positions[i - 1] as number;
      const later = positions[i] as number;
      expect(later, `${STEPS[i - 1]} must precede ${STEPS[i]}`).toBeGreaterThan(earlier);
    }
  });
});

/**
 * Audit (plan 06-21 Task 3, Tests 2 and 8, D-09): the shutdown chain stops the
 * expiry sweeper first and waits for in-flight executions, then the usage and
 * Claude services, then closes the store; a second signal does nothing; and
 * the object handed to the route context exposes no terminator or executor.
 */
describe("main.ts shutdown order (D-09)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
  const shutdownAt = src.indexOf("const shutdown = ");
  const body = src.slice(shutdownAt);

  it("stops the approvals, then the usage services, then the Claude services, then closes the store", () => {
    expect(shutdownAt).toBeGreaterThan(-1);
    const order = [
      "approvals.stop()",
      "usageServices",
      "claudeServices.stop()",
      "store.close()",
    ].map((needle) => {
      const at = body.indexOf(needle);
      expect(at, `${needle} must appear in the shutdown chain`).toBeGreaterThan(-1);
      return at;
    });
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i] as number).toBeGreaterThan(order[i - 1] as number);
    }
  });

  it("disposes the task services and ignores a second signal", () => {
    expect(body).toContain("taskHost.dispose()");
    expect(body).toMatch(/if \(shuttingDown\) return;/);
  });

  it("hands the route context no terminator, executor or process facts", () => {
    const start = src.indexOf("createRequestListener({");
    const end = src.indexOf("await startSocketServer({");
    const literal = src.slice(start, end);
    expect(literal).not.toMatch(/terminator|executor|processFacts|runInspector|proposerSlot/);
    expect(literal).toContain("approvals: approvals.services");
  });
});
