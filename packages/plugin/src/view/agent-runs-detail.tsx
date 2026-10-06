// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3, mirrored throughout this phase): the barrel's `export *` chain
// pulls in `path-containment.ts` (`node:fs`/`node:path`), which the visual
// harness's browser-platform bundle cannot resolve. This file additionally
// imports NOTHING from `@ccc/service-api-client` (Task 2 acceptance
// criteria): every consequential action is a descriptor through
// `onQuickAction`, and per-session usage arrives through the injected
// `loadSessionUsage` prop — never a client constructed here.
import {
  NOT_REPORTED,
  RUN_STATE_DISPLAY,
  type RunLinkKind,
  type SessionView,
  STALE_RUN_EXPLANATION,
  sessionDisplayName,
} from "@ccc/domain/session.js";
import type { SessionUsage } from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import { connectionState } from "../connection-state.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { formatDuration } from "../widgets/duration.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import {
  formatExactTokens,
  formatMonthDay,
  formatTimeOfDay,
  formatUsd,
} from "../widgets/usage-format.js";
import { lastUsageEventAt, usageSummary } from "../widgets/usage-signals.js";
import { selectedRunId } from "./agent-runs-state.js";
import { clearActionStatus, sessionActionStatus } from "./session-action-status.js";

/**
 * The detail pane (UI-SPEC S3 "Detail pane"): the session controls
 * availability matrix, the status line, the fields `<dl>`, and the
 * session's own token activity.
 */

// ---------------------------------------------------------------------------
// Session controls availability matrix (UI-SPEC "Interaction contract —
// session controls", D-01, D-35 as overridden by this plan's own Test 2, PR-26/27)
// ---------------------------------------------------------------------------

/** D-01, PR-26: force-terminate is always disabled with this reason until
 * the approval inbox exists. The approval phase flips this constant — no
 * code path here dispatches while it is false. */
export const APPROVAL_INBOX_READY = false;

const DISCONNECTED_REASON = "The companion service isn't running.";
/** The event stream has not reached `live` yet (first connect, or a
 * reconnect in progress): the service may well be running, so this never
 * claims it isn't (05 wave 4 review). */
const CONNECTING_REASON = "Connecting to the companion service…";
const APPROVAL_REASON = "Needs approval — available once the approval inbox is ready";

export interface SessionControl {
  readonly capability: string;
  readonly label: string;
  /** `null` means enabled. Never the native `disabled` attribute — a
   * disabled control stays focusable and its reason stays reachable
   * (UI-SPEC "Availability matrix"). */
  readonly disabledReason: string | null;
}

export interface ControlsContext {
  readonly connected: boolean;
  /** Only read while `connected` is false: `true` means the transport is
   * still connecting rather than disconnected, which picks
   * {@link CONNECTING_REASON} over {@link DISCONNECTED_REASON}. */
  readonly connecting?: boolean | undefined;
  readonly approvalInboxReady: boolean;
  /** `null` means unknown, which never disables (plan note). */
  readonly projectCount: number | null;
}

const LIVE_STATES: ReadonlySet<SessionView["state"]> = new Set([
  "starting",
  "running",
  "waiting-for-approval",
]);
const RESUMABLE_STATES: ReadonlySet<SessionView["state"]> = new Set([
  "stale",
  "completed",
  "failed",
  "cancelled",
]);
const INTERRUPTIBLE_STATES: ReadonlySet<SessionView["state"]> = new Set([
  "running",
  "waiting-for-approval",
]);

/** Not being connected is a universal blocker for every control — it takes
 * priority over any control-specific reason, including force-terminate's own
 * (Test 1: "When disconnected, every control has disabledReason
 * '{@link DISCONNECTED_REASON}'"); while still connecting the reason is
 * {@link CONNECTING_REASON} instead. */
function control(
  capability: string,
  label: string,
  ctx: ControlsContext,
  specificReason: string | null,
): SessionControl {
  const blocked = ctx.connecting === true ? CONNECTING_REASON : DISCONNECTED_REASON;
  return { capability, label, disabledReason: ctx.connected ? specificReason : blocked };
}

function focusTerminalControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (!LIVE_STATES.has(view.state)) return null;
  return control("session:focus", "Focus terminal", ctx, null);
}

function resumeControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (!RESUMABLE_STATES.has(view.state) || view.claudeSessionId === null) return null;
  if (!view.hasConversation) return null;
  const noTarget = view.projectId === null && view.cwdBasename === null;
  return control(
    "session:resume",
    "Resume",
    ctx,
    noTarget ? "Needs a registered project or its recorded folder" : null,
  );
}

function branchControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (view.claudeSessionId === null || !view.hasConversation) return null;
  return control("session:branch", "Branch", ctx, null);
}

function openTranscriptControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (!view.hasTranscript) return null;
  return control("session:open-transcript", "Open transcript", ctx, null);
}

/** Labelled "Focus to interrupt", never "Interrupt" alone (Test 2, PR-27). */
function interruptControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (!INTERRUPTIBLE_STATES.has(view.state)) return null;
  return control("session:interrupt", "Focus to interrupt", ctx, null);
}

function associateControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (view.projectId !== null) return null;
  return control(
    "session:associate",
    "Associate with project",
    ctx,
    ctx.projectCount === 0 ? "Register a project first" : null,
  );
}

/** Destructive, always last (UI-SPEC "Primary control first … destructive last"). */
function forceTerminateControl(view: SessionView, ctx: ControlsContext): SessionControl | null {
  if (!LIVE_STATES.has(view.state)) return null;
  return control(
    "session:terminate",
    "Force-terminate",
    ctx,
    ctx.approvalInboxReady ? null : APPROVAL_REASON,
  );
}

/**
 * The pure availability matrix (UI-SPEC "Interaction contract"). Fixed
 * order: whichever of Focus terminal/Resume applies is primary (the two
 * conditions never overlap), then Branch, Open transcript, Interrupt,
 * Associate, and Force-terminate always last.
 */
export function controlsFor(view: SessionView, ctx: ControlsContext): readonly SessionControl[] {
  return [
    focusTerminalControl(view, ctx),
    resumeControl(view, ctx),
    branchControl(view, ctx),
    openTranscriptControl(view, ctx),
    interruptControl(view, ctx),
    associateControl(view, ctx),
    forceTerminateControl(view, ctx),
  ].filter((c): c is SessionControl => c !== null);
}

// ---------------------------------------------------------------------------
// Fields dl (UI-SPEC "Detail pane" #4)
// ---------------------------------------------------------------------------

const PERMISSION_MODE_LABEL: Readonly<Record<string, string>> = {
  plan: "Plan (read-only)",
};

function permissionModeText(mode: string | null): string {
  if (mode === null) return NOT_REPORTED;
  return PERMISSION_MODE_LABEL[mode] ?? mode;
}

