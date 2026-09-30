import type { CapabilityToken, RunId, SessionTerminator } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import type { createTerminateExecutor } from "./terminate-executor.js";

/**
 * TYPE tests for the force-terminate executor (SESS-16, D-01, PR-26,
 * T-05-58). `tsc -b` (the service's build and typecheck) fails if any
 * `@ts-expect-error` below stops being an error, so each line is a claim
 * the compiler re-proves on every build: the executor cannot be called
 * without an approval-issued `CapabilityToken<"session.force-terminate">`,
 * a token for another operation does not fit, and no typed-confirmation
 * shortcut (a plain object, a string) can stand in for one.
 */

// Never called: these bodies exist only to be type-checked.
function typeClaims(
  executor: SessionTerminator,
  runId: RunId,
  otherOperation: CapabilityToken<"vault.write">,
): void {
  // @ts-expect-error -- no token at all
  void executor.terminate(runId);

  // @ts-expect-error -- a capability for a different operation
  void executor.terminate(otherOperation, runId);

  const lookAlike = { proposalId: "p", operation: "session.force-terminate", expiresAt: "" };
  // @ts-expect-error -- a look-alike object without the capability brand
  void executor.terminate(lookAlike, runId);

  const typedConfirmation = "CONFIRM TERMINATE";
  // @ts-expect-error -- a typed confirmation string is not an approval
  void executor.terminate(typedConfirmation, runId);
}

// The factory's product is exactly the port: no extra, token-free method.
type Methods = keyof ReturnType<typeof createTerminateExecutor>;
const onlyTerminate: [Methods] extends ["terminate"] ? true : false = true;

describe("the terminate executor is typed on the approval capability (Task 3 type test)", () => {
  it("compiles only with CapabilityToken<'session.force-terminate'> (enforced by tsc -b)", () => {
    expect(typeof typeClaims).toBe("function");
    expect(onlyTerminate).toBe(true);
  });
});
