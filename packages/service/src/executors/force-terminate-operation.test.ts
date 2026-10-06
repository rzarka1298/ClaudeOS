import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CapabilityToken,
  CLASSIFICATION,
  type ClaimFacts,
  type ExecuteContext,
  newRunId,
  type Requester,
  RUN_STATES,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  createForceTerminateOperation,
  type ForceTerminatePayload,
} from "./force-terminate-operation.js";
import {
  createFakeInspector,
  createFakeLog,
  createFakeTerminator,
  makeRunFacts,
} from "./test-support/fakes.js";

const REQUESTER: Requester = { kind: "dashboard", label: "ZZ-requester-label" };

function validPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    runId: newRunId(),
    runName: "Refactor parser",
    projectName: "Parser",
    processName: "claude",
    pid: 4242,
    processStartedAt: "Mon Oct  6 01:00:00 2026",
    stateBefore: "running",
    ...overrides,
  };
}

function build() {
  const terminator = createFakeTerminator();
  const inspector = createFakeInspector();
  const log = createFakeLog();
  const op = createForceTerminateOperation({ terminator, inspector, log });
  return { op, terminator, inspector, log };
}

function parsed(overrides: Partial<Record<string, unknown>> = {}): ForceTerminatePayload {
  const { op } = build();
  return op.payload.parse(validPayload(overrides));
}

