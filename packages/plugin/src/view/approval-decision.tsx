import type {
  DecideResponse,
  ApprovalDecision as DecisionKind,
  ProposalState,
} from "@ccc/domain/approval.js";
import type { ApprovalItemView } from "@ccc/domain/approval-view.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ApprovalDecideInput, ApprovalDetailResponse } from "../approvals/api.js";
import {
  APPROVAL_STATUS,
  APPROVE_LABEL,
  approvedNotice,
  approveName,
  DECISION_GROUP_LABEL,
  DENY_LABEL,
  DISABLED_REASONS,
  deniedNotice,
  denyName,
  denySummary,
  destructiveSublabel,
  OPEN_RUN_LABEL,
  openRunName,
  settledStatus,
} from "./approvals-copy.js";

/**
 * The decision group (UI-SPEC S2 "Decision group", "Focus rules"): Deny, then
 * Approve once, then a tertiary Open originating run. Props-driven: it imports
 * nothing from `obsidian`, the service client or the approval signals, and it
 * never reads the clock. The parent supplies the decide and refetch functions,
 * the two outcome callbacks, the connection and staleness flags and `now`.
 *
 * Safety properties kept here:
 * - A decision always carries the hash the pane displayed at the moment of the
 *   press, never one read later (T-06-03).
 * - Both decision buttons are busy and aria-disabled before any await, and a
 *   second press is ignored (UI-SPEC E5).
 * - A decide call that fails in transit is UNCONFIRMED: the service may have
 *   committed it before the response was lost, so the controls stay disabled
 *   while the request is fetched again, and only that fetched state is acted on.
 * - A disabled control is aria-disabled with a visible reason linked by
 *   aria-describedby, never natively disabled.
 */

/** What the group needs to know about the request it decides. */
export interface DecisionSubject {
  readonly proposalId: string;
  readonly title: string;
  readonly state: ProposalState;
  readonly revision: number;
  readonly expiresAt: string;
  readonly destructive: boolean;
  /** The engine-templated effect sentence, or null. */
  readonly effect: string | null;
  readonly run: { readonly runId: string; readonly name: string } | null;
}

export function subjectOfView(view: ApprovalItemView): DecisionSubject {
  return {
    proposalId: view.proposalId,
    title: view.title,
    state: view.state,
    revision: view.revision,
    expiresAt: view.expiresAt,
    destructive: view.destructive,
    effect: view.effect,
    run: view.run,
  };
}

/** The result of fetching the request again. */
export type RefetchResult =
  | { readonly kind: "ok"; readonly detail: ApprovalDetailResponse }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

/** What the pane is told after a decision settled. */
export type DecisionFollowUp =
  | {
      readonly kind: "refetched";
      readonly detail: ApprovalDetailResponse;
      /** True after a hash mismatch: the pane then holds Approve once until the fingerprint changed. */
      readonly mismatch: boolean;
      readonly focusHeading: boolean;
    }
  | { readonly kind: "patched"; readonly state: ProposalState; readonly focusHeading: boolean }
  | { readonly kind: "not-found" }
  | { readonly kind: "load-failed" };

// ---------------------------------------------------------------------------
// Availability

export interface AvailabilityInput {
  readonly nowMs: number;
  readonly expiresAt: string;
  readonly connected: boolean;
  readonly stale: boolean;
  /** The full request, and so its hash, has loaded. */
  readonly loaded: boolean;
  readonly reviewable: boolean;
  /** Approve once is held after a hash mismatch until the pane shows the new details. */
  readonly approveHold: boolean;
  /** A decision's outcome could not be confirmed. */
  readonly confirmFailed: boolean;
}

/** The visible reason each decision is withheld, or `null` when it is available. */
export interface DecisionAvailability {
  readonly approve: string | null;
  readonly deny: string | null;
}

/**
 * Deny is withheld only when the request has expired, the service is away, or a
 * decision could not be confirmed (denying is the safe direction). Approve once
 * additionally needs the full request, a fully shown change, a current list and
 * no hold from a changed fingerprint.
 */
export function decisionAvailability(input: AvailabilityInput): DecisionAvailability {
  const common = !input.connected
    ? DISABLED_REASONS.disconnected
    : Date.parse(input.expiresAt) <= input.nowMs
      ? DISABLED_REASONS.expired
      : input.confirmFailed
        ? APPROVAL_STATUS.confirmFailed
        : null;
  if (common !== null) return { approve: common, deny: common };
  const approve = !input.loaded
    ? DISABLED_REASONS.loading
    : input.approveHold
      ? APPROVAL_STATUS.hashMismatch
      : !input.reviewable
        ? DISABLED_REASONS.tooLarge
        : input.stale
          ? DISABLED_REASONS.stale
          : null;
  return { approve, deny: null };
}

// ---------------------------------------------------------------------------
// Open originating run

