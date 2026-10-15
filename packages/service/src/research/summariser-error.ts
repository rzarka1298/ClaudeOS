import type { RunErrorCode } from "@ccc/domain";

/** The run error codes a summariser call can end in (a subset of RUN_ERROR_CODES). */
export type SummariserErrorCode = Extract<
  RunErrorCode,
  | "summariser-unconfigured"
  | "summariser-failed"
  | "summariser-refused"
  | "summariser-invalid-output"
>;

/**
 * A failed summariser call. It carries a closed run error code and nothing else: the message is the
 * code, there is no `cause`, and no status text, response body, header, key or input text is ever
 * attached (ADR-0017, research Pattern 3). A caller records `code` and shows its fixed wording.
 */
export class SummariserError extends Error {
  readonly code: SummariserErrorCode;

  constructor(code: SummariserErrorCode) {
    super(code);
    this.name = "SummariserError";
    this.code = code;
  }
}
