// Per ADR-0014 ("An LLM call that reads external content has no tools and no
// write path"), any model call that processes externally sourced content is
// constructed with no tool access and no write capability. This module is
// the boundary that makes that separation verifiable by tracing the call
// path rather than by reading a prompt, and it is enforced three ways:
//   1. its import-boundary element (`untrusted`, see ../../../eslint.config.mjs)
//      is allowed to import `@ccc/domain` and nothing else;
//   2. this folder is a nested composite TypeScript project with
//      `"types": []` (./tsconfig.json), so `fetch`, `process`, `require`,
//      `Buffer`, timers, `console` and every `node:` module do not exist when
//      it compiles;
//   3. a grep backstop rule in scripts/check-boundaries.sh rejects the names
//      the compiler still allows (`globalThis`, `eval`, `Function`, dynamic
//      `import`, ...).
// What remains is a value-in, value-out function over a text port: the module
// hands two strings to a `TextTransport` somebody else constructs at the
// composition root and returns the text that comes back. It holds no
// credential, file handle, network client, process handle or tool
// declaration, and its request type has no field in which one could be put.

import { SUMMARISER_INSTRUCTIONS } from "./instructions.js";

/** Source ids are the lowercase SHA-256-derived 32-hex ids minted at fetch time. */
const SOURCE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Why a call was refused before the transport was reached. */
export type UntrustedInputErrorCode = "no-source-ids" | "invalid-source-id";

/** Raised for a call that is refused before the transport is called. */
export class UntrustedInputError extends Error {
  readonly code: UntrustedInputErrorCode;

  constructor(code: UntrustedInputErrorCode, message: string) {
    super(message);
    this.name = "UntrustedInputError";
    this.code = code;
  }
}

/**
 * The only door out of this module: text in, text out. The request carries two
 * strings and nothing else, so there is no field to declare a tool, a function
 * schema or a credential in. The implementation is constructed by the trusted
 * composition root; this module never sees how it reaches a model.
 */
export interface TextTransport {
  complete(request: { readonly instructions: string; readonly input: string }): Promise<string>;
}

/**
 * Input to an untrusted-content summarization call: externally sourced
 * content that the caller has already delimited (never raw, un-delimited
 * text -- ADR-0014's mitigation list requires delimiting content before it
 * ever reaches a model), plus the ids of the sources it contains.
 */
export interface SummarizeUntrustedInput {
  readonly delimitedContent: string;
  readonly sourceIds: readonly string[];
}

/**
 * The declared contract of an untrusted-content summarization call: it
 * returns text and nothing else. No tool result, no write confirmation, and
 * no side effect can ever be observed here -- a separate, trusted stage
 * decides what, if anything, happens with the returned text.
 */
export interface SummarizeUntrustedResult {
  readonly text: string;
}

/**
 * Summarizes externally sourced content with no tool access and no write
 * path: validates the source ids, hands the fixed instructions and the
 * delimited input to the injected transport exactly once, and returns the
 * transport's text unchanged. A transport error propagates as the same error
 * object and is never retried here.
 */
export async function summarizeUntrusted(
  input: SummarizeUntrustedInput,
  transport: TextTransport,
): Promise<SummarizeUntrustedResult> {
  if (input.sourceIds.length === 0) {
    throw new UntrustedInputError(
      "no-source-ids",
      "a summarisation call needs at least one source id",
    );
  }
  for (const id of input.sourceIds) {
    if (!SOURCE_ID_PATTERN.test(id)) {
      throw new UntrustedInputError(
        "invalid-source-id",
        "a source id is not 32 lowercase hex characters",
      );
    }
  }
  const text = await transport.complete({
    instructions: SUMMARISER_INSTRUCTIONS,
    input: `${input.delimitedContent}\nSource IDs: ${input.sourceIds.join(", ")}`,
  });
  return { text };
}
