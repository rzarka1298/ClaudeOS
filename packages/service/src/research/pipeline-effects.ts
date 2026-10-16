import type { NonApprovalOperation } from "@ccc/domain";

/**
 * Every effect the research pipeline performs, named by an operation in the static
 * classification table (D-17, RSRCH-06, ADR-0026). The pipeline is written against the
 * classification contract from its first line: each effect step below calls
 * {@link nameEffect} with the operation it performs, where it happens.
 *
 * - `trigger`    the owner's click on Run now (a direct gesture);
 * - `fetch`      the public, read-only GET of an allowlisted address;
 * - `summarise`  the tool-free, write-free summariser call;
 * - `writeNotes` managed raw, wiki and report notes, written atomically inside the owner's vault;
 * - `recordRun`  the private run record plus the generated automation-runs note.
 *
 * The `satisfies` clause makes it a compile-time fact that none of these is an approval-required
 * row, and `pipeline-effects.test.ts` repeats the check at run time and requires the value set to
 * equal `RESEARCH_PIPELINE_OPERATIONS`. Any future external write (publishing, Git) is a reserved
 * approval row and must never join this map: it would first need its own enabled row and executor,
 * and would be reached only through the approval engine.
 */
export const PIPELINE_EFFECTS = {
  trigger: "research.run-now",
  fetch: "research.fetch-sources",
  summarise: "research.summarise",
  writeNotes: "research.write-notes",
  recordRun: "automation-run.record",
} as const satisfies Readonly<Record<string, NonApprovalOperation>>;

export type PipelineEffect = (typeof PIPELINE_EFFECTS)[keyof typeof PIPELINE_EFFECTS];

/** Reports an effect step to an audit observer, if one is attached. A broken observer changes nothing. */
export function nameEffect(
  audit: ((operation: PipelineEffect) => void) | undefined,
  operation: PipelineEffect,
): void {
  try {
    audit?.(operation);
  } catch {
    // An observer never changes what the pipeline does.
  }
}