export interface OpenRunControlProps {
  readonly run: { readonly runId: string; readonly name: string } | null;
  readonly connected: boolean;
  readonly isRunLoaded?: ((runId: string) => boolean) | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
}

function runReason(props: OpenRunControlProps): string | null {
  if (!props.connected) return DISABLED_REASONS.disconnected;
  if (props.run === null) return DISABLED_REASONS.noRun;
  if (props.isRunLoaded !== undefined && !props.isRunLoaded(props.run.runId)) {
    return DISABLED_REASONS.runNotLoaded;
  }
  return null;
}

/** The tertiary control that selects the originating Run, with its visible reason when withheld. */
export function OpenRunControl(props: OpenRunControlProps): VNode {
  const reasonId = useId();
  const reason = runReason(props);
  const { run } = props;
  return (
    <div className="ccc-approval-control">
      <button
        type="button"
        className="ccc-list-more"
        data-action="open-run"
        aria-label={run === null ? OPEN_RUN_LABEL : openRunName(run.name)}
        aria-disabled={reason === null ? undefined : "true"}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => {
          if (reason !== null || run === null) return;
          props.onOpenRun?.(run.runId);
        }}
      >
        {OPEN_RUN_LABEL}
      </button>
      {reason !== null && (
        <p id={reasonId} className="ccc-list-meta">
          {reason}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The group

export interface ApprovalDecisionProps {
  readonly subject: DecisionSubject;
  /** The hash of the content the pane displayed, or `null` while the full request loads. */
  readonly shownHash: string | null;
  readonly reviewable: boolean;
  readonly nowMs: number;
  readonly connected: boolean;
  readonly stale: boolean;
  readonly approveHold: boolean;
  decide(input: ApprovalDecideInput): Promise<DecideResponse>;
  refetch(): Promise<RefetchResult>;
  /** Resolves with the hash once the full request has loaded, or `null` if it never will. */
  awaitHash?(): Promise<string | null>;
  announce(text: string): void;
  notify(text: string): void;
  onFollowUp(followUp: DecisionFollowUp): void;
  isRunLoaded?: ((runId: string) => boolean) | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  /** Receives the Deny button so the pane can focus it on arrival. */
  readonly denyRef?: { current: HTMLButtonElement | null } | undefined;
}

export function ApprovalDecision(props: ApprovalDecisionProps): VNode {
  const { subject } = props;
  const [busy, setBusy] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const summaryId = useId();
  const effectId = useId();
  const approveReasonId = useId();
  const denyReasonId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new revision or a new fingerprint is fresh information: a failed
  // confirmation no longer describes it.
  useEffect(() => {
    setConfirmFailed(false);
  }, [subject.revision, props.shownHash]);

  const availability = decisionAvailability({
    nowMs: props.nowMs,
    expiresAt: subject.expiresAt,
    connected: props.connected,
    stale: props.stale,
    loaded: props.shownHash !== null,
    reviewable: props.reviewable,
    approveHold: props.approveHold,
    confirmFailed,
  });

  /** Fetches the request again and tells the pane; a failed fetch falls back to a known state, if any. */
  async function followUp(
    mismatch: boolean,
    focusHeading: boolean,
    knownState: ProposalState | null,
  ): Promise<void> {
    const result = await props.refetch();
    if (!mounted.current) return;
    if (result.kind === "ok") {
      props.onFollowUp({ kind: "refetched", detail: result.detail, mismatch, focusHeading });
    } else if (result.kind === "not-found") {
      props.onFollowUp({ kind: "not-found" });
    } else if (knownState !== null) {
      props.onFollowUp({ kind: "patched", state: knownState, focusHeading });
    } else {
      props.onFollowUp({ kind: "load-failed" });
    }
  }

  /** The decision's response was lost: ask the service what actually happened, then act on that alone. */
  async function resolveUnconfirmed(): Promise<void> {
    props.announce(APPROVAL_STATUS.transport);
    props.notify(APPROVAL_STATUS.transport);
    const result = await props.refetch();
    if (result.kind === "ok") {
      const { detail } = result;
      const state = detail.view?.state ?? detail.summary.state;
      const title = detail.view?.title ?? detail.summary.title;
      const code = detail.view?.record.outcomeCode ?? detail.summary.outcomeCode;
      const settled = settledStatus(state, title, code);
      props.announce(settled.status);
      if (settled.notice !== null) props.notify(settled.notice);
      if (mounted.current) {
        props.onFollowUp({
          kind: "refetched",
          detail,
          mismatch: false,
          focusHeading: state !== "pending",
        });
      }
    } else if (result.kind === "not-found") {
      props.announce(APPROVAL_STATUS.notFound);
      if (mounted.current) props.onFollowUp({ kind: "not-found" });
    } else {
      setConfirmFailed(true);
      props.announce(APPROVAL_STATUS.confirmFailed);
    }
  }

  async function handleResponse(decision: DecisionKind, response: DecideResponse): Promise<void> {
    switch (response.outcome) {
      case "decided": {
        const approved = decision === "approve";
        props.announce(approved ? APPROVAL_STATUS.approved : APPROVAL_STATUS.denied);
        props.notify(approved ? approvedNotice(subject.title) : deniedNotice(subject.title));
        await followUp(false, true, response.approval.state);
        return;
      }
      case "hash-mismatch":
        props.announce(APPROVAL_STATUS.hashMismatch);
        props.notify(APPROVAL_STATUS.hashMismatch);
        await followUp(true, true, null);
        return;
      case "expired":
        props.announce(APPROVAL_STATUS.expiredDuringDecide);
        props.notify(APPROVAL_STATUS.expiredDuringDecide);
        await followUp(false, true, "expired");
        return;
      case "already-decided":
        props.announce(APPROVAL_STATUS.alreadyDecided);
        props.notify(APPROVAL_STATUS.alreadyDecided);
        await followUp(false, true, response.state);
        return;
      case "not-found":
        props.announce(APPROVAL_STATUS.notFound);
        return;
      case "operation-reserved":
        props.announce(APPROVAL_STATUS.reserved);
        return;
      default:
        await resolveUnconfirmed();
    }
  }

  async function run(decision: DecisionKind): Promise<void> {
    if (inFlight.current) return;
    // Everything up to the first await happens inside the press itself: the
    // guard, the busy state and the status line.
    inFlight.current = true;
    setBusy(true);
    props.announce(APPROVAL_STATUS.sending);
    const shown = props.shownHash;
    try {
      const hash = shown ?? (props.awaitHash === undefined ? null : await props.awaitHash());
      if (hash === null) {
        props.announce(APPROVAL_STATUS.loadFailed);
        return;
      }
      let response: DecideResponse;
      try {
        response = await props.decide({
          proposalId: subject.proposalId,
          decision,
          payloadHash: hash,
        });
      } catch {
        await resolveUnconfirmed();
        return;
      }
      await handleResponse(decision, response);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const denyDisabled = busy || availability.deny !== null;
  const approveDisabled = busy || availability.approve !== null;
  const showEffect = subject.destructive && subject.effect !== null;
  const approveDescribedBy =
    [showEffect ? effectId : null, availability.approve === null ? null : approveReasonId]
      .filter((id) => id !== null)
      .join(" ") || undefined;
  const denyDescribedBy = [summaryId, availability.deny === null ? null : denyReasonId]
    .filter((id) => id !== null)
    .join(" ");

  return (
    // biome-ignore lint/a11y/useSemanticElements: UI-SPEC S2 specifies `role="group"` with aria-label "Decision"; a <fieldset> is form-associated and brings native legend styling a row of pills does not want.
    <div className="ccc-approval-decision" role="group" aria-label={DECISION_GROUP_LABEL}>
      <span id={summaryId} className="ccc-visually-hidden">
        {denySummary(subject.title, props.nowMs, subject.expiresAt)}
      </span>
      <div className="ccc-approval-control">
        <button
          type="button"
          className="ccc-approval-button"
          data-decision="deny"
          ref={(element) => {
            if (props.denyRef !== undefined) props.denyRef.current = element;
          }}
          aria-label={denyName(subject.title)}
          aria-disabled={denyDisabled ? "true" : undefined}
          aria-busy={busy ? "true" : undefined}
          aria-describedby={denyDescribedBy}
          onClick={() => {
            if (denyDisabled) return;
            void run("deny");
          }}
        >
          {DENY_LABEL}
        </button>
        {availability.deny !== null && (
          <p id={denyReasonId} className="ccc-list-meta">
            {availability.deny}
          </p>
        )}
      </div>
      <div className="ccc-approval-control">
        <button
          type="button"
          className="ccc-approval-button"
          data-decision="approve"
          aria-label={approveName(subject.effect ?? subject.title)}
          aria-disabled={approveDisabled ? "true" : undefined}
          aria-busy={busy ? "true" : undefined}
          aria-describedby={approveDescribedBy}
          onClick={() => {
            if (approveDisabled) return;
            void run("approve");
          }}
        >
          {APPROVE_LABEL}
        </button>
        {showEffect && subject.effect !== null && (
          <p id={effectId} className="ccc-list-meta" data-role="effect">
            {destructiveSublabel(subject.effect)}
          </p>
        )}
        {availability.approve !== null && (
          <p id={approveReasonId} className="ccc-list-meta">
            {availability.approve}
          </p>
        )}
      </div>
      <OpenRunControl
        run={subject.run}
        connected={props.connected}
        isRunLoaded={props.isRunLoaded}
        onOpenRun={props.onOpenRun}
      />
    </div>
  );
}
