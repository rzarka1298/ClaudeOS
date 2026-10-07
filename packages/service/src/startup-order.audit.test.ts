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
