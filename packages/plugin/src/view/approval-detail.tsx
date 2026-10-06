import type { ApprovalSummary, DecideResponse } from "@ccc/domain/approval.js";
import {
  APPROVAL_HISTORY_MAX,
  APPROVAL_STATE_DISPLAY,
  type ApprovalFilter,
  type ApprovalItemView,
} from "@ccc/domain/approval-view.js";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ApprovalDecideInput, ApprovalDetailResponse } from "../approvals/api.js";
import {
  ApprovalDecision,
  type DecisionFollowUp,
  type DecisionSubject,
  OpenRunControl,
  type RefetchResult,
  subjectOfView,
} from "./approval-decision.js";
import { ApprovalDiff, changeExceedsCaps } from "./approval-diff.js";
import { UntrustedText } from "./approval-text.js";
import {
  BLOCK_HEADING,
  COMPUTED_CAPTION,
  DECIDED_THROUGH,
  DETAILS_CHANGED,
  DISABLED_REASONS,
  expiryParts,
  formatApprovalTime,
  HISTORY_LABEL,
  LOAD_ERROR_BODY,
  LOAD_ERROR_HEADING,
  LOADING_LABEL,
  listedUnder,
  NO_PROJECT,
  NO_RISKS,
  NOT_FOUND_BODY,
  NOT_FOUND_HEADING,
  NOT_IN_A_RUN,
  NOT_PROVIDED,
  PURGED_BODY,
  REQUESTER_KIND_LABEL,
  requestedByText,
  SHOW_FULL_TEXT,
  SHOW_SHORTER_TEXT,
  showFilter,
  stateExplanation,
  TERM,
  TEXT_SHORTENED,
  TOO_LARGE,
} from "./approvals-copy.js";

/**
 * The approval request detail pane (UI-SPEC S2): the service-built view model
 * in the fixed block order, every APPR-03 field, and the decision group.
 *
 * Props-driven. It imports nothing from `obsidian`, the service client or the
 * approval signals module, never reads the clock (`now` is a prop), and never
 * parses a payload (D-24). Every requester-derived string reaches the DOM as a
 * Preact text child through {@link UntrustedText}.
 */

export interface ApprovalDetailProps {
  readonly proposalId: string;
  /** The clock, in epoch milliseconds. Views never read the ambient clock. */
  readonly now: number;
  readonly connected: boolean;
  /** The list this request came from may be out of date. */
  readonly stale: boolean;
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  decide(input: ApprovalDecideInput): Promise<DecideResponse>;
  /** Posts a line to the section's polite status region. */
  announce(text: string): void;
  /** Posts an Obsidian Notice. */
  notify(text: string): void;
  /** The list's own revision of this request; a change makes the pane fetch it again. */
  readonly revision?: number | undefined;
  readonly isRunLoaded?: ((runId: string) => boolean) | undefined;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
  /**
   * Move focus on arrival: Deny for a destructive pending request, the heading
   * for anything else. Defaults to true; a parent that must not take focus (a
   * plain tab switch with a leftover selection) passes false.
   */
  readonly focusOnLoad?: boolean | undefined;
  readonly headingRef?: { current: HTMLHeadingElement | null } | undefined;
  /** What the list already knows of this request; shown while the full request loads. */
  readonly summary?: ApprovalSummary | undefined;
  /** The chip the list is on. A request listed under another chip says so, and never switches it. */
  readonly activeFilter?: ApprovalFilter | undefined;
  readonly onShowFilter?: ((filter: ApprovalFilter) => void) | undefined;
}

type PaneState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly detail: ApprovalDetailResponse }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

