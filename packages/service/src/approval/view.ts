import {
  type ApprovalSummary,
  CLASSIFICATION,
  type ClassificationTable,
  neutraliseUntrustedText,
  RunIdSchema,
  type StoredProposal,
} from "@ccc/domain";

/**
 * Turns stored proposals into the service-built view models the plugin renders
 * (D-24, ADR-0014, T-06-08, T-06-30). Every string a requester could influence
 * passes through the domain neutraliser and a cap before it leaves this file.
 * Pure: no store, no clock, no logging, no token. Imports `@ccc/domain` only.
 */

/** The longest text each summary field may carry, from the domain summary schema. A field is neutralised to AT MOST this many output characters, so a hostile run of control characters cannot overflow the schema (06-02 carry-forward). */
const SUMMARY_MAX = {
  title: 120,
  operationLabel: 80,
  requesterLabel: 64,
  projectName: 120,
} as const;

const OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Neutralises `text` to at most `max` output characters. */
function fit(text: string, max: number): string {
  return neutraliseUntrustedText(text, { max, maxOutput: max }).text;
}

function capitalise(text: string): string {
  const first = text.charAt(0);
  return first === "" ? text : first.toUpperCase() + text.slice(1);
}

/**
 * The fixed phrase naming an operation, from its classification row (never from
 * requester text). A name the table does not know, or a row that is not an
 * approval-required operation, gets a generic label rather than an error: the
 * summary of an odd row must still render.
 */
export function operationLabelFor(table: ClassificationTable, operation: string): string {
  const row = Object.hasOwn(table, operation) ? table[operation] : undefined;
  if (row?.class === "approval-required")
    return fit(capitalise(row.summary), SUMMARY_MAX.operationLabel);
  return "Unknown request";
}

export interface SummaryInfo {
  /** The engine-templated title, rendered from the stored payload; falls back to the operation label when none is available. */
  readonly title: string;
  readonly projectName: string | null;
  /** The classification table the engine was built with; defaults to the domain table. */
  readonly table?: ClassificationTable;
}

/**
 * One row of the inbox (APPR-03, D-28): identity, state, labels, times and the
 * outcome code. It carries no payload, no reason and no target value. The
 * title and the requester label are requester-influenced, so they are
 * neutralised to the summary schema's own maxima.
 */
export function summaryOf(stored: StoredProposal, info: SummaryInfo): ApprovalSummary {
  const operationLabel = operationLabelFor(info.table ?? CLASSIFICATION, stored.operation);
  const title = fit(info.title, SUMMARY_MAX.title);
  const runId = RunIdSchema.safeParse(stored.runId);
  const project = info.projectName === null ? null : fit(info.projectName, SUMMARY_MAX.projectName);
  return {
    proposalId: stored.proposalId,
    state: stored.state,
    revision: stored.revision,
    title: title === "" ? operationLabel : title,
    operationLabel,
    requesterKind: stored.requester.kind,
    requesterLabel: fit(stored.requester.label, SUMMARY_MAX.requesterLabel),
    projectName: project === "" ? null : project,
    runId: runId.success ? runId.data : null,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    decidedAt: stored.decidedAt,
    outcomeCode:
      stored.outcomeCode !== null && OUTCOME_CODE_PATTERN.test(stored.outcomeCode)
        ? stored.outcomeCode
        : null,
  };
}
