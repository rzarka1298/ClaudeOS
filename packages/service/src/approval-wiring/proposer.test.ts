import type { ApprovalLog, RunFacts, RunInspector } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import type { SubmitInput, SubmitOutcome } from "../approval/index.js";
import { createProposeForceTerminate } from "./proposer.js";

const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c001";
const PROPOSAL_ID = "0mfk1a2b3c4d5e6f7a8b9c900";
const STARTED = "2026-10-06T10:00:00.000Z";

const LIVE_RUN: RunFacts = {
  runId: RUN_ID,
  state: "running",
  displayName: "Refactor the parser",
  pid: 4242,
  processStartedAt: STARTED,
};

interface Setup {
  readonly submitted: SubmitInput[];
  readonly logs: Record<string, unknown>[];
  readonly propose: (
    runId: string,
  ) => ReturnType<ReturnType<typeof createProposeForceTerminate>["propose"]>;
}

function setup(options: {
  run?: RunFacts | null;
  outcome?: SubmitOutcome | (() => never);
  projectId?: string | null;
  projectName?: string | null;
  processName?: string | null;
}): Setup {
  const submitted: SubmitInput[] = [];
  const logs: Record<string, unknown>[] = [];
  const log: ApprovalLog = {
    info: (fields) => void logs.push(fields),
    warn: (fields) => void logs.push(fields),
    error: (fields) => void logs.push(fields),
  };
  const inspector: RunInspector = {
    readRun: () => (options.run === undefined ? LIVE_RUN : options.run),
    processStatus: async () => "same",
  };
  const proposer = createProposeForceTerminate({
    engine: {
      submit(input) {
        submitted.push(input);
        const outcome = options.outcome;
        if (typeof outcome === "function") return outcome();
        return (
          outcome ?? {
            kind: "proposed",
            proposalId: PROPOSAL_ID as never,
            deduped: false,
            supersedes: null,
          }
        );
      },
    },
    inspector,
    runContext: () => ({
      projectId: options.projectId === undefined ? "proj-1" : options.projectId,
      projectName: options.projectName === undefined ? "Parser project" : options.projectName,
    }),
    processName: async () => (options.processName === undefined ? "claude" : options.processName),
    log,
  });
  return { submitted, logs, propose: (runId) => proposer.propose({ runId }) };
}

describe("engine-backed ProposeForceTerminate (Task 2, Test 2)", () => {
  it("builds the payload from the Run's facts and submits it for the dashboard requester", async () => {
    const s = setup({});
    const result = await s.propose(RUN_ID);
    expect(result).toEqual({ ok: true, proposalId: PROPOSAL_ID });
    expect(s.submitted).toHaveLength(1);
    const input = s.submitted[0] as SubmitInput;
    expect(input.operation).toBe("session.force-terminate");
    expect(input.subject).toBe(RUN_ID);
    expect(input.runId).toBe(RUN_ID);
    expect(input.projectId).toBe("proj-1");
    expect(input.requester.kind).toBe("dashboard");
    expect(input.payload).toEqual({
      runId: RUN_ID,
      runName: "Refactor the parser",
      projectName: "Parser project",
      processName: "claude",
      pid: 4242,
      processStartedAt: STARTED,
      stateBefore: "running",
    });
  });

  it("omits the project name for a Run without a registered project and names an unreadable process generically", async () => {
    const s = setup({ projectId: null, projectName: null, processName: null });
    await s.propose(RUN_ID);
    const payload = (s.submitted[0] as SubmitInput).payload as Record<string, unknown>;
    expect("projectName" in payload).toBe(false);
    expect(payload.processName).toBe("process");
    expect((s.submitted[0] as SubmitInput).projectId).toBeNull();
  });

  it("returns the existing proposal id for a duplicate pending request", async () => {
    const s = setup({
      outcome: {
        kind: "proposed",
        proposalId: PROPOSAL_ID as never,
        deduped: true,
        supersedes: null,
      },
    });
    expect(await s.propose(RUN_ID)).toEqual({ ok: true, proposalId: PROPOSAL_ID });
  });

  it("answers the contract's failure and submits nothing for an unknown Run", async () => {
    const s = setup({ run: null });
    expect(await s.propose(RUN_ID)).toEqual({ ok: false, reason: "approval-unavailable" });
    expect(s.submitted).toEqual([]);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "answers the contract's failure for a %s Run",
    async (state) => {
      const s = setup({ run: { ...LIVE_RUN, state } });
      expect(await s.propose(RUN_ID)).toEqual({ ok: false, reason: "approval-unavailable" });
      expect(s.submitted).toEqual([]);
    },
  );

  it("answers the contract's failure for a Run without process facts", async () => {
    for (const run of [
      { ...LIVE_RUN, pid: null },
      { ...LIVE_RUN, processStartedAt: null },
    ]) {
      const s = setup({ run });
      expect(await s.propose(RUN_ID)).toEqual({ ok: false, reason: "approval-unavailable" });
      expect(s.submitted).toEqual([]);
    }
  });

  it.each(["inbox-full", "invalid-payload", "operation-reserved", "operation-unknown"] as const)(
    "maps an engine rejection (%s) to the contract's failure and logs only a fixed code",
    async (reason) => {
      const s = setup({ outcome: { kind: "rejected", reason } });
      expect(await s.propose(RUN_ID)).toEqual({ ok: false, reason: "approval-unavailable" });
      expect(s.logs.some((fields) => fields.reason === reason || fields.code === reason)).toBe(
        true,
      );
      for (const fields of s.logs) {
        expect(JSON.stringify(fields)).not.toContain("Refactor the parser");
      }
    },
  );

  it("maps a throwing engine to the contract's failure without leaking the error text", async () => {
    const s = setup({
      outcome: () => {
        throw new Error("boom /Users/USERNAME/secret");
      },
    });
    expect(await s.propose(RUN_ID)).toEqual({ ok: false, reason: "approval-unavailable" });
    expect(JSON.stringify(s.logs)).not.toContain("secret");
  });

  it("caps a hostile Run name at the payload limit", async () => {
    const s = setup({ run: { ...LIVE_RUN, displayName: "n".repeat(500) } });
    await s.propose(RUN_ID);
    const payload = (s.submitted[0] as SubmitInput).payload as { runName: string };
    expect(payload.runName).toHaveLength(120);
  });
});
