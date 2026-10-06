import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSIFICATION, newRunId, type Requester, RUN_STATES } from "@ccc/domain";
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
      expect(facts).toEqual({
        runId: payload.runId,
        pid: 777,
        processStartedAt: "Mon Oct  6 02:00:00 2026",
        state: "waiting-for-approval",
      });
      expect(inspector.readCalls).toEqual([payload.runId]);
    });

    it("returns null pid and start, instead of throwing, when the inspector finds no Run", async () => {
      const { op, inspector } = build();
      const payload = parsed();
      inspector.run = null;
      const facts = await op.claimFacts?.(payload);
      expect(facts).toEqual({
        runId: payload.runId,
        pid: null,
        processStartedAt: null,
        state: null,
      });
    });

    it("returns null pid and start, instead of throwing, when the inspector throws", async () => {
      const { op, inspector, log } = build();
      const payload = parsed();
      inspector.readRunError = new Error("boom at /Users/USERNAME/secret-place");
      const facts = await op.claimFacts?.(payload);
      expect(facts).toEqual({
        runId: payload.runId,
        pid: null,
        processStartedAt: null,
        state: null,
      });
      // The error text is never logged.
      expect(JSON.stringify(log.lines)).not.toContain("secret-place");
    });

    it("keeps null where the Run has no recorded pid or start", async () => {
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
        pid: null,
        processStartedAt: null,
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