describe("session.force-terminate operation: payload, claim facts and render", () => {
  describe("Test 1: payload", () => {
    const { op } = build();

    it("accepts a complete payload, with or without a project name", () => {
      expect(op.payload.safeParse(validPayload()).success).toBe(true);
      const { projectName: _omit, ...withoutProject } = validPayload();
      expect(op.payload.safeParse(withoutProject).success).toBe(true);
    });

    it("rejects an extra key, including any path-like key", () => {
      expect(op.payload.safeParse(validPayload({ extra: 1 })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ path: "/Users/USERNAME/x" })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ cwd: "/Users/USERNAME/x" })).success).toBe(false);
    });

    it("rejects a missing or non-integer pid, and a zero or negative one", () => {
      const { pid: _omit, ...withoutPid } = validPayload();
      expect(op.payload.safeParse(withoutPid).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ pid: 4242.5 })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ pid: "4242" })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ pid: 0 })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ pid: -3 })).success).toBe(false);
    });

    it("rejects a run id that is not shaped like one", () => {
      expect(op.payload.safeParse(validPayload({ runId: "nope" })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ runId: "../etc/passwd" })).success).toBe(false);
    });

    it("bounds the display name (1 to 120) and the process name (at most 64)", () => {
      expect(op.payload.safeParse(validPayload({ runName: "" })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ runName: "a".repeat(120) })).success).toBe(true);
      expect(op.payload.safeParse(validPayload({ runName: "a".repeat(121) })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ processName: "a".repeat(64) })).success).toBe(
        true,
      );
      expect(op.payload.safeParse(validPayload({ processName: "a".repeat(65) })).success).toBe(
        false,
      );
      expect(op.payload.safeParse(validPayload({ projectName: "a".repeat(121) })).success).toBe(
        false,
      );
    });

    it("requires a process start and a known state before", () => {
      expect(op.payload.safeParse(validPayload({ processStartedAt: "" })).success).toBe(false);
      expect(op.payload.safeParse(validPayload({ stateBefore: "exploding" })).success).toBe(false);
      for (const state of RUN_STATES) {
        expect(op.payload.safeParse(validPayload({ stateBefore: state })).success).toBe(true);
      }
    });

    it("carries exactly the documented keys and no path", () => {
      const keys = Object.keys(op.payload.parse(validPayload())).sort();
      expect(keys).toEqual(
        [
          "pid",
          "processName",
          "processStartedAt",
          "projectName",
          "runId",
          "runName",
          "stateBefore",
        ].sort(),
      );
    });
  });

  describe("Test 2: claim facts", () => {
    it("reads the Run through the inspector and returns run id, pid, process start and state", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: 777,
        processStartedAt: "Mon Oct  6 02:00:00 2026",
        state: "waiting-for-approval",
      });
      const facts = await op.claimFacts?.(payload);
      // pid and start are the approved payload's, never the Run's current ones.
      expect(facts).toEqual({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: "waiting-for-approval",
      });
      expect(inspector.readCalls).toEqual([payload.runId]);
    });

    it("keeps the approved pid and start, with a null state, when the inspector finds no Run", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = null;
      const facts = await op.claimFacts?.(payload);
      expect(facts).toEqual({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: null,
      });
    });

    it("keeps the approved pid and start, with a null state, instead of throwing when the inspector throws", async () => {
      const { op, inspector, log } = build();
      const payload = parsed();
      inspector.readRunError = new Error("boom at /Users/USERNAME/secret-place");
      const facts = await op.claimFacts?.(payload);
      expect(facts).toEqual({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: null,
      });
      // The error text is never logged.
      expect(JSON.stringify(log.lines)).not.toContain("secret-place");
    });

    it("keeps the approved pid and start where the Run has no recorded ones", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: null,
        processStartedAt: null,
        state: "starting",
      });
      const facts = await op.claimFacts?.(payload);
      expect(facts).toEqual({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: "starting",
      });
    });
  });

  describe("Test 3: render", () => {
    const { op } = build();
    const payload = parsed();
    const draft = op.render(payload, { requester: REQUESTER });

    it("has the title, the destructive flag and the effect sentence", () => {
      expect(draft.title).toBe("Force-terminate Refactor parser");
      expect(draft.destructive).toBe(true);
      expect(draft.effect).toBe("force-terminate Refactor parser");
      expect(draft.runName).toBe("Refactor parser");
    });

    it("describes the stop-then-kill behaviour without a target name", () => {
      expect(draft.action).toMatch(/stop/i);
      expect(draft.action).toMatch(/force/i);
      expect(draft.action).not.toContain("Refactor parser");
    });

    it("lists Session, Process (monospace) and Process started", () => {
      expect(draft.target).toEqual([
        { label: "Session", value: "Refactor parser", mono: false },
        { label: "Process", value: "claude · PID 4242", mono: true },
        { label: "Process started", value: "Mon Oct  6 01:00:00 2026", mono: false },
      ]);
    });

    it("shows the state before and cancelled as one removed and one added line", () => {
      expect(draft.change).toEqual({
        type: "diff",
        lines: [
          { kind: "removed", text: "state: running" },
          { kind: "added", text: "state: cancelled" },
        ],
      });
      expect(draft.changeFromRequester).toBe(false);
    });

    it("has three risk lines, one of them about work in progress being lost", () => {
      expect(draft.risks).toHaveLength(3);
      expect(draft.risks.some((risk) => /work in progress/i.test(risk) && /lost/i.test(risk))).toBe(
        true,
      );
    });

    it("has the fixed check hint", () => {
      expect(draft.checkHint).toBe(
        "Check whether the session's process is still running before asking again.",
      );
    });

    it("carries no requester text and no path", () => {
      const text = JSON.stringify(draft);
      expect(text).not.toContain("ZZ-requester-label");
      expect(text).not.toContain("/Users/");
      expect(op.render(payload, { requester: { kind: "skill", label: "another" } })).toEqual(draft);
    });

    it("reflects the state before in the removed line", () => {
      const waiting = op.render(parsed({ stateBefore: "waiting-for-approval" }), {
        requester: REQUESTER,
      });
      expect(waiting.change).toMatchObject({
        type: "diff",
        lines: [{ kind: "removed", text: "state: waiting-for-approval" }, { kind: "added" }],
      });
    });
  });

  describe("Test 4: purity", () => {
    it("renders the same payload twice to deep-equal drafts and calls no port", () => {
      const { op, terminator, inspector, log } = build();
      const payload = parsed();
      const a = op.render(payload, { requester: REQUESTER });
      const b = op.render(payload, { requester: REQUESTER });
      expect(a).toEqual(b);
      expect(terminator.calls).toEqual([]);
      expect(inspector.readCalls).toEqual([]);
      expect(inspector.statusCalls).toEqual([]);
      expect(log.lines).toEqual([]);
    });
  });

  describe("Test 5: definition shape", () => {
    const { op } = build();

    it("names an enabled, non-modifiable, idempotent approval-required row", () => {
      expect(op.operation).toBe("session.force-terminate");
      const row = CLASSIFICATION["session.force-terminate"];
      expect(row.class).toBe("approval-required");
      expect(row.status).toBe("enabled");
      expect(row.modifiable).toBe(false);
      expect(row.retry).toBe("idempotent");
    });

    it("reads its lifetime and maximum approval age from the table: the row has them and the module repeats neither", () => {
      const row = CLASSIFICATION["session.force-terminate"];
      expect(row.ttlMs).toBeGreaterThan(0);
      expect(row.maxApprovalAgeMs).toBeGreaterThan(0);
      const source = readFileSync(
        join(import.meta.dirname, "force-terminate-operation.ts"),
        "utf8",
      );
      expect(source).not.toMatch(/ttlMs|maxApprovalAge|TTL|60_?000/);
      expect(Object.keys(op)).not.toContain("ttlMs");
      expect(Object.keys(op)).not.toContain("maxApprovalAgeMs");
    });

    it("has a claimFacts hook", () => {
      expect(typeof op.claimFacts).toBe("function");
    });
  });
});