/** The closed error code a failed `get` carries, or `null`. Duck-typed: this file imports no error class. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Blocks

function Caption({ view, origin }: { readonly view: ApprovalItemView; readonly origin: string }) {
  return (
    <p className="ccc-approval-caption" data-caption="">
      {origin === "requester" ? (
        <>
          {`Provided by ${REQUESTER_KIND_LABEL[view.requester.kind]}: `}
          <UntrustedText text={view.requester.label} />
        </>
      ) : (
        COMPUTED_CAPTION
      )}
    </p>
  );
}

function Block({
  name,
  heading,
  origin,
  view,
  children,
}: {
  readonly name: string;
  readonly heading: string | null;
  readonly origin: "engine" | "requester" | null;
  readonly view: ApprovalItemView;
  readonly children: ComponentChildren;
}): VNode {
  return (
    <div className="ccc-approval-block" data-block={name} data-origin={origin ?? undefined}>
      {heading !== null && <h5 className="ccc-approval-block-heading">{heading}</h5>}
      {origin !== null && <Caption view={view} origin={origin} />}
      {children}
    </div>
  );
}

function Field({
  term,
  value,
  mono,
  title,
}: {
  readonly term: string;
  readonly value: ComponentChildren;
  readonly mono?: boolean;
  readonly title?: string;
}): VNode {
  return (
    <>
      <dt>{term}</dt>
      <dd
        className={mono === true ? "ccc-mono ccc-approval-value" : "ccc-approval-value"}
        title={title}
      >
        {value}
      </dd>
    </>
  );
}

/** The Run row's button: selects the Run, or says why it cannot. */
function RunButton({
  run,
  connected,
  isRunLoaded,
  onOpenRun,
}: {
  readonly run: { readonly runId: string; readonly name: string };
  readonly connected: boolean;
  readonly isRunLoaded: ((runId: string) => boolean) | undefined;
  readonly onOpenRun: ((runId: string) => void) | undefined;
}): VNode {
  const reasonId = useId();
  const reason = !connected
    ? DISABLED_REASONS.disconnected
    : isRunLoaded !== undefined && !isRunLoaded(run.runId)
      ? DISABLED_REASONS.runNotLoaded
      : null;
  return (
    <>
      <button
        type="button"
        className="ccc-list-more"
        aria-disabled={reason === null ? undefined : "true"}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => {
          if (reason === null) onOpenRun?.(run.runId);
        }}
      >
        <UntrustedText text={run.name} />
      </button>
      {reason !== null && (
        <p id={reasonId} className="ccc-list-meta">
          {reason}
        </p>
      )}
    </>
  );
}

/** The reason: shown text, a line when it was shortened, and a toggle to the larger cap. */
function ReasonText({ reason }: { readonly reason: ApprovalItemView["reason"] }): VNode {
  const [expanded, setExpanded] = useState(false);
  const hasMore = reason.full !== reason.shown;
  const text = expanded ? reason.full : reason.shown;
  const shortened = (hasMore && !expanded) || reason.shortened;
  return (
    <>
      <p className="ccc-approval-reason">
        {text === "" ? NOT_PROVIDED : <UntrustedText text={text} />}
      </p>
      {shortened && <p className="ccc-list-meta">{TEXT_SHORTENED}</p>}
      {hasMore && (
        <button
          type="button"
          className="ccc-list-more"
          aria-expanded={expanded ? "true" : "false"}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? SHOW_SHORTER_TEXT : SHOW_FULL_TEXT}
        </button>
      )}
    </>
  );
}

function executedAtOf(view: ApprovalItemView): string | null {
  for (let i = view.history.length - 1; i >= 0; i -= 1) {
    const entry = view.history[i];
    if (
      entry !== undefined &&
      (entry.event === "executed" || entry.event === "reconciled-executed")
    ) {
      return entry.at;
    }
  }
  return null;
}

