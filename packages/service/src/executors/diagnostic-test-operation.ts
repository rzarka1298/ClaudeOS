import {
  type ApprovalItemDraft,
  CLASSIFICATION,
  type DiagnosticEffectsPort,
  type ExecuteContext,
  type ExecuteOutcome,
  type OperationDefinition,
  type ProposalId,
  ProposalIdSchema,
  type ReconcileVerdict,
} from "@ccc/domain";
import { z } from "zod";

/**
 * The zero-effect `diagnostic.test` operation (D-20, research Pattern 4). It
 * does nothing observable except record one effect row per proposal id through
 * a port, so the engine's exactly-once, expiry and crash-recovery behaviour can
 * be proven without destroying anything. It carries no requester text: every
 * string below is a constant owned by this module.
 *
 * Element: `executors`. Imports `@ccc/domain` and zod only.
 */

/** The payload is an empty object: there is nothing for a requester to supply. */
const DiagnosticTestPayloadSchema = z.strictObject({});
export type DiagnosticTestPayload = Record<string, never>;

export interface DiagnosticTestDeps {
  readonly effects: DiagnosticEffectsPort;
}

const OPERATION = "diagnostic.test" as const;

/** The one subject a diagnostic request has: it targets nothing. */
const DIAGNOSTIC_SUBJECT = "diagnostic";

/** Evidence code recorded when reconcile finds the effect row. */
const EVIDENCE_EFFECT_RECORDED = "diagnostic-effect-recorded";
const UNKNOWN_INVALID_KEY = "invalid-idempotency-key";

const DRAFT: ApprovalItemDraft = {
  title: "Test approval",
  destructive: false,
  effect: null,
  action: `The command center will ${CLASSIFICATION[OPERATION].summary}.`,
  runName: null,
  target: [],
  change: { type: "none" },
  changeFromRequester: false,
  risks: ["This test changes nothing."],
  checkHint: null,
};

/** The proposal id the effect is keyed by, or null when the key is not shaped like one. */
function effectKey(idempotencyKey: string): ProposalId | null {
  const parsed = ProposalIdSchema.safeParse(idempotencyKey);
  return parsed.success ? parsed.data : null;
}

export function createDiagnosticTestOperation(
  deps: DiagnosticTestDeps,
): OperationDefinition<typeof OPERATION, DiagnosticTestPayload> {
  const { effects } = deps;
  return {
    operation: OPERATION,
    payload: DiagnosticTestPayloadSchema,

    subjectOf: () => DIAGNOSTIC_SUBJECT,

    async execute(token, _payload, context: ExecuteContext): Promise<ExecuteOutcome> {
      // Defense in depth: the engine minted this token for this proposal, so a
      // token for another operation or another proposal is an engine bug.
      if (token.operation !== OPERATION || token.proposalId !== context.idempotencyKey) {
        return { kind: "failed", reason: "capability-refused" };
      }
      const key = effectKey(context.idempotencyKey);
      if (key === null) return { kind: "failed", reason: "capability-refused" };
      // Insert-or-ignore: a second execution for the same proposal leaves one row.
      effects.record(key);
      return { kind: "executed" };
    },

    async reconcile(_payload, context: ExecuteContext): Promise<ReconcileVerdict> {
      const key = effectKey(context.idempotencyKey);
      if (key === null) return { kind: "unknown", reason: UNKNOWN_INVALID_KEY };
      return effects.exists(key)
        ? { kind: "effect-proven", evidence: EVIDENCE_EFFECT_RECORDED }
        : { kind: "effect-absent" };
    },

    render(): ApprovalItemDraft {
      return DRAFT;
    },
  };
}