function lastErrorText(error: string): string {
  const words = error.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LINK_LABEL: Readonly<Record<RunLinkKind, string>> = {
  resume: "Resumed from",
  fork: "Branched from",
  clear: "Cleared from",
};

/** Shown instead of a name when the linked Run is outside the loaded
 * session history (pruned, or from before this history was kept). */
const UNLOADED_LINK_LABEL = "Earlier session";
const UNLOADED_LINK_REASON = "That session isn't in the loaded history.";

/**
 * The `Resumed from` / `Branched from` / `Cleared from` value (UI-SPEC S3
 * "Detail pane" #4: "a button that selects the linked Run"). Labelled by the
 * linked session's display name, never its raw RunId. A linked Run that is
 * not in the loaded session map would select nothing and empty the pane, so
 * it renders `aria-disabled` with its visible reason linked by
 * `aria-describedby` — never the native `disabled` attribute, which would
 * drop it from the tab order and hide the reason (UI-SPEC "Availability
 * matrix") (05 wave 4 review).
 */
function LinkedRunButton({ linkedRunId }: { readonly linkedRunId: string }): VNode {
  const reasonId = useId();
  const linked = sessionsById.value.get(linkedRunId);
  if (linked === undefined) {
    return (
      <>
        <button
          type="button"
          className="ccc-list-more"
          aria-disabled="true"
          aria-describedby={reasonId}
        >
          {UNLOADED_LINK_LABEL}
        </button>
        <p id={reasonId} className="ccc-list-meta">
          {UNLOADED_LINK_REASON}
        </p>
      </>
    );
  }
  return (
    <button
      type="button"
      className="ccc-list-more"
      onClick={() => {
        selectedRunId.value = linked.runId;
      }}
    >
      {sessionDisplayName(linked)}
    </button>
  );
}

/** `Mon D, h:mm AM` — mirrors `agent-runs.tsx`'s private `formatStarted`
 * (not exported there), duplicated here for the same reason
 * `active-sessions.tsx`'s `elapsedText` is duplicated rather than reaching
 * across the view/widget boundary. */
function formatStarted(iso: string, nowMs: number): string {
  return `${formatMonthDay(iso, nowMs)}, ${formatTimeOfDay(iso)}`;
}

function durationText(session: SessionView, nowMs: number): string {
  if (session.state === "stale") {
    const lastKnownMs = Date.parse(session.lastActivityAt ?? session.startedAt);
    const startedMs = Date.parse(session.startedAt);
    return `At least ${formatDuration(Math.max(0, lastKnownMs - startedMs))}`;
  }
  const endMs = session.endedAt !== null ? Date.parse(session.endedAt) : nowMs;
  return formatDuration(Math.max(0, endMs - Date.parse(session.startedAt)));
}

function Field({ term, value }: { readonly term: string; readonly value: VNode | string }): VNode {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

function DetailFields({
  session,
  nowMs,
}: {
  readonly session: SessionView;
  readonly nowMs: number;
}): VNode {
  const display = RUN_STATE_DISPLAY[session.state];
  const lastActivityIso = session.lastActivityAt ?? session.startedAt;

  return (
    <dl className="ccc-detail-fields">
      <Field term="Project" value={session.projectName ?? "Unclassified"} />
      <Field term="State" value={`${display.glyph} ${display.label}`} />
      <Field
        term="Activity"
        value={
          session.activity === null
            ? NOT_REPORTED
            : session.activity === "working"
              ? "Working"
              : "Idle"
        }
      />
      <Field term="Model" value={session.model ?? NOT_REPORTED} />
      <Field term="Effort" value={session.effort ?? NOT_REPORTED} />
      <Field
        term="Launch source"
        value={
          session.launchSource === null
            ? NOT_REPORTED
            : session.launchSource.charAt(0).toUpperCase() + session.launchSource.slice(1)
        }
      />
      <Field term="Started" value={formatStarted(session.startedAt, nowMs)} />
      <Field term="Duration" value={durationText(session, nowMs)} />
      <Field
        term="Last activity"
        value={`${formatRelativeTime(lastActivityIso, nowMs)} (${formatAbsoluteTime(lastActivityIso)})`}
      />
      <Field term="Permission mode" value={permissionModeText(session.permissionMode)} />
      <Field term="Claude Code version" value={session.claudeVersion ?? NOT_REPORTED} />
      <Field
        term="Subagents"
        value={`${session.subagents.active} active · last: ${session.subagents.lastType ?? NOT_REPORTED}`}
      />
      {session.lastError !== null && (
        <Field
          term="Last error"
          value={
            <span className="ccc-state-heading">
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>
              {lastErrorText(session.lastError)}
            </span>
          }
        />
      )}
      {session.linkKind !== null && session.linkedFromRunId !== null && (
        <Field
          term={LINK_LABEL[session.linkKind]}
          value={<LinkedRunButton linkedRunId={session.linkedFromRunId} />}
        />
      )}
      <Field term="Worktree" value={session.worktreeBasename ?? NOT_REPORTED} />
      <Field term="Folder" value={session.cwdBasename ?? NOT_REPORTED} />
      <Field
        term="Transcript"
        value={session.hasTranscript ? "Stored by Claude Code on this Mac" : NOT_REPORTED}
      />
      <Field
        term="Session ID"
        value={<span className="ccc-mono">{session.claudeSessionId ?? NOT_REPORTED}</span>}
      />
      <Field term="Run ID" value={<span className="ccc-mono">{session.runId}</span>} />
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Controls row (UI-SPEC "Detail pane" #2/#3)
// ---------------------------------------------------------------------------

function ControlsRow({
  session,
  connected,
  connecting,
  projectCount,
  onQuickAction,
}: {
  readonly session: SessionView;
  readonly connected: boolean;
  readonly connecting: boolean | undefined;
  readonly projectCount: number | null;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
}): VNode {
  const controls = controlsFor(session, {
    connected,
    connecting,
    approvalInboxReady: APPROVAL_INBOX_READY,
    projectCount,
  });
  const reasonBaseId = useId();
  const status = sessionActionStatus.value.get(session.runId);
  const pending = status?.kind === "pending";

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: matches UI-SPEC S3 "Detail pane" #2's own `role="group"` control row exactly — a `<fieldset>` is form-associated and brings unwanted native styling/legend semantics for a row of session-action pills. */}
      <div className="ccc-session-controls" role="group" aria-label="Session controls">
        {controls.map((c) => {
          const disabled = c.disabledReason !== null || pending;
          const reasonId = `${reasonBaseId}-${c.capability}`;
          return (
            <div className="ccc-session-control" key={c.capability}>
              <button
                type="button"
                className="ccc-quick-action"
                data-capability={c.capability}
                aria-disabled={disabled ? "true" : undefined}
                aria-busy={pending ? "true" : undefined}
                aria-describedby={c.disabledReason !== null ? reasonId : undefined}
                onClick={() => {
                  if (disabled) return;
                  onQuickAction?.({
                    id: `${c.capability}-${session.runId}`,
                    label: c.label,
                    capability: c.capability,
                    target: { runId: session.runId },
                  });
                }}
              >
                {c.label}
              </button>
              {c.disabledReason !== null && (
                <p id={reasonId} className="ccc-list-meta">
                  {c.disabledReason}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p role="status" className="ccc-list-meta">
        {status?.text ?? ""}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-session token activity (UI-SPEC "Detail pane" #5)
// ---------------------------------------------------------------------------

const ENABLE_ANALYSIS_DESCRIPTOR: QuickActionDescriptor = {
  id: "usage-enable-transcript-analysis",
  label: "Turn on transcript analysis",
  capability: "usage:enable-transcript-analysis",
};

type UsageLoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly usage: SessionUsage }
  | { readonly kind: "failed" };

function PerSessionUsage({
  runId,
  loadSessionUsage,
  onQuickAction,
}: {
  readonly runId: string;
  readonly loadSessionUsage: ((runId: string) => Promise<SessionUsage>) | undefined;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
}): VNode | null {
  const [state, setState] = useState<UsageLoadState>({ kind: "idle" });
  // Refetch triggers (codex finding 5): analysis toggled, usage updated or
  // deleted, or the stream becoming live again. Reading `.value` in render
  // also subscribes this component to each signal.
  const analysisKey = claudeIntegration.value;
  const summaryKey = usageSummary.value;
  const usageEventKey = lastUsageEventAt.value;
  const liveKey = connectionState.value.kind === "live";

  useEffect(() => {
    if (loadSessionUsage === undefined) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    loadSessionUsage(runId).then(
      (usage) => {
        if (!cancelled) setState({ kind: "loaded", usage });
      },
      () => {
        if (!cancelled) setState({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, loadSessionUsage, analysisKey, summaryKey, usageEventKey, liveKey]);

  if (loadSessionUsage === undefined || state.kind === "idle") return null;
  if (state.kind === "loading") {
    return <p className="ccc-list-meta">Loading this session's usage…</p>;
  }
  if (state.kind === "failed") {
    return <p className="ccc-list-meta">Couldn't load this session's usage.</p>;
  }

  const { activity, cost } = state.usage;
  if (activity.kind === "unavailable" && activity.reason === "analysis-off") {
    return (
      <>
        <p className="ccc-state-body">Transcript analysis is off</p>
        <button
          type="button"
          className="ccc-quick-action"
          onClick={() => onQuickAction?.(ENABLE_ANALYSIS_DESCRIPTOR)}
        >
          {ENABLE_ANALYSIS_DESCRIPTOR.label}
        </button>
      </>
    );
  }
  if (activity.kind === "unavailable") {
    return <p className="ccc-state-body">Token activity unavailable</p>;
  }

  const { totals } = activity;
  const costText =
    cost.kind === "available" ? formatUsd(cost.usd) : "Estimated API-equivalent cost unavailable";
  return (
    <>
      <p className="ccc-list-meta">
        {`Input ${formatExactTokens(totals.input)} · output ${formatExactTokens(
          totals.output,
        )} · cache write ${formatExactTokens(totals.cacheWrite)} · cache read ${formatExactTokens(
          totals.cacheRead,
        )}`}
      </p>
      <p className="ccc-state-body">{`Estimated API-equivalent cost — an estimate, not your bill: ${costText}`}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export interface DetailPaneProps {
  readonly session: SessionView;
  readonly nowMs: number;
  readonly connected: boolean;
  /** The transport is still connecting (not disconnected) — see
   * {@link ControlsContext.connecting}. */
  readonly connecting?: boolean | undefined;
  readonly projectCount: number | null;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly loadSessionUsage: ((runId: string) => Promise<SessionUsage>) | undefined;
  readonly headingRef: { current: HTMLHeadingElement | null };
}

export function DetailPane({
  session,
  nowMs,
  connected,
  connecting,
  projectCount,
  onQuickAction,
  loadSessionUsage,
  headingRef,
}: DetailPaneProps): VNode {
  const display = RUN_STATE_DISPLAY[session.state];

  // A Run leaving this detail pane (a new selection, or a status outcome
  // fully shown) clears its own status line rather than leaking a stale
  // pending/outcome text onto the next selected Run.
  useEffect(() => () => clearActionStatus(session.runId), [session.runId]);

  return (
    <div className="ccc-detail-pane">
      <h3
        ref={(el) => {
          headingRef.current = el;
        }}
        tabIndex={-1}
      >
        {sessionDisplayName(session)}
      </h3>
      <p className="ccc-state-body">
        {display.glyph} {display.label}
      </p>
      {session.state === "stale" && <p className="ccc-list-meta">{STALE_RUN_EXPLANATION}</p>}
      <ControlsRow
        session={session}
        connected={connected}
        connecting={connecting}
        projectCount={projectCount}
        onQuickAction={onQuickAction}
      />
      <DetailFields session={session} nowMs={nowMs} />
      <PerSessionUsage
        runId={session.runId}
        loadSessionUsage={loadSessionUsage}
        onQuickAction={onQuickAction}
      />
    </div>
  );
}
