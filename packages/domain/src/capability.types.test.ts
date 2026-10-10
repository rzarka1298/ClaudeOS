// TYPE tests for the capability token (D-02, T-06-01, research Pattern 5).
// `tsc -b` (this package's build and typecheck) fails if any `@ts-expect-error`
// below stops being an error, so each line is a claim the compiler re-proves
// on every build: a token can be named only for an approval-required
// operation. Vitest cannot check types, so the runtime assertion below only
// proves this file is loaded; the proof is the build.
import { describe, expect, it } from "vitest";
import type { CapabilityToken } from "./capability.js";
import type {
  ApprovalRequiredOperation,
  EnabledOperation,
  OperationName,
  ReservedOperation,
} from "./classification.js";

// Never called: these declarations exist only to be type-checked.
export type EnabledForceTerminate = CapabilityToken<"session.force-terminate">;
export type EnabledDiagnostic = CapabilityToken<"diagnostic.test">;
export type ReservedStillApprovalRequired = CapabilityToken<"vault.delete">;

// @ts-expect-error -- a no-approval operation can never hold a token
export type NoApproval = CapabilityToken<"vault.write-note">;

// @ts-expect-error -- a direct gesture can never hold a token
export type Gesture = CapabilityToken<"session.focus">;

// @ts-expect-error -- an unclassified operation can never hold a token
export type Invented = CapabilityToken<"no.such.operation">;

// @ts-expect-error -- a bare string is not an operation
export type AnyString = CapabilityToken<string>;

// The operation unions partition the approval-required set.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const enabledAndReservedCoverApprovalRequired: Equal<
  EnabledOperation | ReservedOperation,
  ApprovalRequiredOperation
> = true;
const approvalRequiredIsAnOperationName: ApprovalRequiredOperation extends OperationName
  ? true
  : false = true;
const enabledIsExactlyTwo: Equal<EnabledOperation, "session.force-terminate" | "diagnostic.test"> =
  true;

// A token's operation field carries the literal it was named for.
const operationIsTheLiteral: Equal<
  CapabilityToken<"session.force-terminate">["operation"],
  "session.force-terminate"
> = true;

describe("CapabilityToken is generic only over approval-required operations (type test)", () => {
  it("compiles only for approval-required names (enforced by tsc -b)", () => {
    expect(enabledAndReservedCoverApprovalRequired).toBe(true);
    expect(approvalRequiredIsAnOperationName).toBe(true);
    expect(enabledIsExactlyTwo).toBe(true);
    expect(operationIsTheLiteral).toBe(true);
  });
});