function StateBlock({
  view,
  now,
  children,
}: {
  readonly view: ApprovalItemView;
  readonly now: number;
  readonly children?: ComponentChildren;
}): VNode {
  const display = APPROVAL_STATE_DISPLAY[view.state];
  const lines = stateExplanation({
    state: view.state,
    nowMs: now,
    expiresAt: view.expiresAt,
    requestedAt: view.record.requestedAt,
    decidedAt: view.record.decidedAt,
    executedAt: executedAtOf(view),
    outcomeCode: view.record.outcomeCode,
    checkHint: view.checkHint,
    awaitingExit: view.record.outcomeNote === "awaiting-exit",
  });
  const expiry = view.state === "pending" ? expiryParts(now, view.expiresAt) : null;
  return (
    <div className="ccc-approval-state" data-block="state" data-state={view.state}>
      <p className="ccc-approval-state-line">
        <span className="ccc-approval-glyph" aria-hidden="true">
          {display.glyph}
        </span>{" "}
        <span className="ccc-approval-state-label">{display.label}</span>
      </p>
      {children}
      {expiry !== null && expiry.kind === "counting" ? (
        <p className="ccc-approval-explanation">
          <span className="ccc-approval-time" data-urgent={expiry.urgent ? "true" : undefined}>
            {expiry.phrase}
          </span>
          {expiry.suffix}
        </p>
      ) : (
        lines.map((line) => (
          <p className="ccc-approval-explanation" key={line}>
            {line}
          </p>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pane

/** The h4 every form of the pane shares, so focus has one place to land. */
function PaneHeading({
  id,
  headingRef,
  children,
}: {
  readonly id: string;
  readonly headingRef: { current: HTMLHeadingElement | null };
  readonly children: ComponentChildren;
}): VNode {
  return (
    <h4
      id={id}
      tabIndex={-1}
      ref={(element) => {
        headingRef.current = element;
      }}
      data-block="heading"
    >
      {children}
    </h4>
  );
}

function Skeleton(): VNode {
  return (
    <div className="ccc-approval-skeleton" aria-hidden="true">
      <div className="ccc-skeleton-line" />
      <div className="ccc-skeleton-line" />
      <div className="ccc-skeleton-line" />
    </div>
  );
}

/** What the loading form needs of the request: only what the list already knew. */
function subjectOfSummary(summary: ApprovalSummary): DecisionSubject {
  return {
    proposalId: summary.proposalId,
    title: summary.title,
    state: summary.state,
    revision: summary.revision,
    expiresAt: summary.expiresAt,
    destructive: false,
    effect: null,
    run: null,
  };
}

export function ApprovalDetail(props: ApprovalDetailProps): VNode | null {
  const [pane, setPane] = useState<PaneState>({ kind: "loading" });
  const [focusToken, setFocusToken] = useState(0);
  /** Shown from a hash mismatch until the pane closes. */
  const [changedLine, setChangedLine] = useState(false);
  /** The hash that was displayed when a mismatch was reported; Approve once waits for a different one. */
  const [mismatchHash, setMismatchHash] = useState<string | null>(null);
  const localHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const headingRef = props.headingRef ?? localHeadingRef;
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const loadRef = useRef<Promise<RefetchResult>>(Promise.resolve({ kind: "error" }));
  const focusedFor = useRef<string | null>(null);
  const lastRevision = useRef(props.revision);
  /** Monotonic: only the fetch started last may change the pane, whatever order answers arrive in. */
  const fetchSeq = useRef(0);
  const headingId = useId();

  /** Fetches one request. The id is fixed at the call, so a late answer can never describe another request. */
  function fetchDetail(id: string): Promise<RefetchResult> {
    return Promise.resolve()
      .then(() => latest.current.get(id))
      .then(
        (detail): RefetchResult => ({ kind: "ok", detail }),
        (error: unknown): RefetchResult => ({
          kind: errorCode(error) === "not-found" ? "not-found" : "error",
        }),
      );
  }

  // Load on selection. A different request starts from the skeleton again.
  useEffect(() => {
    const id = props.proposalId;
    let cancelled = false;
    setPane({ kind: "loading" });
    setChangedLine(false);
    setMismatchHash(null);
    focusedFor.current = null;
    const seq = ++fetchSeq.current;
    const load = fetchDetail(id);
    loadRef.current = load;
    void load.then((result) => {
      if (cancelled || seq !== fetchSeq.current) return;
      if (result.kind === "ok") setPane({ kind: "ready", detail: result.detail });
      else setPane({ kind: result.kind });
    });
    return () => {
      cancelled = true;
    };
  }, [props.proposalId]);

  // The list saw a newer revision of this request: fetch it again, keeping the last good view meanwhile.
  useEffect(() => {
    if (lastRevision.current === props.revision) return;
    lastRevision.current = props.revision;
    const id = props.proposalId;
    const seq = ++fetchSeq.current;
    void fetchDetail(id).then((result) => {
      if (latest.current.proposalId !== id || seq !== fetchSeq.current) return;
      if (result.kind === "ok") setPane({ kind: "ready", detail: result.detail });
      else if (result.kind === "not-found") setPane({ kind: "not-found" });
      else if (paneRef.current.kind === "loading") setPane({ kind: "error" });
    });
  }, [props.revision]);

  // Focus on arrival: Deny for a destructive pending request, otherwise the heading.
  useEffect(() => {
    if (pane.kind !== "ready" && pane.kind !== "not-found") return;
    if (focusedFor.current === props.proposalId) return;
    focusedFor.current = props.proposalId;
    if (props.focusOnLoad === false) return;
    const heading = headingRef.current;
    if (heading !== null && typeof heading.scrollIntoView === "function") {
      heading.scrollIntoView({ block: "nearest" });
    }
    const view = pane.kind === "ready" ? pane.detail.view : null;
    if (view !== null && view.state === "pending" && view.destructive && denyRef.current !== null) {
      denyRef.current.focus({ preventScroll: true });
    } else {
      heading?.focus();
    }
  }, [pane, props.proposalId, props.focusOnLoad, headingRef]);

  // After a decision the new state is read from the heading.
  useEffect(() => {
    if (focusToken === 0) return;
    headingRef.current?.focus();
  }, [focusToken, headingRef]);

  /** Applies what a settled decision learned, unless the pane has moved on to another request. */
  function handleFollowUp(id: string, followUp: DecisionFollowUp): void {
    if (latest.current.proposalId !== id) return;
    switch (followUp.kind) {
      case "refetched": {
        if (followUp.mismatch) {
          const current = paneRef.current;
          const shown =
            current.kind === "ready" ? (current.detail.view?.record.payloadHash ?? null) : null;
          setMismatchHash(shown);
          setChangedLine(true);
        }
        setPane({ kind: "ready", detail: followUp.detail });
        if (followUp.focusHeading) setFocusToken((token) => token + 1);
        return;
      }
      case "patched": {
        const current = paneRef.current;
        if (current.kind === "ready") {
          const { detail } = current;
          setPane({
            kind: "ready",
            detail: {
              ...detail,
              summary: { ...detail.summary, state: followUp.state },
              view: detail.view === null ? null : { ...detail.view, state: followUp.state },
            },
          });
        }
        if (followUp.focusHeading) setFocusToken((token) => token + 1);
        return;
      }
      case "not-found":
        setPane({ kind: "not-found" });
        return;
      case "load-failed":
        setPane({ kind: "error" });
        return;
    }
  }

  const id = props.proposalId;
  const dimmed = props.connected ? undefined : "true";

  /** The decision group, bound to this request: its calls and its follow-up cannot reach another one. */
  function decisionGroup(
    subject: DecisionSubject,
    shownHash: string | null,
    reviewable: boolean,
    approveHold: boolean,
    omitOpenRun: boolean,
  ): VNode {
    return (
      <ApprovalDecision
        key={subject.proposalId}
        subject={subject}
        shownHash={shownHash}
        reviewable={reviewable}
        nowMs={props.now}
        connected={props.connected}
        stale={props.stale}
        approveHold={approveHold}
        omitOpenRun={omitOpenRun}
        decide={(input) => props.decide(input)}
        refetch={() => fetchDetail(id)}
        awaitHash={() =>
          loadRef.current.then((result) =>
            result.kind === "ok" && result.detail.view?.state === "pending"
              ? result.detail.view.record.payloadHash
              : null,
          )
        }
        announce={(text) => props.announce(text)}
        notify={(text) => props.notify(text)}
        onFollowUp={(followUp) => handleFollowUp(id, followUp)}
        isRunLoaded={props.isRunLoaded}
        onOpenRun={props.onOpenRun}
        denyRef={denyRef}
      />
    );
  }

  if (pane.kind === "loading") {
    const { summary } = props;
    return (
      <section
        className="ccc-approval-detail"
        aria-busy="true"
        aria-labelledby={headingId}
        data-dimmed={dimmed}
      >
        <PaneHeading id={headingId} headingRef={headingRef}>
          {summary === undefined ? LOADING_LABEL : <UntrustedText text={summary.title} />}
        </PaneHeading>
        {summary !== undefined && <p className="ccc-visually-hidden">{LOADING_LABEL}</p>}
        <Skeleton />
        {summary !== undefined && summary.state === "pending" && (
          <div className="ccc-approval-block" data-block="decision">
            {decisionGroup(subjectOfSummary(summary), null, true, false, true)}
          </div>
        )}
      </section>
    );
  }

  if (pane.kind === "not-found") {
    return (
      <section className="ccc-approval-detail" aria-labelledby={headingId} data-dimmed={dimmed}>
        <PaneHeading id={headingId} headingRef={headingRef}>
          {NOT_FOUND_HEADING}
        </PaneHeading>
        <p className="ccc-approval-explanation">{NOT_FOUND_BODY}</p>
      </section>
    );
  }

  const loadError = (
    <section className="ccc-approval-detail" aria-labelledby={headingId} data-dimmed={dimmed}>
      <PaneHeading id={headingId} headingRef={headingRef}>
        <span className="ccc-error-glyph" aria-hidden="true">
          {"\u25b2"}
        </span>
        {LOAD_ERROR_HEADING}
      </PaneHeading>
      <p className="ccc-approval-explanation">{LOAD_ERROR_BODY}</p>
    </section>
  );
  if (pane.kind === "error") return loadError;

  const { detail } = pane;
  const view = detail.view;
  if (view === null) {
    // A request whose details were purged can only be read, never decided.
    if (detail.summary.state === "pending") return loadError;
    const display = APPROVAL_STATE_DISPLAY[detail.summary.state];
    return (
      <section
        className="ccc-approval-detail"
        aria-labelledby={headingId}
        data-state={detail.summary.state}
        data-dimmed={dimmed}
      >
        <PaneHeading id={headingId} headingRef={headingRef}>
          <UntrustedText text={detail.summary.title} />
        </PaneHeading>
        <div className="ccc-approval-state" data-block="state" data-state={detail.summary.state}>
          <p className="ccc-approval-state-line">
            <span className="ccc-approval-glyph" aria-hidden="true">
              {display.glyph}
            </span>{" "}
            <span className="ccc-approval-state-label">{display.label}</span>
          </p>
          <p className="ccc-approval-explanation">{PURGED_BODY}</p>
        </div>
      </section>
    );
  }

  const requester = view.requester;
  const run = view.run;
  const tooLarge = !view.reviewable || changeExceedsCaps(view.change);
  const approveHold = mismatchHash !== null && view.record.payloadHash === mismatchHash;
  const requestFilter = APPROVAL_STATE_DISPLAY[view.state].filter;
  const relocated = props.activeFilter !== undefined && props.activeFilter !== requestFilter;

  return (
    <section
      className="ccc-approval-detail"
      aria-labelledby={headingId}
      data-state={view.state}
      data-dimmed={dimmed}
    >
      <PaneHeading id={headingId} headingRef={headingRef}>
        <UntrustedText text={view.title} />
      </PaneHeading>
      <StateBlock view={view} now={props.now}>
        {relocated && (
          <p className="ccc-approval-relocated">
            {listedUnder(requestFilter)}{" "}
            <button
              type="button"
              className="ccc-list-more"
              onClick={() => props.onShowFilter?.(requestFilter)}
            >
              {showFilter(requestFilter)}
            </button>
          </p>
        )}
        {changedLine && <p className="ccc-approval-changed">{DETAILS_CHANGED}</p>}
      </StateBlock>
      <Block name="who" heading={BLOCK_HEADING.who} origin={null} view={view}>
        <dl className="ccc-detail-fields">
          <Field
            term={TERM.requestedBy}
            value={<UntrustedText text={requestedByText(requester.kind, requester.label)} />}
            title={requestedByText(requester.kind, requester.label)}
          />
          <Field
            term={TERM.project}
            value={view.project === null ? NO_PROJECT : <UntrustedText text={view.project} />}
          />
          <Field
            term={TERM.run}
            value={
              run === null ? (
                NOT_IN_A_RUN
              ) : (
                <RunButton
                  run={run}
                  connected={props.connected}
                  isRunLoaded={props.isRunLoaded}
                  onOpenRun={props.onOpenRun}
                />
              )
            }
          />
        </dl>
      </Block>
      <Block name="happen" heading={BLOCK_HEADING.happen} origin="engine" view={view}>
        <p>
          <UntrustedText text={view.action} />
        </p>
      </Block>
      <Block name="target" heading={BLOCK_HEADING.target} origin="engine" view={view}>
        {view.target.length === 0 ? (
          <p>{NOT_PROVIDED}</p>
        ) : (
          <dl className="ccc-detail-fields">
            {view.target.map((row) => (
              <Field
                key={`${row.label}-${row.value}`}
                term={row.label}
                value={<UntrustedText text={row.value} />}
                mono={row.mono}
                title={row.value}
              />
            ))}
          </dl>
        )}
      </Block>
      <Block name="change" heading={BLOCK_HEADING.change} origin={view.change.origin} view={view}>
        {tooLarge && <p className="ccc-approval-too-large">{TOO_LARGE}</p>}
        <ApprovalDiff change={view.change} />
      </Block>
      <Block name="reason" heading={BLOCK_HEADING.reason} origin="requester" view={view}>
        <ReasonText reason={view.reason} />
      </Block>
      <Block name="risks" heading={BLOCK_HEADING.risks} origin="engine" view={view}>
        {view.risks.length === 0 ? (
          <p>{NO_RISKS}</p>
        ) : (
          <ul className="ccc-approval-risks">
            {view.risks.map((risk) => (
              <li key={risk}>
                <UntrustedText text={risk} />
              </li>
            ))}
          </ul>
        )}
      </Block>
      {view.state === "pending" ? (
        <div className="ccc-approval-block" data-block="decision">
          {decisionGroup(
            subjectOfView(view),
            detail.payloadHash === view.record.payloadHash ? view.record.payloadHash : null,
            !tooLarge,
            approveHold,
            false,
          )}
        </div>
      ) : (
        <div className="ccc-approval-block" data-block="actions">
          <OpenRunControl
            run={view.run}
            connected={props.connected}
            isRunLoaded={props.isRunLoaded}
            onOpenRun={props.onOpenRun}
          />
        </div>
      )}
      <Block name="record" heading={BLOCK_HEADING.record} origin={null} view={view}>
        <dl className="ccc-detail-fields">
          <Field
            term={TERM.requested}
            value={formatApprovalTime(view.record.requestedAt, props.now)}
          />
          <Field term={TERM.requestId} value={view.proposalId} mono />
          <Field term={TERM.fingerprint} value={view.record.fingerprint} mono />
          {view.record.decidedVia !== null && (
            <Field
              term={TERM.decidedThrough}
              value={
                <span data-channel={view.record.decidedVia}>
                  {DECIDED_THROUGH[view.record.decidedVia]}
                </span>
              }
            />
          )}
        </dl>
      </Block>
      <Block name="history" heading={BLOCK_HEADING.history} origin={null} view={view}>
        <ol className="ccc-approval-history">
          {view.history.slice(0, APPROVAL_HISTORY_MAX).map((entry, index) => (
            <li key={`${index}-${entry.event}`}>
              {HISTORY_LABEL[entry.event]}{" "}
              <span className="ccc-list-meta">{formatApprovalTime(entry.at, props.now)}</span>
            </li>
          ))}
        </ol>
      </Block>
    </section>
  );
}
