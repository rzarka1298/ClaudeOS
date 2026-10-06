import type { ExecuteContext, ExecuteOutcome, ReconcileVerdict } from "@ccc/domain";
import type { RegisteredDefinition } from "./engine.js";

/**
 * Outcome handling (D-17, D-42, A-7, Codex finding 1): the one place an
 * attempt's result, or a reconcile verdict, becomes a recorded outcome. The
 * first run, the single retry after a restart and the recovery pass all use
 * these functions, so the rule "a retry is never recorded as plain failed" and
 * the failed-versus-unknown table live in exactly one file.
 *
 * Element: `approval`. Imports `@ccc/domain` and files in this folder only.
 */

/** What the engine writes to the store when an attempt ends. Every code is a fixed token, never free text. */
export interface FinishDecision {
  readonly state: "executed" | "failed" | "unknown";
  readonly code: string;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly reconciled: boolean;
}

/** `threw: true` is an `execute` that rejected. Its message is never read. */
export type ExecuteResult =
  | { readonly threw: true }
  | { readonly threw: false; readonly outcome: ExecuteOutcome };

export const FIXED_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
/** Used when an operation hands back evidence that is not a fixed token: the fact is kept, the text is not. */
const GENERIC_EVIDENCE = "reconcile-evidence";

export function fixedToken(value: string, fallback: string): string {
  return FIXED_TOKEN.test(value) ? value : fallback;
}

export function unknownDecision(code: string, evidence: string | null): FinishDecision {
  return { state: "unknown", code, note: null, evidence, reconciled: false };
}

/** What asking `reconcile` came to: the verdict (null when it threw) and what to record if nothing further is done. */
export interface ReconcileOutcome {
  readonly verdict: ReconcileVerdict | null;
  readonly decision: FinishDecision;
}

/**
 * Asks the operation's read-only `reconcile` and maps the answer: `effect-proven`
 * records `executed` (flagged reconciled, with the evidence code); anything else,
 * including a throw, records `unknown`. The caller decides whether an
 * `effect-absent` verdict allows a retry (recovery) or ends in `unknown` (here).
 */
export async function consultReconcile(
  definition: RegisteredDefinition,
  payload: unknown,
  context: ExecuteContext,
): Promise<ReconcileOutcome> {
  let verdict: ReconcileVerdict;
  try {
    verdict = await definition.reconcile(payload, context);
  } catch {
    return { verdict: null, decision: unknownDecision("reconcile-threw", null) };
  }
  if (verdict.kind === "effect-proven") {
    return {
      verdict,
      decision: {
        state: "executed",
        code: "executed",
        note: null,
        evidence: fixedToken(verdict.evidence, GENERIC_EVIDENCE),
        reconciled: true,
      },
    };
  }
  if (verdict.kind === "effect-absent") {
    return { verdict, decision: unknownDecision("outcome-unknown", "effect-absent") };
  }
  return {
    verdict,
    decision: unknownDecision("outcome-unknown", fixedToken(verdict.reason, GENERIC_EVIDENCE)),
  };
}

/**
 * - A rejected `execute` is `unknown` (`executor-threw`), never `failed`: an
 *   effect may already have started.
 * - On the first attempt a refusal or failure is definitive: nothing was done,
 *   so `failed` with the reason code is truthful.
 * - On a retry attempt (2 or more) any non-executed result is routed through
 *   the operation's read-only `reconcile`: `effect-proven` records `executed`
 *   (flagged reconciled, with the evidence code); anything else records
 *   `unknown`. A plain `failed` is never written for a retry.
 */
export async function resolveOutcome(
  definition: RegisteredDefinition,
  payload: unknown,
  context: ExecuteContext,
  result: ExecuteResult,
): Promise<FinishDecision> {
  if (result.threw) return unknownDecision("executor-threw", null);
  const outcome = result.outcome;
  if (outcome.kind === "executed") {
    const note = outcome.note !== undefined && FIXED_TOKEN.test(outcome.note) ? outcome.note : null;
    return { state: "executed", code: "executed", note, evidence: null, reconciled: false };
  }
  if (context.attempt < 2) {
    return {
      state: "failed",
      code: fixedToken(outcome.reason, "refused"),
      note: null,
      evidence: null,
      reconciled: false,
    };
  }
  return (await consultReconcile(definition, payload, context)).decision;
}
