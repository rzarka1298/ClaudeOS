import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_TEST_PATH,
  type ApprovalDetailResponse,
  type ApprovalSummary,
  type ApprovalsSnapshot,
  ApprovalUpsertedPayloadSchema,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  type DecideResponse,
  SNAPSHOT_PATH,
  type SnapshotResponse,
  TASK_LIST_PATH,
} from "@ccc/domain";
import { openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  collectEvents,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * The phase-level tracer (plan 06-21, APPR-04, APPR-10, D-20): the real, built
 * service over its socket. A test approval is raised through the test route,
 * listed as pending, shown with the service-built view, approved with the
 * displayed hash, executed exactly once, and its history reads requested,
 * approved, claimed, executed. Throwaway runtime directory, short socket path
 * and a throwaway Keychain account; the service is killed in teardown.
 */

let account: string;

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(() => {
  tearDownServiceEnvironment(account);
});

interface TestResponse {
  readonly outcome: "proposed" | "already-pending";
  readonly proposalId: string;
}

const PLUGIN_HEADERS = { [DECIDED_VIA_HEADER]: DECIDED_VIA_PLUGIN };

function upserted(proposalId: string, state: string) {
  return (event: { type: string; payload: unknown }): boolean => {
    if (event.type !== "approval.upserted") return false;
    const parsed = ApprovalUpsertedPayloadSchema.safeParse(event.payload);
    return (
      parsed.success &&
      parsed.data.approval.proposalId === proposalId &&
      parsed.data.approval.state === state
    );
  };
}

describe("approval tracer over the real service (Task 1, Tests 1 to 3)", () => {
  it("lists, details, approves and executes a test approval exactly once", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      const dbPath = join(dir, "operational.db");
      const service = await startServiceForTest({ socketPath, dbPath });
      const token = await handshake(socketPath);
      const stream = collectEvents(socketPath, token);
      try {
        const raised = await authedRequest<TestResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_TEST_PATH,
          body: {},
        });
        expect(raised.status).toBe(200);
        expect(raised.body.outcome).toBe("proposed");
        const proposalId = raised.body.proposalId;

        const listed = await authedRequest<ApprovalsSnapshot>(socketPath, token, {
          method: "GET",
          path: APPROVAL_LIST_PATH,
        });
        expect(listed.status).toBe(200);
        expect(listed.body.ready).toBe(true);
        expect(listed.body.pending.map((entry: ApprovalSummary) => entry.proposalId)).toContain(
          proposalId,
        );

        const detail = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_GET_PATH,
          body: { proposalId },
        });
        expect(detail.status).toBe(200);
        expect(detail.body.payloadHash).toMatch(/^[0-9a-f]{64}$/);
        expect(detail.body.view?.title).toBeTruthy();
        expect(detail.body.view?.destructive).toBe(false);

        const decided = await authedRequest<DecideResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_DECIDE_PATH,
          body: { proposalId, decision: "approve", payloadHash: detail.body.payloadHash },
          headers: PLUGIN_HEADERS,
        });
        expect(decided.body.outcome).toBe("decided");

        await stream.waitFor(upserted(proposalId, "executed"), 10_000);
        const states = stream.events
          .map((event) => ApprovalUpsertedPayloadSchema.safeParse(event.payload))
          .filter((parsed) => parsed.success && parsed.data.approval.proposalId === proposalId)
          .map((parsed) => (parsed.success ? parsed.data.approval.state : ""));
        expect(states).toContain("executing");
        expect(states.at(-1)).toBe("executed");

        const again = await authedRequest<DecideResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_DECIDE_PATH,
          body: { proposalId, decision: "approve", payloadHash: detail.body.payloadHash },
          headers: PLUGIN_HEADERS,
        });
        expect(again.body.outcome).toBe("already-decided");

        const final = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_GET_PATH,
          body: { proposalId },
        });
        expect(final.body.view?.history.map((entry) => entry.event)).toEqual([
          "requested",
          "approved",
          "claimed",
          "executed",
        ]);

        // The effects ledger: exactly one row for the proposal.
        const read = openStore(dbPath);
        try {
          const rows = read.db
            .prepare("SELECT count(*) AS n FROM diagnostic_effects WHERE proposal_id = ?")
            .get(proposalId) as { n: number };
          expect(rows.n).toBe(1);
        } finally {
          read.close();
        }
      } finally {
        stream.close();
        await service.stop();
      }
    });
  }, 40_000);

  it("refuses a hash that differs by one character and records a non-plugin decision as the other channel", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      try {
        const raised = await authedRequest<TestResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_TEST_PATH,
          body: {},
        });
        const proposalId = raised.body.proposalId;
        const detail = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_GET_PATH,
          body: { proposalId },
        });
        const hash = detail.body.payloadHash;
        const wrong = `${hash.startsWith("a") ? "b" : "a"}${hash.slice(1)}`;
        const mismatch = await authedRequest<DecideResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_DECIDE_PATH,
          body: { proposalId, decision: "approve", payloadHash: wrong },
          headers: PLUGIN_HEADERS,
        });
        expect(mismatch.body.outcome).toBe("hash-mismatch");
        const still = await authedRequest<ApprovalsSnapshot>(socketPath, token, {
          method: "GET",
          path: APPROVAL_LIST_PATH,
        });
        expect(still.body.pending.map((entry: ApprovalSummary) => entry.proposalId)).toContain(
          proposalId,
        );

        // No client header: the decision is recorded under the other channel.
        const denied = await authedRequest<DecideResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_DECIDE_PATH,
          body: { proposalId, decision: "deny", payloadHash: hash },
        });
        expect(denied.body.outcome).toBe("decided");
        const after = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_GET_PATH,
          body: { proposalId },
        });
        expect(after.body.view?.record.decidedVia).toBe("other");
      } finally {
        await service.stop();
      }
    });
  }, 40_000);

  it("carries the approvals member in the snapshot, ready, and a fresh client sees the pending request", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      try {
        const raised = await authedRequest<TestResponse>(socketPath, token, {
          method: "POST",
          path: APPROVAL_TEST_PATH,
          body: {},
        });
        const second = await handshake(socketPath);
        const snapshot = await authedRequest<SnapshotResponse>(socketPath, second, {
          method: "GET",
          path: SNAPSHOT_PATH,
        });
        const approvals = snapshot.body.state.approvals;
        expect(approvals?.ready).toBe(true);
        expect(approvals?.pending.map((entry) => entry.proposalId)).toContain(
          raised.body.proposalId,
        );
      } finally {
        await service.stop();
      }
    });
  }, 40_000);

  it("wires the task services: the list route answers instead of 503", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
      mkdirSync(join(dir, "claude", "projects"), { recursive: true });
      const service = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
      });
      const token = await handshake(socketPath);
      try {
        const listed = await authedRequest<unknown>(socketPath, token, {
          method: "POST",
          path: TASK_LIST_PATH,
          body: { context: { scope: "all" }, filter: "all", zone: "UTC" },
        });
        expect(listed.status).toBe(200);
      } finally {
        await service.stop();
      }
    });
  }, 40_000);
});
