import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY, type ApprovalFilter } from "@ccc/domain/approval-view.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { type ApprovalDecideInput, approvalsApi } from "../approvals/api.js";
import {
  applyApprovalSummary,
  approvalsById,
  approvalsCounts,
  approvalsHydrated,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { sessionsById } from "../widgets/session-signals.js";
import { detailFocusRequested, selectedRunId } from "./agent-runs-state.js";
import { ApprovalDetail } from "./approval-detail.js";
import { APPROVALS_HEADING, REQUESTER_KIND_LABEL, SELECT_PROMPT } from "./approvals-copy.js";
import {
  APPROVAL_FILTERS,
  announceApproval,
  approvalChip,
  approvalDetailCache,
  approvalPages,
  approvalsSectionVisible,
  approvalsStatus,
  chipName,
  chipText,
  orderedApprovals,
} from "./approvals-state.js";
import { notify } from "./notify-port.js";

/**
 * The Approvals section of the Agent runs destination (UI-SPEC S1): the filter
 * chips with their true counts, the ordered list, the one polite status line
 * and the request pane from plan 06-11.
 *
 * A leaf view: it reads the approval signals itself, takes the clock as a prop
 * and asks the service only through the API holder in `approvals/api.ts`. It
 * imports nothing from `obsidian` and no service client. Every control here
 * selects, filters or hands a decision to the pane; the service decides.
 */

export interface ApprovalsSectionProps {
  /** The clock, in epoch milliseconds. Views never read the ambient clock. */
  readonly now: number;
  /** Selects the originating Run in the sessions layout. Defaults to the Agent runs selection signals. */
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  /**
   * Fetches one request again when its expiry passes, so the list learns the
   * outcome; it never decides. Defaults to asking the service for the request
   * and adopting the summary it returns.
   */
  readonly refreshOne?: ((proposalId: string) => Promise<void>) | undefined;
}

function openRunInSessions(runId: string): void {
  selectedRunId.value = runId;
  detailFocusRequested.value = true;
}

function isRunLoaded(runId: string): boolean {
  return sessionsById.value.has(runId);
}

function ApprovalRow({
  summary,
  selected,
  onSelect,
}: {
  readonly summary: ApprovalSummary;
  readonly selected: boolean;
  readonly onSelect: (summary: ApprovalSummary, button: HTMLButtonElement) => void;
}): VNode {
  const display = APPROVAL_STATE_DISPLAY[summary.state];
  const metaId = useId();
  return (
    <li className="ccc-approval-row" data-selected={selected ? "true" : undefined}>
      <button
        type="button"
        className="ccc-approval-row-button"
        aria-current={selected ? "true" : undefined}
        aria-describedby={metaId}
        title={summary.title}
        onClick={(event) => onSelect(summary, event.currentTarget)}
      >
        <span className="ccc-clamp-2">{summary.title}</span>
      </button>
      <p id={metaId} className="ccc-approval-row-meta">
        <span data-emphasis={summary.state === "pending" ? "true" : undefined}>
          <span aria-hidden="true">{display.glyph}</span> {display.label}
        </span>
        {" · "}
        {`${REQUESTER_KIND_LABEL[summary.requesterKind]}: ${summary.requesterLabel}`}
      </p>
    </li>
  );
}

export function ApprovalsSection({ now, onOpenRun }: ApprovalsSectionProps): VNode {
  const headingId = useId();
  const byId = approvalsById.value;
  const hydrated = approvalsHydrated.value;
  const counts = hydrated ? approvalsCounts.value : null;
  const chip = approvalChip.value;
  const selected = selectedProposalId.value;
  const connected = connectionState.value.kind === "live";
  const pageSize = approvalPages.value[chip];
  const all = orderedApprovals(byId, chip);
  const rows = all.slice(0, pageSize);
  const selectedSummary = selected === null ? undefined : byId.get(selected);

  useEffect(() => {
    approvalsSectionVisible.value = true;
    return () => {
      approvalsSectionVisible.value = false;
    };
  }, []);

  const originRef = useRef<HTMLButtonElement | null>(null);

  function handleSelect(summary: ApprovalSummary, button: HTMLButtonElement): void {
    originRef.current = button;
    selectedProposalId.value = summary.proposalId;
  }

  /** Decisions go to the service; a decided answer moves the row through the signals at once. */
  async function decide(input: ApprovalDecideInput) {
    const response = await approvalsApi().decide(input);
    if (response.outcome === "decided") applyApprovalSummary(response.approval);
    return response;
  }

  return (
    <section className="ccc-approvals" aria-labelledby={headingId}>
      <div className="ccc-approvals-header">
        <h3 id={headingId} tabIndex={-1}>
          {APPROVALS_HEADING}
        </h3>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: UI-SPEC S1 specifies role="group" with aria-label "Approval filter" for the chip row; a <fieldset> brings native legend styling the pills do not want. */}
      <div role="group" aria-label="Approval filter" className="ccc-filter-group">
        {APPROVAL_FILTERS.map((filter: ApprovalFilter) => (
          <button
            key={filter}
            type="button"
            className="ccc-filter-chip"
            aria-pressed={chip === filter ? "true" : "false"}
            aria-label={chipName(filter, counts)}
            onClick={() => {
              approvalChip.value = filter;
            }}
          >
            {chipText(filter, counts)}
          </button>
        ))}
      </div>
      <p className="ccc-approvals-status" role="status" aria-live="polite">
        {approvalsStatus.value}
      </p>
      <div className="ccc-approvals-layout">
        <div className="ccc-approvals-list">
          <ul className="ccc-approval-list">
            {rows.map((summary) => (
              <ApprovalRow
                key={summary.proposalId}
                summary={summary}
                selected={summary.proposalId === selected}
                onSelect={handleSelect}
              />
            ))}
          </ul>
        </div>
        {selected === null ? (
          <div className="ccc-detail-pane">
            <p className="ccc-state-body">{SELECT_PROMPT}</p>
          </div>
        ) : (
          <ApprovalDetail
            proposalId={selected}
            now={now}
            connected={connected}
            stale={false}
            get={(id) => approvalDetailCache.get(id)}
            decide={decide}
            announce={announceApproval}
            notify={notify}
            summary={selectedSummary}
            revision={selectedSummary?.revision}
            activeFilter={chip}
            onShowFilter={(filter) => {
              approvalChip.value = filter;
            }}
            isRunLoaded={isRunLoaded}
            onOpenRun={onOpenRun ?? openRunInSessions}
            focusOnLoad
          />
        )}
      </div>
    </section>
  );
}
