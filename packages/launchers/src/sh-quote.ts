/** Why a value was refused by {@link shQuote} or the launch-script renderer. */
export type UnsafeScriptArgumentReason = "nul" | "line-break" | "env-key";

/** RED skeleton (plan 04-02 task 1): the refusal type exists; the rule does not yet. */
export class UnsafeScriptArgumentError extends Error {
  readonly reason: UnsafeScriptArgumentReason;

  constructor(reason: UnsafeScriptArgumentReason) {
    super("value cannot be placed in a launch script");
    this.name = "UnsafeScriptArgumentError";
    this.reason = reason;
  }
}

/** RED skeleton: returns the value unquoted. */
export function shQuote(value: string): string {
  return value;
}