/**
 * Tests only: the approval engine is the one issuer of a real token. A local
 * cast here is the sanctioned test pattern; backstop rule 10 forbids it in
 * non-test source.
 */
function tokenFor(
  subject: string,
  patch: { operation?: string; proposalId?: string; expiresAt?: string } = {},
): CapabilityToken<"session.force-terminate"> {
  return {
    proposalId: patch.proposalId ?? "proposal-under-test-00",
    operation: patch.operation ?? "session.force-terminate",
    subject,
    expiresAt: patch.expiresAt ?? "2099-01-01T00:00:00.000Z",
  } as unknown as CapabilityToken<"session.force-terminate">;
}

const PROPOSAL = "proposal-under-test-00";

function contextFor(claimFacts: ClaimFacts = {}, attempt = 1): ExecuteContext {
  return { idempotencyKey: PROPOSAL, claimFacts, attempt };
}

const EVIDENCE_SHAPE = /^[a-z][a-z0-9-]{0,39}$/;

describe("session.force-terminate operation: execute and reconcile", () => {
  describe("Test 1: token guard, no terminator call", () => {
    it("refuses a token for another operation", async () => {
      const { op, terminator, inspector } = build();
      const payload = parsed();
      const outcome = await op.execute(
        tokenFor(payload.runId, { operation: "diagnostic.test" }),
        payload,
        contextFor(),
      );
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(terminator.calls).toHaveLength(0);
      expect(inspector.readCalls).toHaveLength(0);
    });

    it("refuses a token whose subject differs from the payload's run id", async () => {
      const { op, terminator } = build();
      const payload = parsed();
      const outcome = await op.execute(tokenFor(newRunId()), payload, contextFor());
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(terminator.calls).toHaveLength(0);
    });

    it("refuses a token whose proposal id differs from the idempotency key", async () => {
      const { op, terminator } = build();
      const payload = parsed();
      const outcome = await op.execute(
        tokenFor(payload.runId, { proposalId: "some-other-proposal-0" }),
        payload,
        contextFor(),
      );
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(terminator.calls).toHaveLength(0);
    });

    it("logs only the proposal id and a fixed code for a refused token", async () => {
      const { op, log } = build();
      const payload = parsed();
      await op.execute(tokenFor(newRunId()), payload, contextFor());
      const errors = log.ofLevel("error");
      expect(errors).toHaveLength(1);
      expect(Object.keys(errors[0]?.fields ?? {}).sort()).toEqual(["code", "proposalId"]);
      expect(errors[0]?.fields.proposalId).toBe(PROPOSAL);
    });

    it("calls the terminator with the token and the run id from the payload when the token covers it", async () => {
      const { op, terminator } = build();
      const payload = parsed();
      const token = tokenFor(payload.runId);
      await op.execute(token, payload, contextFor());
      expect(terminator.calls).toHaveLength(1);
      expect(terminator.calls[0]?.token).toBe(token);
      expect(terminator.calls[0]?.runId).toBe(payload.runId);
    });
  });

  describe("Test 1b: approved identity (what you approve is what runs)", () => {
    it("never calls the terminator when the Run's current pid differs from the approved one", async () => {
      const { op, terminator, inspector } = build();
      const payload = parsed({ pid: 111 });
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: 222,
        processStartedAt: payload.processStartedAt,
      });
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "refused", reason: "identity-mismatch" });
      expect(terminator.calls).toHaveLength(0);
    });

    it("never calls the terminator when the Run's current process start differs from the approved one", async () => {
      const { op, terminator, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: "Tue Oct  7 09:00:00 2026",
      });
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "refused", reason: "identity-mismatch" });
      expect(terminator.calls).toHaveLength(0);
    });

    it("never calls the terminator when the Run has lost its recorded pid", async () => {
      const { op, terminator, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({ runId: payload.runId, pid: null, processStartedAt: null });
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "refused", reason: "identity-mismatch" });
      expect(terminator.calls).toHaveLength(0);
    });

    it("calls the terminator when the Run still has the approved pid and start", async () => {
      const { op, terminator, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
      });
      await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(terminator.calls).toHaveLength(1);
    });
  });

  describe("Test 2: ok", () => {
    it("is executed with no note when the Run is now cancelled", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({ runId: payload.runId, state: "cancelled" });
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "executed" });
      expect(inspector.readCalls).toEqual([payload.runId, payload.runId]);
    });

    it("is executed with the awaiting-exit note when the Run is still non-terminal", async () => {
      for (const state of ["running", "waiting-for-approval", "starting", "stale"] as const) {
        const { op, inspector } = build();
        const payload = parsed();
        inspector.run = makeRunFacts({ runId: payload.runId, state });
        const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
        expect(outcome).toEqual({ kind: "executed", note: "awaiting-exit" });
      }
    });

    it("is executed with no note when the Run ended another way", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({ runId: payload.runId, state: "completed" });
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "executed" });
    });

    it("still reports executed when the Run cannot be read afterwards, because the terminator already succeeded", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.readRunError = new Error("boom");
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome.kind).toBe("executed");
    });
  });

  describe("Test 3: refusals", () => {
    for (const reason of ["process-ended", "run-not-found", "identity-mismatch"] as const) {
      it(`returns a refusal, never a plain failure, for ${reason}`, async () => {
        const { op, terminator } = build();
        terminator.script = { kind: "result", result: { ok: false, reason } };
        const payload = parsed();
        const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
        expect(outcome).toEqual({ kind: "refused", reason });
      });
    }

    it("returns the same refusal on a retry, leaving the late-refusal rule to the engine", async () => {
      const { op, terminator } = build();
      terminator.script = { kind: "result", result: { ok: false, reason: "process-ended" } };
      const payload = parsed();
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor({}, 2));
      expect(outcome).toEqual({ kind: "refused", reason: "process-ended" });
    });
  });

  describe("Test 4: capability-refused", () => {
    it("is a failure with the capability code and one error log of proposal id and code only", async () => {
      const { op, terminator, log } = build();
      terminator.script = { kind: "result", result: { ok: false, reason: "capability-refused" } };
      const payload = parsed();
      const outcome = await op.execute(tokenFor(payload.runId), payload, contextFor());
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      const errors = log.ofLevel("error");
      expect(errors).toHaveLength(1);
      expect(Object.keys(errors[0]?.fields ?? {}).sort()).toEqual(["code", "proposalId"]);
      expect(errors[0]?.fields).toEqual({ proposalId: PROPOSAL, code: "capability-refused" });
    });
  });

  describe("Test 5: throw", () => {
    it("lets a terminator rejection propagate unchanged so the engine records unknown", async () => {
      const { op, terminator, log } = build();
      const failure = new Error("kill failed at /Users/USERNAME/hidden");
      terminator.script = { kind: "reject", error: failure };
      const payload = parsed();
      await expect(op.execute(tokenFor(payload.runId), payload, contextFor())).rejects.toBe(
        failure,
      );
      expect(JSON.stringify(log.lines)).not.toContain("hidden");
      expect(JSON.stringify(log.lines)).not.toContain("kill failed");
    });
  });

  describe("Test 6: reconcile table", () => {
    function claimed(payload: ForceTerminatePayload, patch: Record<string, unknown> = {}) {
      return {
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
        state: "running",
        ...patch,
      } as ClaimFacts;
    }

    it("proves the effect when the Run is cancelled with the same pid and process start as the claim", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        state: "cancelled",
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
      });
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict).toEqual({ kind: "effect-proven", evidence: "run-cancelled-same-process" });
    });

    it("proves the effect when the claimed pid is gone", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
      });
      inspector.status = "gone";
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict).toEqual({ kind: "effect-proven", evidence: "process-gone" });
      expect(inspector.statusCalls).toEqual([
        { pid: payload.pid, expectedStartedAt: payload.processStartedAt },
      ]);
    });

    it("proves the effect when the claimed pid is alive with a different start (a reused pid)", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({ runId: payload.runId, pid: payload.pid });
      inspector.status = "different";
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict).toEqual({ kind: "effect-proven", evidence: "process-gone" });
    });

    it("reports effect-absent when the same process is still alive", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        pid: payload.pid,
        processStartedAt: payload.processStartedAt,
      });
      inspector.status = "same";
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict).toEqual({ kind: "effect-absent" });
    });

    it("does not treat a cancelled Run with a different recorded identity as proof by itself", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        state: "cancelled",
        pid: payload.pid + 1,
        processStartedAt: payload.processStartedAt,
      });
      inspector.status = "same";
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict).toEqual({ kind: "effect-absent" });
    });

    it("reports unknown when the claim facts are missing", async () => {
      const cases: ClaimFacts[] = [
        {},
        { pid: null, processStartedAt: "x" },
        { pid: 4242, processStartedAt: null },
        { pid: "4242", processStartedAt: "x" },
        { pid: 0, processStartedAt: "x" },
        { pid: 4242, processStartedAt: "" },
      ];
      for (const facts of cases) {
        const { op, inspector } = build();
        const payload = parsed();
        inspector.run = makeRunFacts({ runId: payload.runId });
        const verdict = await op.reconcile(payload, contextFor(facts));
        expect(verdict.kind).toBe("unknown");
        expect(inspector.statusCalls).toHaveLength(0);
      }
    });

    it("reports unknown, not executed, when the claim facts name a different process than the approved one", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({
        runId: payload.runId,
        state: "cancelled",
        pid: payload.pid + 1,
        processStartedAt: payload.processStartedAt,
      });
      inspector.status = "gone";
      const verdict = await op.reconcile(
        payload,
        contextFor(claimed(payload, { pid: payload.pid + 1 })),
      );
      expect(verdict.kind).toBe("unknown");
      expect(inspector.statusCalls).toHaveLength(0);
    });

    it("reports unknown when the Run is missing", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = null;
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict.kind).toBe("unknown");
    });

    it("reports unknown when the inspector fails reading the Run", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.readRunError = new Error("boom /Users/USERNAME/x");
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict.kind).toBe("unknown");
      expect(JSON.stringify(verdict)).not.toContain("USERNAME");
    });

    it("reports unknown when the inspector fails reading the process", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = makeRunFacts({ runId: payload.runId });
      inspector.statusError = new Error("boom /Users/USERNAME/x");
      const verdict = await op.reconcile(payload, contextFor(claimed(payload)));
      expect(verdict.kind).toBe("unknown");
      expect(JSON.stringify(verdict)).not.toContain("USERNAME");
    });

    it("gives every verdict a short fixed code with no path or name", async () => {
      const verdicts = [];
      for (const status of ["gone", "different", "same"] as const) {
        const { op, inspector } = build();
        const payload = parsed({ runName: "Secret Name", processName: "secretproc" });
        inspector.run = makeRunFacts({ runId: payload.runId });
        inspector.status = status;
        verdicts.push(await op.reconcile(payload, contextFor(claimed(payload))));
      }
      {
        const { op, inspector } = build();
        const payload = parsed({ runName: "Secret Name", processName: "secretproc" });
        inspector.run = null;
        verdicts.push(await op.reconcile(payload, contextFor(claimed(payload))));
        verdicts.push(await op.reconcile(payload, contextFor({})));
      }
      for (const verdict of verdicts) {
        const text = JSON.stringify(verdict);
        expect(text).not.toContain("Secret Name");
        expect(text).not.toContain("secretproc");
        if (verdict.kind === "effect-proven") expect(verdict.evidence).toMatch(EVIDENCE_SHAPE);
        if (verdict.kind === "unknown") expect(verdict.reason).toMatch(EVIDENCE_SHAPE);
      }
    });
  });

  describe("Test 7: reconcile is read-only", () => {
    it("never calls the terminator, whatever the verdict", async () => {
      for (const status of ["gone", "different", "same"] as const) {
        const { op, terminator, inspector, log } = build();
        const payload = parsed();
        inspector.run = makeRunFacts({
          runId: payload.runId,
          pid: payload.pid,
          processStartedAt: payload.processStartedAt,
        });
        inspector.status = status;
        await op.reconcile(
          payload,
          contextFor({
            runId: payload.runId,
            pid: payload.pid,
            processStartedAt: payload.processStartedAt,
            state: "running",
          }),
        );
        await op.reconcile(payload, contextFor({}));
        expect(terminator.calls).toHaveLength(0);
        expect(log.ofLevel("error")).toHaveLength(0);
      }
    });
  });
});
