import {
  APPROVAL_CHIP_BOUND,
  APPROVAL_HISTORY_MAX,
  APPROVAL_PENDING_CAP_TOTAL,
  APPROVAL_RESPONSE_BUDGET_BYTES,
  APPROVAL_TEXT_CAPS,
  type ApprovalItemDraft,
  type ApprovalItemView,
  type ApprovalSummary,
  type ApprovalsSnapshot,
  type AuditRow,
  type ChangeOrigin,
  CLASSIFICATION,
  type ClassificationTable,
  capDiffLines,
  markReviewability,
  neutraliseUntrustedText,
  RunIdSchema,
  type StoredProposal,
  type ViewChange,
  type ViewPayloadField,
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

// ---------------------------------------------------------------------------
// The detail view

export interface ViewContext {
  /** The registered project's display name, or null. Display only; never a path. */
  readonly projectName: string | null;
}

const MAX_TARGET_ROWS = 8;
const MAX_RISKS = 10;
/** The least a risks list is trimmed to when the response budget forces a cut. */
const RISKS_WHEN_TRIMMED = 3;

const encoder = new TextEncoder();
/** The size of a serialised detail response, in UTF-8 bytes, which is what the client's cap counts. */
function viewResponseBytes(view: ApprovalItemView): number {
  return encoder.encode(JSON.stringify({ view })).length;
}

/** Neutralises one-line text to `max` source characters and at most `maxOutput` output characters. */
function oneLine(text: string, max: number, maxOutput: number = max * 2) {
  return neutraliseUntrustedText(text, { max, maxOutput });
}

/** The audit trail as the view shows it: the fixed event code and the time, newest twenty, oldest first. A reconciled outcome reads as the carried-out event. */
export function historyOf(audit: readonly AuditRow[]): ApprovalItemView["history"] {
  return audit.slice(-APPROVAL_HISTORY_MAX).map((row) => ({
    event: row.event === "reconciled-executed" ? "executed" : row.event,
    at: row.at,
  }));
}

function changeOf(
  change: ApprovalItemDraft["change"],
  origin: ChangeOrigin,
): { readonly change: ViewChange; readonly truncated: boolean } {
  switch (change.type) {
    case "none":
      return { change: { type: "none", origin }, truncated: false };
    case "diff":
      return capDiffLines(change.lines, origin);
    case "payload": {
      const fields: ViewPayloadField[] = [];
      let remaining: number = APPROVAL_TEXT_CAPS.diffChars;
      let truncated = false;
      for (const field of change.fields) {
        if (fields.length >= APPROVAL_TEXT_CAPS.diffLines) {
          truncated = true;
          break;
        }
        const label = oneLine(field.label, APPROVAL_TEXT_CAPS.label, 128).text;
        const value = neutraliseUntrustedText(field.value, {
          max: remaining,
          maxOutput: remaining,
        });
        remaining -= value.text.length;
        fields.push({ label: label === "" ? "Field" : label, value: value.text });
        if (value.truncated) {
          truncated = true;
          break;
        }
      }
      return { change: { type: "payload", origin, fields }, truncated };
    }
  }
}

function halved(change: ViewChange): ViewChange {
  if (change.type === "diff") {
    return { ...change, lines: change.lines.slice(0, Math.floor(change.lines.length / 2)) };
  }
  if (change.type === "payload") {
    return { ...change, fields: change.fields.slice(0, Math.floor(change.fields.length / 2)) };
  }
  return change;
}

function changeItems(change: ViewChange): number {
  if (change.type === "diff") return change.lines.length;
  if (change.type === "payload") return change.fields.length;
  return 0;
}

/**
 * The service-built view of one request (APPR-03, D-24, UI-SPEC S2): every
 * block, in the fixed order, with every requester-derived string neutralised
 * and capped, each block's origin taken from engine-held data only, and
 * `reviewable` false whenever anything the owner would be approving was cut
 * (by a cap, or by the response budget). Pure: no store, no clock, no log.
 */
export function buildApprovalView(
  stored: StoredProposal,
  draft: ApprovalItemDraft,
  audit: readonly AuditRow[],
  context: ViewContext,
  table: ClassificationTable = CLASSIFICATION,
): ApprovalItemView {
  const caps = APPROVAL_TEXT_CAPS;
  const operationLabel = operationLabelFor(table, stored.operation);

  const title = oneLine(draft.title, caps.title).text;
  const effect = draft.effect === null ? null : oneLine(draft.effect, 240, 480).text;
  const action = oneLine(draft.action, 240, 480).text;

  let targetCut = draft.target.length > MAX_TARGET_ROWS;
  const target = draft.target.slice(0, MAX_TARGET_ROWS).map((row) => {
    const label = oneLine(row.label, caps.label).text;
    const value = oneLine(row.value, caps.targetValue);
    if (value.truncated) targetCut = true;
    return { label: label === "" ? "Item" : label, value: value.text, mono: row.mono };
  });

  const origin: ChangeOrigin = draft.changeFromRequester ? "requester" : "engine";
  const change = changeOf(draft.change, origin);

  const reasonFull = neutraliseUntrustedText(stored.reason, {
    multiline: true,
    max: caps.reasonFull,
    maxOutput: caps.reasonFull * 2,
  });
  const reasonShown = neutraliseUntrustedText(stored.reason, {
    multiline: true,
    max: caps.reasonShown,
    maxOutput: caps.reasonShown * 2,
  });

  const runId = RunIdSchema.safeParse(stored.runId);
  const project = context.projectName === null ? null : oneLine(context.projectName, 120).text;
  const hint = draft.checkHint === null ? null : oneLine(draft.checkHint, 200, 400).text;
  const note = stored.outcomeNote === null ? null : oneLine(stored.outcomeNote, 150, 300).text;

  let base: Omit<ApprovalItemView, "reviewable"> = {
    proposalId: stored.proposalId,
    state: stored.state,
    revision: stored.revision,
    title: title === "" ? operationLabel : title,
    destructive: draft.destructive,
    effect: effect === "" ? null : effect,
    expiresAt: stored.expiresAt,
    requester: {
      kind: stored.requester.kind,
      label: oneLine(stored.requester.label, caps.label).text,
    },
    project: project === "" ? null : project,
    run: runId.success
      ? { runId: runId.data, name: oneLine(draft.runName ?? runId.data, 120).text }
      : null,
    action: action === "" ? "(no description)" : action,
    target,
    change: change.change,
    reason: {
      origin: "requester",
      shown: reasonShown.text,
      full: reasonFull.text,
      shortened: reasonFull.truncated,
    },
    risks: draft.risks
      .slice(0, MAX_RISKS)
      .map((risk) => oneLine(risk, 200, 400).text)
      .filter((risk) => risk !== ""),
    checkHint: hint === "" ? null : hint,
    record: {
      requestedAt: stored.createdAt,
      payloadHash: stored.payloadHash,
      fingerprint: stored.payloadHash.slice(0, 12),
      decidedAt: stored.decidedAt,
      decidedVia: stored.decidedVia,
      outcomeCode:
        stored.outcomeCode !== null && OUTCOME_CODE_PATTERN.test(stored.outcomeCode)
          ? stored.outcomeCode
          : null,
      outcomeNote: note === "" ? null : note,
    },
    history: historyOf(audit),
  };
  let truncation = {
    change: change.truncated,
    reason: reasonFull.truncated,
    target: targetCut,
  };

  let view = markReviewability(base, truncation);
  // The size guard (T-06-30): the client drops a response over its cap whole, so a view that would
  // not fit is trimmed here instead, and Approve is withheld because the owner is no longer shown it all.
  if (viewResponseBytes(view) > APPROVAL_RESPONSE_BUDGET_BYTES) {
    let trimmed = base.change;
    while (viewResponseBytes(view) > APPROVAL_RESPONSE_BUDGET_BYTES && changeItems(trimmed) > 0) {
      trimmed = halved(trimmed);
      base = { ...base, change: trimmed };
      truncation = { ...truncation, change: true };
      view = markReviewability(base, truncation);
    }
    if (viewResponseBytes(view) > APPROVAL_RESPONSE_BUDGET_BYTES) {
      base = { ...base, reason: { ...base.reason, full: base.reason.shown, shortened: true } };
      truncation = { ...truncation, reason: true };
      view = markReviewability(base, truncation);
    }
    if (viewResponseBytes(view) > APPROVAL_RESPONSE_BUDGET_BYTES) {
      base = { ...base, risks: base.risks.slice(0, RISKS_WHEN_TRIMMED) };
      view = markReviewability(base, truncation);
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// The bounded snapshot

export interface SnapshotInput {
  /** Pending first, soonest expiry first. */
  readonly pending: readonly ApprovalSummary[];
  /** Most recent decision first. */
  readonly decided: readonly ApprovalSummary[];
  /** Most recent expiry first. */
  readonly expired: readonly ApprovalSummary[];
  /** The true totals, which may exceed the lists. */
  readonly counts: { readonly pending: number; readonly decided: number; readonly expired: number };
}

/** Cuts text to `n` characters on a token boundary, never inside a `[U+XXXX]` token, never to nothing. */
function cutText(text: string, n: number): string {
  const chars = [...text];
  if (chars.length <= n) return text;
  let out = chars.slice(0, n).join("");
  const open = out.lastIndexOf("[U+");
  if (open !== -1 && !out.slice(open).includes("]")) out = out.slice(0, open);
  return out === "" ? "\u2026" : out;
}

function compact(summary: ApprovalSummary, n: number): ApprovalSummary {
  return {
    ...summary,
    title: cutText(summary.title, n),
    operationLabel: cutText(summary.operationLabel, Math.max(n, 40)),
    requesterLabel: cutText(summary.requesterLabel, n),
    projectName: summary.projectName === null ? null : cutText(summary.projectName, n),
  };
}

/** The text lengths a pending summary is squeezed to, in turn, when nothing else is left to drop. */
const PENDING_COMPACTION_STEPS = [80, 40, 24, 12] as const;

/**
 * Fits the approvals part of a snapshot under `budgetBytes`, measured as the
 * UTF-8 length of its serialised form (T-06-30). The oldest decided and
 * expired summaries go first. A pending request is never dropped: if the
 * pending list alone is over budget, its summaries' display text is shortened
 * instead (the full text is always one detail fetch away). Counts stay the
 * true totals; `truncated` is true whenever a list is shorter than its count
 * or anything was trimmed.
 */
export function assembleSnapshot(
  input: SnapshotInput,
  budgetBytes: number = APPROVAL_RESPONSE_BUDGET_BYTES,
): ApprovalsSnapshot {
  let pending = input.pending.slice(0, APPROVAL_PENDING_CAP_TOTAL);
  const decided = input.decided.slice(0, APPROVAL_CHIP_BOUND);
  const expired = input.expired.slice(0, APPROVAL_CHIP_BOUND);
  let squeezed = false;
  const build = (): ApprovalsSnapshot => ({
    ready: true,
    pending,
    decided,
    expired,
    counts: input.counts,
    truncated:
      squeezed ||
      pending.length < input.counts.pending ||
      decided.length < input.counts.decided ||
      expired.length < input.counts.expired,
  });
  const size = (snapshot: ApprovalsSnapshot): number =>
    encoder.encode(JSON.stringify(snapshot)).length;

  while (size(build()) > budgetBytes && (decided.length > 0 || expired.length > 0)) {
    if (expired.length >= decided.length) expired.pop();
    else decided.pop();
    squeezed = true;
  }
  if (size(build()) > budgetBytes) {
    const original = pending;
    for (const n of PENDING_COMPACTION_STEPS) {
      pending = original.map((summary) => compact(summary, n));
      squeezed = true;
      if (size(build()) <= budgetBytes) break;
    }
  }
  return build();
}
