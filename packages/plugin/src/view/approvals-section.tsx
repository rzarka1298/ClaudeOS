import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY, type ApprovalFilter } from "@ccc/domain/approval-view.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { type ApprovalDecideInput, approvalsApi, refreshApprovals } from "../approvals/api.js";
import {
  applyApprovalSummary,
  approvalDetailFocusRequested,
  approvalsById,
  approvalsCounts,
  approvalsHydrated,
  approvalsReady,
  approvalsTruncated,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { WidgetFooter } from "../widgets/footer.js";
import { sessionsById } from "../widgets/session-signals.js";
import { detailFocusRequested, selectedRunId } from "./agent-runs-state.js";
import { ApprovalDetail } from "./approval-detail.js";
import { UntrustedText } from "./approval-text.js";
import {
  APPROVALS_HEADING,
  BACK_TO_REQUESTS,
  BOUND_NOTE,
  EMPTY_COPY,
  FILTER_GROUP_LABEL,
  KEPT_SAFELY,
  LOADING_SECTION,
  moreLoadedText,
  NEW_REQUEST_ANNOUNCEMENT,
  NO_PROJECT,
  NOT_READY_BODY,
  NOT_READY_HEADING,
  needsDecisionText,
  REFRESH_APPROVALS,
  REFRESHED_STATUS,
  REQUESTER_KIND_LABEL,
  SECTION_ERROR_BODY,
  SECTION_ERROR_HEADING,
  SELECT_PROMPT,
  settledStatus,
  showMoreLabel,
} from "./approvals-copy.js";
import {
  APPROVAL_FILTERS,
  APPROVAL_PAGE_SIZE,
  announceApproval,
  approvalChip,
  approvalDetailCache,
  approvalPages,
  approvalsFooterModel,
  approvalsLoadFailed,
  approvalsMissedSync,
  approvalsObservedAt,
  approvalsSectionVisible,
  approvalsStatus,
  approvalTimePhrase,
  chipName,
  chipText,
  expiredPendingIds,
  hasArrival,
  orderedApprovals,
  pendingIdSet,
  showMoreApprovals,
} from "./approvals-state.js";
import { approvalsHeadingRequested, consumeApprovalsHeadingRequest } from "./navigation-request.js";
import { notify } from "./notify-port.js";

/**
 * The Approvals section of the Agent runs destination (UI-SPEC S1): the filter
 * chips with their true counts, the ordered list, every section state, the one
 * polite status line and the request pane from plan 06-11.
 *
 * A leaf view: it reads the approval signals itself, takes the clock as a prop
 * and asks the service only through the API holder in `approvals/api.ts`. It
 * imports nothing from `obsidian` and no service client. Every control here
 * selects, filters, refreshes or hands a decision to the pane; the service
 * decides, and the section never decides anything locally (not even an expiry).
 *
 * The status line announces only two things: the outcome of an action the owner
 * took, and the arrival of a new pending request. Counts, countdowns and other
 * requests' transitions are silent.
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

async function refreshRequest(proposalId: string): Promise<void> {
  try {
    const detail = await approvalDetailCache.get(proposalId);
    applyApprovalSummary(detail.summary);
  } catch {
    // The next event or refresh settles it; a failed question changes nothing.
  }
}

/** The outcomes a request reaches after the owner approved it, which the status line reports. */
const FINISHED_STATES: ReadonlySet<ApprovalSummary["state"]> = new Set([
  "executed",
  "failed",
  "unknown",
]);

function ApprovalRow({
  summary,
  now,
  selected,
  onSelect,
}: {
  readonly summary: ApprovalSummary;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (summary: ApprovalSummary, button: HTMLButtonElement) => void;
}): VNode {
  const display = APPROVAL_STATE_DISPLAY[summary.state];
  const metaId = useId();
  const phrase = approvalTimePhrase(summary, now);
  const weighted = summary.state === "pending" || summary.state === "unknown";
  return (
    <li
      className="ccc-approval-row"
      data-selected={selected ? "true" : undefined}
      data-state={summary.state}
    >
      <button
        type="button"
        className="ccc-approval-row-button"
        aria-current={selected ? "true" : undefined}
        aria-describedby={metaId}
        title={summary.title}
        onClick={(event) => onSelect(summary, event.currentTarget)}
      >
        <span className="ccc-clamp-2">
          <UntrustedText text={summary.title} />
        </span>
      </button>
      <p id={metaId} className="ccc-approval-row-meta">
        <span data-emphasis={weighted ? "true" : undefined}>
          <span aria-hidden="true">{display.glyph}</span> {display.label}
        </span>
        {" · "}
        <span>
          {`${REQUESTER_KIND_LABEL[summary.requesterKind]}: `}
          <UntrustedText text={summary.requesterLabel} />
        </span>
        {" · "}
        <span>
          {summary.projectName === null ? NO_PROJECT : <UntrustedText text={summary.projectName} />}
        </span>
        {" · "}
        <span data-emphasis={phrase.urgent ? "true" : undefined}>{phrase.text}</span>
      </p>
    </li>
  );
}

function EmptyCopy({ filter }: { readonly filter: ApprovalFilter }): VNode {
  const [heading, ...rest] = EMPTY_COPY[filter];
  return (
    <div className="ccc-approvals-empty">
      <p className="ccc-state-heading">{heading}</p>
      {rest.map((line) => (
        <p className="ccc-state-body" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function ApprovalsSection({ now, onOpenRun, refreshOne }: ApprovalsSectionProps): VNode {
  const headingId = useId();
  const byId = approvalsById.value;
  const hydrated = approvalsHydrated.value;
  const ready = approvalsReady.value;
  const truncated = approvalsTruncated.value;
  const counts = hydrated ? approvalsCounts.value : null;
  const chip = approvalChip.value;
  const selected = selectedProposalId.value;
  const connection = connectionState.value;
  const connected = connection.kind === "live";
  const disconnected = connection.kind === "disconnected";
  const missedSync = approvalsMissedSync.value;
  const loadFailed = approvalsLoadFailed.value;
  const observedAt = approvalsObservedAt.value;
  const pageSize = approvalPages.value[chip];
  const headingRequested = approvalsHeadingRequested.value;
  const detailFocus = approvalDetailFocusRequested.value;

  const all = orderedApprovals(byId, chip);
  const rows = all.slice(0, pageSize);
  const hidden = all.length - rows.length;
  const selectedSummary = selected === null ? undefined : byId.get(selected);

  const notReady = hydrated && ready === false;
  const loading = !hydrated && !loadFailed && !disconnected;
  const offline = !hydrated && disconnected;
  const errored = !hydrated && loadFailed && !disconnected;
  const showList = hydrated && !notReady;
  const stale = showList && missedSync && !disconnected;
  const dimmed = showList && disconnected;
  const pendingCount = counts === null ? 0 : counts.pending;

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const paneHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const originRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [focusFor, setFocusFor] = useState<string | null>(null);

  // Visible to the notifier exactly while mounted.
  useEffect(() => {
    mounted.current = true;
    approvalsSectionVisible.value = true;
    return () => {
      mounted.current = false;
      approvalsSectionVisible.value = false;
    };
  }, []);

  /** Fetches the inbox again; the one place a failed load becomes the error state or a stale list. */
  async function refresh(announce: boolean): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    const ok = await refreshApprovals();
    if (!mounted.current) return;
    setRefreshing(false);
    if (ok) {
      approvalsLoadFailed.value = false;
      approvalsMissedSync.value = false;
      if (announce) announceApproval(REFRESHED_STATUS);
      return;
    }
    if (approvalsHydrated.peek()) approvalsMissedSync.value = true;
    else approvalsLoadFailed.value = true;
    if (announce) announceApproval(SECTION_ERROR_HEADING);
  }

  // The first load: the stream's snapshot normally brings the inbox, and one
  // direct ask covers a service that does not send it. Once per mount.
  const asked = useRef(false);
  useEffect(() => {
    if (hydrated || !connected || asked.current) return;
    asked.current = true;
    void refresh(false);
  }, [hydrated, connected]);

  // A dropped stream means the list may have missed changes; a snapshot or an
  // event arriving while live means it has not.
  useEffect(() => {
    if (hydrated && connection.kind !== "live") approvalsMissedSync.value = true;
  }, [hydrated, connection.kind]);
  const seenById = useRef(byId);
  useEffect(() => {
    if (seenById.current === byId) return;
    seenById.current = byId;
    if (hydrated && connection.kind === "live") approvalsMissedSync.value = false;
  }, [byId, hydrated, connection.kind]);

  // When this view last saw the list change (the provenance strip's time).
  const observedFor = useRef<typeof byId | null>(null);
  useEffect(() => {
    if (!hydrated || observedFor.current === byId) return;
    observedFor.current = byId;
    approvalsObservedAt.value = new Date(now).toISOString();
  }, [byId, hydrated, now]);

  // One refetch per expiring request, never a local decision (Pitfall 9).
  const refetched = useRef(new Set<string>());
  useEffect(() => {
    for (const id of refetched.current) {
      if (byId.get(id)?.state !== "pending") refetched.current.delete(id);
    }
    for (const id of expiredPendingIds(byId, now)) {
      if (refetched.current.has(id)) continue;
      refetched.current.add(id);
      void (refreshOne ?? refreshRequest)(id);
    }
  }, [byId, now, refreshOne]);

  // The arrival of a new pending request is announced once, after the first snapshot.
  const knownPending = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const current = pendingIdSet(byId);
    const previous = knownPending.current;
    knownPending.current = current;
    if (previous !== null && hasArrival(previous, current)) {
      announceApproval(NEW_REQUEST_ANNOUNCEMENT);
    }
  }, [byId, hydrated]);

  // A request the owner approved here reports how it ended, once.
  const approvedHere = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [id, title] of approvedHere.current) {
      const summary = byId.get(id);
      if (summary === undefined || !FINISHED_STATES.has(summary.state)) continue;
      approvedHere.current.delete(id);
      const settled = settledStatus(summary.state, title, summary.outcomeCode);
      announceApproval(settled.status);
      if (settled.notice !== null) notify(settled.notice);
    }
  }, [byId]);

  // A selection from outside presses the chip that holds the request; a request
  // that merely changed state while selected never moves the chip.
  const resolvedFor = useRef<string | null>(null);
  useEffect(() => {
    if (selected === null) {
      resolvedFor.current = null;
      return;
    }
    if (resolvedFor.current === selected) return;
    const known = byId.get(selected);
    if (known === undefined) {
      if (hydrated) resolvedFor.current = selected;
      return;
    }
    resolvedFor.current = selected;
    const filter = APPROVAL_STATE_DISPLAY[known.state].filter;
    if (filter !== approvalChip.peek()) approvalChip.value = filter;
  }, [selected, byId, hydrated]);

  // The pane takes focus only for a selection the owner just made: a row, or a
  // notification, link or button that raised the hand-off request.
  useEffect(() => {
    if (!approvalDetailFocusRequested.peek()) return;
    approvalDetailFocusRequested.value = false;
    if (selected === null) return;
    if (focusFor === selected) paneHeadingRef.current?.focus();
    else setFocusFor(selected);
  }, [detailFocus, selected]);

  // The palette command: press Pending and land on the heading, selecting nothing.
  useEffect(() => {
    if (!consumeApprovalsHeadingRequest()) return;
    approvalChip.value = "pending";
    headingRef.current?.focus();
  }, [headingRequested]);

  // After `Show 25 more`, focus goes to the first row that was added.
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    if (focusRow.current === null) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      ".ccc-approval-row-button",
    );
    buttons?.[focusRow.current]?.focus();
    focusRow.current = null;
  }, [rows.length]);

  function handleSelect(summary: ApprovalSummary, button: HTMLButtonElement): void {
    originRef.current = button;
    setFocusFor(summary.proposalId);
    selectedProposalId.value = summary.proposalId;
  }

  function handleShowMore(): void {
    focusRow.current = rows.length;
    const added = Math.min(APPROVAL_PAGE_SIZE, hidden);
    showMoreApprovals(chip);
    announceApproval(moreLoadedText(added));
  }

  function handleBack(): void {
    selectedProposalId.value = null;
    const origin = originRef.current;
    if (origin?.isConnected === true) origin.focus();
    else headingRef.current?.focus();
  }

  /** The Back control is only displayed where the pane stacks under the list. */
  function isStacked(): boolean {
    const back = backRef.current;
    return back !== null && getComputedStyle(back).display !== "none";
  }

  function handlePaneKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || selected === null || !isStacked()) return;
    event.preventDefault();
    handleBack();
  }

  function handleListKeyDown(event: KeyboardEvent): void {
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(".ccc-approval-row-button") ?? []),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const last = buttons.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(index + 1, last);
        break;
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }

  /** Decisions go to the service; a decided answer moves the row through the signals at once. */
  async function decide(input: ApprovalDecideInput) {
    const response = await approvalsApi().decide(input);
    if (response.outcome === "decided") {
      if (input.decision === "approve") {
        approvedHere.current.set(input.proposalId, response.approval.title);
      }
      applyApprovalSummary(response.approval);
    }
    return response;
  }

  const footerModel = approvalsFooterModel({
    hydrated,
    ready,
    disconnected,
    missedSync,
    observedAt,
  });

  return (
    <section
      className="ccc-approvals"
      aria-labelledby={headingId}
      aria-busy={loading ? "true" : undefined}
    >
      <div className="ccc-approvals-header">
        <h3 id={headingId} tabIndex={-1} ref={headingRef}>
          {APPROVALS_HEADING}
        </h3>
        {pendingCount > 0 && (
          <p className="ccc-approvals-summary">{needsDecisionText(pendingCount)}</p>
        )}
      </div>
      {!notReady && (
        <div className="ccc-filter-group">
          {/* biome-ignore lint/a11y/useSemanticElements: UI-SPEC S1 specifies role="group" with aria-label "Approval filter" for the chip row; a <fieldset> brings native legend styling the pills do not want. */}
          <div role="group" aria-label={FILTER_GROUP_LABEL} className="ccc-filter-group">
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
          {(stale || errored) && (
            <button
              type="button"
              className="ccc-list-more"
              aria-disabled={refreshing ? "true" : undefined}
              aria-busy={refreshing ? "true" : undefined}
              onClick={() => {
                void refresh(true);
              }}
            >
              {REFRESH_APPROVALS}
            </button>
          )}
        </div>
      )}
      <p className="ccc-approvals-status" role="status" aria-live="polite">
        {approvalsStatus.value}
      </p>
      {(dimmed || offline) && <p className="ccc-approvals-note">{KEPT_SAFELY}</p>}
      {loading && (
        <div className="ccc-approvals-loading">
          <span className="ccc-visually-hidden">{LOADING_SECTION}</span>
          {[0, 1, 2].map((line) => (
            <div className="ccc-skeleton-line" key={line} />
          ))}
        </div>
      )}
      {errored && (
        <div className="ccc-approvals-empty">
          <p className="ccc-state-heading">
            <span className="ccc-error-glyph" aria-hidden="true">
              {"▲"}
            </span>
            <span>{SECTION_ERROR_HEADING}</span>
          </p>
          <p className="ccc-state-body">{SECTION_ERROR_BODY}</p>
        </div>
      )}
      {notReady && (
        <div className="ccc-approvals-empty">
          <p className="ccc-state-heading">{NOT_READY_HEADING}</p>
          <p className="ccc-state-body">{NOT_READY_BODY}</p>
        </div>
      )}
      {/* A selected request shows its pane even before the first snapshot: a link
          can arrive ahead of the list, and the pane asks the service itself. */}
      {!notReady &&
        (showList || selected !== null) &&
        (showList && rows.length === 0 && selected === null ? (
          counts !== null && counts[chip] === 0 ? (
            <EmptyCopy filter={chip} />
          ) : (
            <p className="ccc-list-meta">{BOUND_NOTE}</p>
          )
        ) : (
          <div
            className="ccc-approvals-layout"
            data-has-selection={selected === null ? undefined : "true"}
          >
            <div className="ccc-approvals-list" data-dimmed={dimmed ? "true" : undefined}>
              <ul className="ccc-approval-list" ref={listRef} onKeyDown={handleListKeyDown}>
                {rows.map((summary) => (
                  <ApprovalRow
                    key={summary.proposalId}
                    summary={summary}
                    now={now}
                    selected={summary.proposalId === selected}
                    onSelect={handleSelect}
                  />
                ))}
              </ul>
              {hidden > 0 && (
                <button type="button" className="ccc-list-more" onClick={handleShowMore}>
                  {showMoreLabel(Math.min(APPROVAL_PAGE_SIZE, hidden))}
                </button>
              )}
              {hidden === 0 && truncated && counts !== null && all.length < counts[chip] && (
                <p className="ccc-list-meta">{BOUND_NOTE}</p>
              )}
            </div>
            {selected === null ? (
              <div className="ccc-detail-pane">
                <p className="ccc-state-body">{SELECT_PROMPT}</p>
              </div>
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: Escape returns to the list in the stacked layout; the wrapper is not interactive itself.
              <div className="ccc-approvals-pane" onKeyDown={handlePaneKeyDown}>
                <button
                  type="button"
                  className="ccc-approvals-back"
                  ref={backRef}
                  onClick={handleBack}
                >
                  {BACK_TO_REQUESTS}
                </button>
                <ApprovalDetail
                  proposalId={selected}
                  now={now}
                  connected={connected}
                  stale={stale}
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
                  focusOnLoad={focusFor === selected}
                  headingRef={paneHeadingRef}
                />
              </div>
            )}
          </div>
        ))}
      {!loading && !errored && (
        <WidgetFooter model={footerModel} panelTitle="approvals" now={now} dimmed={dimmed} />
      )}
    </section>
  );
}
