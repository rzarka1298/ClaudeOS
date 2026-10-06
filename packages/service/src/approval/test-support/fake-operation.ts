// A scriptable operation for the approval tests (06-08). Folder-private: never
// exported from the approval public entry. It counts how often `execute` was
// called apart from how many distinct effects it produced, so a test can assert
// both what the engine did and what it did NOT do. There is deliberately no
// token construction in this file: a test that needs a forged token builds one
// with a local cast inside its own `*.test.ts` file (backstop rule 10).
import {
  type ApprovalItemDraft,
  type CapabilityToken,
  type ClaimFacts,
  type EnabledOperation,
  type ExecuteContext,
  type ExecuteOutcome,
  type OperationDefinition,
  type ReconcileVerdict,
  type RenderContext,
} from "@ccc/domain";
import { z } from "zod";

export interface FakePayload {
  note?: string | undefined;
}

const FakePayloadSchema = z.strictObject({ note: z.string().max(200).optional() });

export interface ExecuteCall {
  readonly token: CapabilityToken<EnabledOperation>;
  readonly payload: FakePayload;
  readonly context: ExecuteContext;
}

export interface ReconcileCall {
  readonly payload: FakePayload;
  readonly context: ExecuteContext;
}

/** A deferred execution gate: while held, `execute` does not return, so a test can look at the world mid-flight. */
export interface Gate {
  release(): void;
}

export const DEFAULT_DRAFT: ApprovalItemDraft = {
  title: "Run the fake action",
  destructive: false,
  effect: null,
  action: "The command center will run a fake action.",
  runName: null,
  target: [{ label: "Thing", value: "the fake thing", mono: false }],
  change: { type: "none" },
  changeFromRequester: false,
  risks: ["This is a fake."],
  checkHint: null,
};

export interface FakeOperation {
  readonly definition: OperationDefinition<EnabledOperation, FakePayload>;
  readonly operation: EnabledOperation;
  readonly executeCalls: ExecuteCall[];
  readonly reconcileCalls: ReconcileCall[];
  readonly claimFactsCalls: FakePayload[];
  readonly renderCalls: { readonly payload: FakePayload; readonly context: RenderContext }[];
  /** The distinct effects (idempotency keys) that were produced. Repeats do not add. */
  readonly effects: Set<string>;
  /** Outcomes `execute` returns, one per call, in order. An Error is thrown (a rejection). Empty means `executed`. */
  readonly outcomes: (ExecuteOutcome | Error)[];
  /** Verdicts `reconcile` returns, one per call, in order. An Error is thrown. Empty means `unknown`. */
  readonly verdicts: (ReconcileVerdict | Error)[];
  /** What `claimFacts` returns, or an Error to throw. */
  claimFactsResult: ClaimFacts | Error;
  /** Called inside `claimFacts`, so a test can move the clock between decide and claim. */
  onClaimFacts: (() => void) | null;
  /** What `render` returns. */
  draft: ApprovalItemDraft;
  /** When true, `render` throws. */
  renderThrows: boolean;
  /** Holds every following `execute` until the gate is released. */
  hold(): Gate;
}

export function createFakeOperation(
  operation: EnabledOperation = "diagnostic.test",
): FakeOperation {
  const executeCalls: ExecuteCall[] = [];
  const reconcileCalls: ReconcileCall[] = [];
  const claimFactsCalls: FakePayload[] = [];
  const renderCalls: { payload: FakePayload; context: RenderContext }[] = [];
  const effects = new Set<string>();
  let gate: Promise<void> | null = null;

  const fake: FakeOperation = {
    operation,
    executeCalls,
    reconcileCalls,
    claimFactsCalls,
    renderCalls,
    effects,
    outcomes: [],
    verdicts: [],
    claimFactsResult: {},
    onClaimFacts: null,
    draft: DEFAULT_DRAFT,
    renderThrows: false,
    hold() {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release: () => {
          release();
          gate = null;
        },
      };
    },
    definition: {
      operation,
      payload: FakePayloadSchema,
      async claimFacts(payload) {
        claimFactsCalls.push(payload);
        fake.onClaimFacts?.();
        if (fake.claimFactsResult instanceof Error) throw fake.claimFactsResult;
        return fake.claimFactsResult;
      },
      async execute(token, payload, context) {
        executeCalls.push({ token, payload, context });
        if (gate !== null) await gate;
        const next = fake.outcomes.shift() ?? { kind: "executed" };
        if (next instanceof Error) throw next;
        if (next.kind === "executed") effects.add(context.idempotencyKey);
        return next;
      },
      async reconcile(payload, context) {
        reconcileCalls.push({ payload, context });
        const next = fake.verdicts.shift() ?? { kind: "unknown", reason: "no-script" };
        if (next instanceof Error) throw next;
        return next;
      },
      render(payload, context) {
        renderCalls.push({ payload, context });
        if (fake.renderThrows) throw new Error("render failed");
        return fake.draft;
      },
    },
  };
  return fake;
}
