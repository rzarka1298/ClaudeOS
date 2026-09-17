// Per ADR-0014 ("An LLM call that reads external content has no tools and no
// write path"), any model call that processes externally sourced content is
// constructed with no tool access and no write capability. This module is
// the boundary that makes that separation verifiable by tracing the call
// path rather than by reading a prompt: its import-boundary element
// (`untrusted`, see ../../../eslint.config.mjs) is allowed to import
// `@ccc/domain` and nothing else -- no adapter, no vault repository, no
// operational store, and no Keychain wrapper can ever reach this module's
// call graph, because the lint fails the build on the import edge itself.
// The real model invocation lands in Phase 7 (RSRCH-07/08/09); what lands
// here is the module and the boundary rule that constrains it, per
// ADR-0014's own text: "the module layout this phase establishes must make
// that separation expressible."

/**
 * Input to an untrusted-content summarization call: externally sourced
 * content that the caller has already delimited (never raw, un-delimited
 * text -- ADR-0014's mitigation list requires delimiting content before it
 * ever reaches a model).
 */
export interface SummarizeUntrustedInput {
  readonly delimitedContent: string;
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
 * path. The real model invocation is Phase 7's research pipeline; this stub
 * exists so the import-boundary lint (REPO-03) has a real consumer to
 * constrain from day one, per this phase's own objective.
 */
export async function summarizeUntrusted(
  input: SummarizeUntrustedInput,
): Promise<SummarizeUntrustedResult> {
  return { text: input.delimitedContent };
}
