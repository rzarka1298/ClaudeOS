import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  type ApprovalDetailResponse,
  ApprovalUpsertedPayloadSchema,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  type DecideResponse,
  type RunId,
  SESSION_TERMINATE_REQUEST_PATH,
} from "@ccc/domain";
import { getSessionRun, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  collectEvents,
  handshake,
  isRunning,
  reapSacrificialChildren,
  runHook,
  sessionOf,
  sessionStartRecord,
  setUpServiceEnvironment,
  spawnSacrificialChild,
  tearDownServiceEnvironment,
  waitForExit,
} from "./approval-int-support.js";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Force-terminate against a real sacrificial process (plan 06-21, D-16, D-42,
 * APPR-01): the terminate-request route now creates a real approval, and
 * approving it ends a throwaway child this file spawned, identity-checked by
 * Phase 5's executor. Only processes this file spawns are ever signalled.
 */

let account: string;

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(() => {
  reapSacrificialChildren();
  tearDownServiceEnvironment(account);
});

const PLUGIN_HEADERS = { [DECIDED_VIA_HEADER]: DECIDED_VIA_PLUGIN };

interface Registered {
  readonly runId: RunId;
  readonly pid: number;
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function run(
  fn: (fixture: {
    dir: string;
    socketPath: string;
    dbPath: string;
    token: string;
    stream: ReturnType<typeof collectEvents>;
    register(): Promise<Registered & { child: Awaited<ReturnType<typeof spawnSacrificialChild>> }>;
    propose(runId: RunId): Promise<string>;
    detail(proposalId: string): Promise<ApprovalDetailResponse>;
    decide(
      proposalId: string,
      decision: "approve" | "deny",
      payloadHash: string,
    ): Promise<DecideResponse>;
  }) => Promise<void>,
): Promise<void> {
  await withTempSocketDir(async ({ dir, socketPath }) => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    const dbPath = join(dir, "operational.db");
    const service = await startServiceForTest({ socketPath, dbPath });
    const token = await handshake(socketPath);
    const stream = collectEvents(socketPath, token);
    try {
      await fn({
        dir,
        socketPath,
        dbPath,
        token,
        stream,
        async register() {
          const child = await spawnSacrificialChild();
          const sessionId = `ft-${randomUUID().slice(0, 8)}`;
          await runHook(dir, child.pid, sessionStartRecord(sessionId, join(dir, "code", "demo")));
          const started = await stream.waitFor(
            (event) =>
              sessionOf(event)?.claudeSessionId === sessionId &&
              sessionOf(event)?.state === "running",
            10_000,
          );
          const runId = sessionOf(started)?.runId as RunId;
          // The terminate request needs the recorded process start too.
          await waitFor(() => {
            const read = openStore(dbPath);
            try {
              const row = getSessionRun(read.db, runId);
              return row?.pid !== null && row?.pidStartedAt !== null ? true : null;
            } finally {
              read.close();
            }
          }, 10_000);
          return { runId, pid: child.pid, child };
        },
        async propose(runId) {
          const proposed = await authedRequest<{ outcome: string; proposalId: string }>(
            socketPath,
            token,
            { method: "POST", path: SESSION_TERMINATE_REQUEST_PATH, body: { runId } },
          );
          expect(proposed.status).toBe(200);
          expect(proposed.body.outcome).toBe("proposed");
          return proposed.body.proposalId;
        },
        async detail(proposalId) {
          const res = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_GET_PATH,
            body: { proposalId },
          });
          expect(res.status).toBe(200);
          return res.body;
        },
        async decide(proposalId, decision, payloadHash) {
          const res = await authedRequest<DecideResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_DECIDE_PATH,
            body: { proposalId, decision, payloadHash },
            headers: PLUGIN_HEADERS,
          });
          return res.body;
        },
      });
    } finally {
      stream.close();
      await service.stop();
    }
  });
}

function stateEvent(proposalId: string, state: string) {
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

describe("force-terminate against a real sacrificial process (Task 2, Tests 4 to 6)", () => {
  it("proposes, shows a destructive view, ends the child on approval and cancels the Run", async () => {
    await run(async (ctx) => {
      const { runId, pid, child } = await ctx.register();
      const proposalId = await ctx.propose(runId);

      const before = await ctx.detail(proposalId);
      expect(before.view?.destructive).toBe(true);
      expect(JSON.stringify(before.view?.target)).toContain(`PID ${pid}`);
      expect(isRunning(child)).toBe(true);

      const decided = await ctx.decide(proposalId, "approve", before.payloadHash);
      expect(decided.outcome).toBe("decided");

      await waitForExit(child, 20_000);
      await ctx.stream.waitFor(stateEvent(proposalId, "executed"), 20_000);
      await ctx.stream.waitFor(
        (event) => sessionOf(event)?.runId === runId && sessionOf(event)?.state === "cancelled",
        20_000,
      );
      expect(isRunning(child)).toBe(false);

      const again = await ctx.decide(proposalId, "approve", before.payloadHash);
      expect(again.outcome).toBe("already-decided");

      const after = await ctx.detail(proposalId);
      expect(after.view?.history.map((entry) => entry.event)).toEqual([
        "requested",
        "approved",
        "claimed",
        "executed",
      ]);
    });
  }, 60_000);

  it("returns the existing proposal for a second request while one is pending", async () => {
    await run(async (ctx) => {
      const { runId } = await ctx.register();
      const first = await ctx.propose(runId);
      const second = await ctx.propose(runId);
      expect(second).toBe(first);
    });
  }, 40_000);

  it("refuses when the recorded process identity no longer matches, and signals nothing", async () => {
    await run(async (ctx) => {
      const { runId, child } = await ctx.register();
      const proposalId = await ctx.propose(runId);
      const before = await ctx.detail(proposalId);

      // Simulate a Run that no longer points at the approved process: the
      // stored process start changes between the request and the approval.
      const seed = openStore(ctx.dbPath);
      try {
        seed.db
          .prepare("UPDATE runs SET pid_started_at = ? WHERE run_id = ?")
          .run("2000-01-01T00:00:00.000Z", runId);
      } finally {
        seed.close();
      }

      const decided = await ctx.decide(proposalId, "approve", before.payloadHash);
      expect(decided.outcome).toBe("decided");
      await ctx.stream.waitFor(stateEvent(proposalId, "failed"), 20_000);

      const after = await ctx.detail(proposalId);
      expect(after.summary.outcomeCode).toBe("identity-mismatch");
      expect(isRunning(child)).toBe(true);
    });
  }, 60_000);

  it("leaves the child alive and the Run unchanged when the request is denied", async () => {
    await run(async (ctx) => {
      const { runId, child } = await ctx.register();
      const proposalId = await ctx.propose(runId);
      const before = await ctx.detail(proposalId);

      const decided = await ctx.decide(proposalId, "deny", before.payloadHash);
      expect(decided.outcome).toBe("decided");
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));

      expect(isRunning(child)).toBe(true);
      const read = openStore(ctx.dbPath);
      try {
        expect(getSessionRun(read.db, runId)?.state).toBe("running");
      } finally {
        read.close();
      }
      const after = await ctx.detail(proposalId);
      expect(after.summary.state).toBe("denied");
    });
  }, 40_000);
});
