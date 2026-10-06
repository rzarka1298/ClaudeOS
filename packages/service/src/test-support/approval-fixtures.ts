import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalSummary,
  ApprovalsSnapshot,
  ApprovalTestRequest,
  ApprovalTestResponse,
  DecideResponse,
  ProposalState,
} from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import { mintToken } from "../auth/token.js";
import { createEventBus } from "../events/event-bus.js";
import { createRequestListener } from "../routes.js";
import type { RouteContext } from "../route-kit.js";

/**
 * Shared fixtures for the approval route, snapshot and client tests (plan
 * 06-13). Everything is synthetic. Test code only: no production file imports
 * this module.
 */

/** A valid proposal id (25 lowercase alphanumerics), varied by `n`. */
export function proposalId(n: number): string {
  return `0mfk1a2b3c4d5e6f7a8b9c${String(n).padStart(3, "0")}`;
}

/** A syntactically valid payload hash. */
export const HASH = "ab12".repeat(16);

export function summary(
  n: number,
  state: ProposalState = "pending",
  overrides: Record<string, unknown> = {},
): ApprovalSummary {
  return {
    proposalId: proposalId(n),
    state,
    revision: 1,
    title: `Test approval ${n}`,
    operationLabel: "Test approval",
    requesterKind: "dashboard",
    requesterLabel: "Dashboard",
    projectName: null,
    runId: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    expiresAt: "2026-10-07T10:00:00.000Z",
    decidedAt: null,
    outcomeCode: null,
    ...overrides,
  } as unknown as ApprovalSummary;
}

export function snapshotOf(
  pending: readonly ApprovalSummary[] = [],
  ready = true,
): ApprovalsSnapshot {
  return {
    ready,
    pending: [...pending],
    decided: [],
    expired: [],
    counts: { pending: pending.length, decided: 0, expired: 0 },
    truncated: false,
  };
}

/** One recorded call to a fake services function. */
export interface DecideCall {
  readonly proposalId: string;
  readonly decision: ApprovalDecision;
  readonly payloadHash: string;
  readonly via: "plugin" | "other";
}

/** The shape the route layer talks to; mirrored from `approval-wiring/types.ts` structurally. */
export interface FakeServicesScript {
  snapshot: ApprovalsSnapshot;
  snapshotThrows: boolean;
  ready: boolean;
  decideResult: DecideResponse | Error;
  testResults: (ApprovalTestResponse | { kind: "rejected"; reason: string } | Error)[];
  getResult: unknown;
}

export interface FakeServices {
  readonly script: FakeServicesScript;
  readonly decideCalls: DecideCall[];
  readonly testCalls: ApprovalTestRequest[];
  readonly getCalls: string[];
  readonly snapshotBudgets: (number | undefined)[];
  // The members below satisfy `ApprovalServices`; typed loosely here so this file
  // never depends on the module under test.
  readonly ready: boolean;
  snapshot(budgetBytes?: number): ApprovalsSnapshot;
  get(id: string): unknown;
  decide(input: DecideCall): Promise<DecideResponse>;
  test(request: ApprovalTestRequest): unknown;
}

export function createFakeServices(): FakeServices {
  const script: FakeServicesScript = {
    snapshot: snapshotOf([summary(1)]),
    snapshotThrows: false,
    ready: true,
    decideResult: { outcome: "decided", approval: summary(1, "approved") },
    testResults: [],
    getResult: { kind: "not-found" },
  };
  const decideCalls: DecideCall[] = [];
  const testCalls: ApprovalTestRequest[] = [];
  const getCalls: string[] = [];
  const snapshotBudgets: (number | undefined)[] = [];
  let testCount = 0;
  return {
    script,
    decideCalls,
    testCalls,
    getCalls,
    snapshotBudgets,
    get ready() {
      return script.ready;
    },
    snapshot(budgetBytes) {
      snapshotBudgets.push(budgetBytes);
      if (script.snapshotThrows) throw new Error("snapshot failed /Users/USERNAME/secret");
      return script.snapshot;
    },
    get(id) {
      getCalls.push(id);
      if (script.getResult instanceof Error) throw script.getResult;
      return script.getResult;
    },
    async decide(input) {
      decideCalls.push(input);
      if (script.decideResult instanceof Error) throw script.decideResult;
      return script.decideResult;
    },
    test(request) {
      testCalls.push(request);
      const next = script.testResults[testCount];
      testCount += 1;
      if (next instanceof Error) throw next;
      if (next !== undefined) return next;
      return { outcome: "proposed", proposalId: proposalId(100 + testCount) };
    },
  };
}

/** The short base every socket test uses: macOS's per-user temp dir exceeds the sun_path cap. */
const TEST_BASE = join(homedir(), ".ccc-test");

export interface SocketReply<T> {
  status: number;
  body: T;
  raw: string;
}

export function requestOverSocket<T>(
  socketPath: string,
  opts: {
    method: string;
    path: string;
    body?: unknown;
    rawBody?: string;
    token?: string;
    headers?: Record<string, string | string[]>;
  },
): Promise<SocketReply<T>> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
    const req = http.request(
      {
        socketPath,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: (raw.length > 0 ? JSON.parse(raw) : undefined) as T,
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export interface RouteHarness {
  readonly socketPath: string;
  readonly token: string;
  readonly dir: string;
  readonly eventBus: ReturnType<typeof createEventBus>;
  close(): Promise<void>;
}

/**
 * Starts the real request listener on a throwaway unix socket with the given
 * context members (`approvals`, and any other optional member a test needs).
 */
export async function startRouteHarness(
  store: OperationalStore,
  extra: Partial<RouteContext>,
): Promise<RouteHarness> {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "appr-"));
  const socketPath = join(dir, "t.sock");
  const secret = randomBytes(32);
  const token = mintToken(secret, { nowMs: Date.now() });
  const eventBus = createEventBus();
  const server: Server = http.createServer(
    createRequestListener({ store, getSecret: () => secret, eventBus, ...extra }),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    token,
    dir,
    eventBus,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
