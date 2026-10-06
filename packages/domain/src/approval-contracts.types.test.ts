// TYPE tests for the operation and port contracts (D-04, D-43, research
// Patterns 3 and 4). `tsc -b` fails if any `@ts-expect-error` below stops being
// an error, and if a deliberately conforming value stops compiling.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProposalId } from "./approval.js";
import type {
  ApprovalItemDraft,
  ClaimFacts,
  ExecuteOutcome,
  OperationDefinition,
  ReconcileVerdict,
} from "./approval-operations.js";
import type {
  ApprovalLog,
  ApprovalPublisher,
  ApprovalStorePort,
  Clock,
  DiagnosticEffectsPort,
  MirrorPort,
  RunInspector,
  StoredProposal,
} from "./approval-ports.js";
import type { CapabilityToken } from "./capability.js";

const draft: ApprovalItemDraft = {
  title: "Run a test that does nothing",
  destructive: false,
  effect: null,
  action: "Record one test effect.",
  runName: null,
  target: [{ label: "Subject", value: "test", mono: false }],
  change: { type: "none" },
  changeFromRequester: false,
  risks: [],
  checkHint: null,
};

// An operation definition for each enabled operation compiles.
export const diagnosticDefinition: OperationDefinition<"diagnostic.test", { note: string }> = {
  operation: "diagnostic.test",
  payload: z.strictObject({ note: z.string() }),
  async execute(
    _token: CapabilityToken<"diagnostic.test">,
    _payload,
    _ctx,
  ): Promise<ExecuteOutcome> {
    return { kind: "executed" };
  },
  async reconcile(): Promise<ReconcileVerdict> {
    return { kind: "effect-absent" };
  },
  render: () => draft,
};

export const terminateDefinition: OperationDefinition<
  "session.force-terminate",
  { runId: string }
> = {
  operation: "session.force-terminate",
  payload: z.strictObject({ runId: z.string() }),
  async claimFacts(): Promise<ClaimFacts> {
    return { pid: 1, pidStartedAt: "x" };
  },
  async execute(_token, _payload, ctx): Promise<ExecuteOutcome> {
    return ctx.attempt > 1 ? { kind: "refused", reason: "process-ended" } : { kind: "executed" };
  },
  async reconcile(): Promise<ReconcileVerdict> {
    return { kind: "effect-proven", evidence: "process-gone" };
  },
  render: () => ({ ...draft, destructive: true, effect: "force-terminate a session" }),
};

// @ts-expect-error -- a no-approval operation can have no operation definition
export type NoApprovalDefinition = OperationDefinition<"vault.write-note", { a: string }>;

// @ts-expect-error -- a reserved operation has no executor, so it cannot have a definition
export type ReservedDefinition = OperationDefinition<"vault.delete", { a: string }>;

// @ts-expect-error -- an unclassified operation can have no definition
export type UnknownDefinition = OperationDefinition<"no.such.operation", { a: string }>;

// The context an executor receives carries the idempotency key, the claim facts and the attempt.
export const contextShape = (ctx: Parameters<typeof diagnosticDefinition.execute>[2]): string =>
  `${ctx.idempotencyKey}:${ctx.attempt}:${Object.keys(ctx.claimFacts).length}`;

// A minimal implementer of the store port. Every method exists, and none writes an audit row alone.
export class MinimalStore implements ApprovalStorePort {
  submit(): ReturnType<ApprovalStorePort["submit"]> {
    return { kind: "capped", scope: "total" };
  }
  get(): StoredProposal | null {
    return null;
  }
  list(): StoredProposal[] {
    return [];
  }
  counts(): { pending: number; decided: number; expired: number } {
    return { pending: 0, decided: 0, expired: 0 };
  }
  decide(): ReturnType<ApprovalStorePort["decide"]> {
    return { kind: "not-found" };
  }
  claim(): ReturnType<ApprovalStorePort["claim"]> {
    return { kind: "lost" };
  }
  beginRetry(): ReturnType<ApprovalStorePort["beginRetry"]> {
    return { kind: "lost" };
  }
  finish(): StoredProposal | null {
    return null;
  }
  expireDue(): ProposalId[] {
    return [];
  }
  lapseStaleApproved(): ProposalId[] {
    return [];
  }
  listExecuting(): StoredProposal[] {
    return [];
  }
  listApprovedUnclaimed(): StoredProposal[] {
    return [];
  }
  withdraw(): StoredProposal | null {
    return null;
  }
  purgeDecidedPayloads(): number {
    return 0;
  }
  auditFor(): ReturnType<ApprovalStorePort["auditFor"]> {
    return [];
  }
}

// The port has no method that writes an audit row on its own.
type StoreMethods = keyof ApprovalStorePort;
const noStandaloneAudit: Extract<StoreMethods, `${string}udit${string}`> extends "auditFor"
  ? true
  : false = true;

export const clock: Clock = { now: () => "2026-10-04T15:00:00.000Z" };
export const mirror: MirrorPort = { async mirror() {} };
export const inspector: RunInspector = {
  readRun: () => null,
  async processStatus() {
    return "gone";
  },
};
export const effects: DiagnosticEffectsPort = { record: () => "recorded", exists: () => false };
export const log: ApprovalLog = { info() {}, warn() {}, error() {} };
export const publisher: ApprovalPublisher = { publish() {} };

describe("approval operation and port contracts (type test)", () => {
  it("compiles only for enabled operations and complete implementers (enforced by tsc -b)", () => {
    expect(noStandaloneAudit).toBe(true);
    expect(typeof contextShape).toBe("function");
    expect(new MinimalStore().counts()).toEqual({ pending: 0, decided: 0, expired: 0 });
    expect(clock.now()).toMatch(/Z$/);
    expect(effects.exists("0mfk1a2b3c4d5e6f7a8b9c0d1" as ProposalId)).toBe(false);
  });
});
