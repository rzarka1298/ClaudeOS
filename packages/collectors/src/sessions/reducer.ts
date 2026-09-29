import {
  type LaunchSource,
  type MinimalHookRecord,
  type RunId,
  type RunLinkKind,
  type RunState,
  SESSION_END_REASONS,
  type SessionEndReason,
  type SessionRun,
} from "@ccc/domain";

/**
 * The session-state reducer (D-17): one pure function that turns hook,
 * liveness, launch and terminate evidence into SessionRun upserts plus a
 * list of rejected edges. It performs no I/O, reads no clock (time arrives
 * as `now`), and never mints an ID itself (new RunIds come from the
 * injected `mintRunId`, ADR-0006). The service runs it and owns every side
 * effect, including logging `rejected` through the redacting logger.
 *
 * The rules it keeps, in the words of the locked decisions:
 *
 * - Nothing is ever inferred complete (SESS-06, D-19). `completed` is
 *   written only by an explicit ending: a SessionEnd, or a `/clear`
 *   SessionStart ending the old Run on the same process (D-21), proven by
 *   equal known process start times. `failed` is
 *   written only by launch-failed. A process that vanished without either
 *   becomes `stale` — the absence of evidence, never an invented ending.
 * - Stale is not final (D-20). Any later hook event or a live identity-checked
 *   PID revives it to `running`, and a late SessionEnd completes it.
 * - `completed`, `failed` and `cancelled` are final. Evidence against them is
 *   returned as a rejected edge naming the from-state and the evidence; it
 *   is never applied and never thrown.
 * - A pending terminate turns SessionEnd into an observation, not an ending
 *   (PR-02). SIGTERM/SIGHUP run SessionEnd(reason "other"); while a Run
 *   carries `terminateRequestedAt`, that SessionEnd only records
 *   `endObservedAt`, and the later pid-gone makes the Run `cancelled`.
 * - A missing optional field leaves the previous value unchanged. No
 *   placeholder is ever written for a value the source did not send (D-12).
 *
 * Every switch below is exhaustive with NO `default:` branch — TypeScript
 * exhaustiveness is the guard (the `presentation.ts` convention), so a new
 * evidence kind or hook event cannot be silently ignored.
 */

/** A hook record that classified `known` (already schema-validated and stripped by the service). */
export type KnownHookRecord = MinimalHookRecord;

/**
 * What the service resolved about the process and project behind a hook
 * record. `null` means unknown and never overwrites a known value.
 * `transcriptPath` is already containment-checked (PR-28).
 */
export interface SessionFacts {
  readonly pidStartedAt: string | null;
  readonly launchSource: LaunchSource | null;
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
  readonly transcriptPath: string | null;
}

export type Evidence =
  | { readonly kind: "hook"; readonly record: KnownHookRecord; readonly facts: SessionFacts }
  | {
      readonly kind: "pid-gone" | "pid-alive" | "start-timeout" | "inactivity-timeout";
      readonly runId: RunId;
      readonly observedAt: string;
    }
  | {
      readonly kind: "launch-registered";
      readonly runId: RunId;
      readonly claudeSessionId: string | null;
      readonly linkKind: RunLinkKind | null;
      readonly linkedFromRunId: RunId | null;
      readonly cwd: string;
      readonly at: string;
    }
  | {
      readonly kind: "launch-started" | "launch-failed";
      readonly runId: RunId;
      readonly at: string;
    }
  | { readonly kind: "terminate-requested"; readonly runId: RunId; readonly at: string };

/** Read-only access to the Runs the service holds. The service implements it over the store. */
export interface RunIndex {
  byRunId(runId: RunId): SessionRun | null;
  /** The latest Run attached to exactly this (session, pid); `pid` null for a PID-less Run. */
  byIdentity(claudeSessionId: string, pid: number | null): SessionRun | null;
  /** The latest Run of this Claude session, in any state. */
  latestBySession(claudeSessionId: string): SessionRun | null;
  /** The latest non-terminal Run attached to this pid. */
  liveByPid(pid: number): SessionRun | null;
  /** The latest Run attached to this pid, in any state (links a `/clear` after its SessionEnd). */
  latestByPid(pid: number): SessionRun | null;
}

export type RejectedReason =
  /** The Run is completed, failed or cancelled, which accept nothing. */
  | "terminal"
  /** The evidence names a RunId the index does not hold. */
  | "unknown-run"
  /** A hook record that may not open a Run (SessionEnd, compaction) found none. */
  | "no-run"
  /** The edge does not exist from the Run's current state. */
  | "not-applicable";

export interface RejectedEdge {
  readonly runId: RunId | null;
  readonly from: RunState | null;
  /** `hook:<EventName>` or the evidence kind. Never a value from the record. */
  readonly evidence: string;
  readonly reason: RejectedReason;
}

export interface ReduceResult {
  readonly upserts: readonly SessionRun[];
  readonly rejected: readonly RejectedEdge[];
}

/** The reducer's own terminal set (PATTERNS: not the store's list). `stale` is deliberately absent. */
const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(["completed", "failed", "cancelled"]);

/** Any documented SessionEnd reason; anything else reads as `other`. It never changes the outcome. */
export function normalizeSessionEndReason(reason: string | undefined): SessionEndReason {
  return (SESSION_END_REASONS as readonly string[]).includes(reason ?? "")
    ? (reason as SessionEndReason)
    : "other";
}

type Patch = Partial<SessionRun>;

const NOTHING: ReduceResult = { upserts: [], rejected: [] };

function rejected(
  runId: RunId | null,
  from: RunState | null,
  evidence: string,
  reason: RejectedReason,
): ReduceResult {
  return { upserts: [], rejected: [{ runId, from, evidence, reason }] };
}

function upserted(...runs: readonly (SessionRun | null)[]): ReduceResult {
  const upserts = runs.filter((run): run is SessionRun => run !== null);
  return upserts.length === 0 ? NOTHING : { upserts, rejected: [] };
}

/** An evidence time never later than `now`, so a skewed clock cannot stamp the future. */
function bounded(time: string, now: string): string {
  return Date.parse(time) > Date.parse(now) ? now : time;
}

/** The later of two times; a known time never moves backwards. */
function later(previous: string | null, time: string): string {
  return previous !== null && Date.parse(previous) > Date.parse(time) ? previous : time;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/** The Run after `patch`, one revision later — or null when the patch changes nothing. */
function write(run: SessionRun, patch: Patch): SessionRun | null {
  const next: SessionRun = { ...run, ...patch };
  const changed = (Object.keys(patch) as (keyof SessionRun)[]).some(
    (key) => !sameValue(run[key], next[key]),
  );
  return changed ? { ...next, revision: run.revision + 1 } : null;
}

/** Evidence of life: a Run that had not started, or had gone quiet, is running. */
function alive(state: RunState): RunState {
  return state === "queued" || state === "starting" || state === "stale" ? "running" : state;
}

/** The ending a SessionEnd writes: completed, or only an observation while a terminate is pending. */
function endingPatch(run: SessionRun, at: string): Patch {
  return run.terminateRequestedAt !== null
    ? { endObservedAt: at }
    : { state: "completed", endedAt: at, activity: null };
}

function blankRun(runId: RunId, startedAt: string): SessionRun {
  return {
    runId,
    revision: 0,
    claudeSessionId: null,
    pid: null,
    pidStartedAt: null,
    state: "running",
    activity: null,
    projectId: null,
    name: null,
    model: null,
    effort: null,
    launchSource: null,
    cwd: null,
    worktreeRoot: null,
    permissionMode: null,
    lastError: null,
    claudeVersion: null,
    transcriptPath: null,
    linkKind: null,
    linkedFromRunId: null,
    subagentActiveIds: [],
    subagentLastType: null,
    startedAt,
    lastActivityAt: null,
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
  };
}

/** A new Run at revision 1. */
function create(runId: RunId, startedAt: string, patch: Patch): SessionRun {
  return { ...blankRun(runId, startedAt), ...patch, revision: 1 };
}

export function reduce(
  index: RunIndex,
  evidence: Evidence,
  now: string,
  mintRunId: () => RunId,
): ReduceResult {
  switch (evidence.kind) {
    case "hook":
      return reduceHook(index, evidence.record, evidence.facts, now, mintRunId);

    case "launch-registered": {
      const existing = index.byRunId(evidence.runId);
      if (existing !== null) {
        return rejected(existing.runId, existing.state, evidence.kind, "not-applicable");
      }
      return upserted(
        create(evidence.runId, bounded(evidence.at, now), {
          state: "queued",
          claudeSessionId: evidence.claudeSessionId,
          linkKind: evidence.linkKind,
          linkedFromRunId: evidence.linkedFromRunId,
          cwd: evidence.cwd,
        }),
      );
    }

    case "launch-started":
      return onRun(index, evidence.runId, evidence.kind, (run) =>
        run.state === "queued" ? upserted(write(run, { state: "starting" })) : NOTHING,
      );

    case "launch-failed":
      return onRun(index, evidence.runId, evidence.kind, (run) => {
        if (run.state === "queued" || run.state === "starting" || run.state === "stale") {
          const at = bounded(evidence.at, now);
          return upserted(write(run, { state: "failed", endedAt: at, activity: null }));
        }
        return rejected(run.runId, run.state, evidence.kind, "not-applicable");
      });

    case "terminate-requested":
      return onRun(index, evidence.runId, evidence.kind, (run) =>
        run.terminateRequestedAt === null
          ? upserted(write(run, { terminateRequestedAt: bounded(evidence.at, now) }))
          : NOTHING,
      );

    case "pid-gone":
      return onRun(index, evidence.runId, evidence.kind, (run) => {
        if (run.terminateRequestedAt !== null) {
          const at = bounded(evidence.observedAt, now);
          return upserted(write(run, { state: "cancelled", endedAt: at, activity: null }));
        }
        return upserted(write(run, { state: "stale" }));
      });

    case "pid-alive":
      return onRun(index, evidence.runId, evidence.kind, (run) =>
        run.state === "stale" ? upserted(write(run, { state: "running" })) : NOTHING,
      );

    case "start-timeout":
      return onRun(index, evidence.runId, evidence.kind, (run) =>
        run.state === "queued" || run.state === "starting"
          ? upserted(write(run, { state: "stale" }))
          : NOTHING,
      );

    case "inactivity-timeout":
      return onRun(index, evidence.runId, evidence.kind, (run) =>
        run.pid === null && (run.state === "running" || run.state === "waiting-for-approval")
          ? upserted(write(run, { state: "stale" }))
          : NOTHING,
      );
  }
}

/** Applies `apply` to a known, non-terminal Run; otherwise a rejected edge. */
function onRun(
  index: RunIndex,
  runId: RunId,
  label: string,
  apply: (run: SessionRun) => ReduceResult,
): ReduceResult {
  const run = index.byRunId(runId);
  if (run === null) return rejected(runId, null, label, "unknown-run");
  if (TERMINAL.has(run.state)) return rejected(run.runId, run.state, label, "terminal");
  return apply(run);
}

function pidOf(record: KnownHookRecord): number | null {
  const raw = record.env?.CLAUDE_PID;
  return raw === undefined ? null : Number.parseInt(raw, 10);
}

/** The Run a record belongs to: its exact identity, or for a PID-less record the session's latest. */
function findRun(index: RunIndex, sessionId: string, pid: number | null): SessionRun | null {
  if (pid !== null) return index.byIdentity(sessionId, pid);
  return index.byIdentity(sessionId, null) ?? index.latestBySession(sessionId);
}

/** The metadata every record may carry. An absent field keeps the previous value. */
function metadata(run: SessionRun | null, record: KnownHookRecord, facts: SessionFacts): Patch {
  return {
    model: record.model ?? run?.model ?? null,
    permissionMode: record.permission_mode ?? run?.permissionMode ?? null,
    effort: record.effort_level ?? run?.effort ?? null,
    name: record.session_title ?? run?.name ?? null,
    cwd: record.cwd ?? run?.cwd ?? null,
    pidStartedAt: facts.pidStartedAt ?? run?.pidStartedAt ?? null,
    launchSource: facts.launchSource ?? run?.launchSource ?? null,
    projectId: facts.projectId ?? run?.projectId ?? null,
    worktreeRoot: facts.worktreeRoot ?? run?.worktreeRoot ?? null,
    transcriptPath: facts.transcriptPath ?? run?.transcriptPath ?? null,
  };
}

/** A transition for a hook event, from the Run's current values. */
type Transition = (run: SessionRun) => Patch;

/**
 * Applies a non-SessionStart hook event to its Run. A missing Run is
 * opened as running when the event proves a live session (the hook was
 * installed mid-session); SessionEnd never opens one.
 */
function applyToRun(
  index: RunIndex,
  record: KnownHookRecord,
  facts: SessionFacts,
  at: string,
  mintRunId: () => RunId,
  opensRun: boolean,
  transition: Transition,
): ReduceResult {
  const label = `hook:${record.hook_event_name}`;
  const pid = pidOf(record);
  const run = findRun(index, record.session_id, pid);
  if (run === null) {
    if (!opensRun) return rejected(null, null, label, "no-run");
    const base = create(mintRunId(), at, {
      ...metadata(null, record, facts),
      claudeSessionId: record.session_id,
      pid,
    });
    return upserted({ ...base, ...transition(base), revision: 1 });
  }
  if (TERMINAL.has(run.state)) return rejected(run.runId, run.state, label, "terminal");
  return upserted(write(run, { ...metadata(run, record, facts), ...transition(run) }));
}

function activity(clearsWaiting: boolean, at: string): Transition {
  return (run) => ({
    state:
      run.state === "waiting-for-approval"
        ? clearsWaiting
          ? "running"
          : run.state
        : alive(run.state),
    activity: "working",
    lastActivityAt: later(run.lastActivityAt, at),
  });
}

function reduceHook(
  index: RunIndex,
  record: KnownHookRecord,
  facts: SessionFacts,
  now: string,
  mintRunId: () => RunId,
): ReduceResult {
  const at = bounded(record.observedAt, now);
  const apply = (opensRun: boolean, transition: Transition) =>
    applyToRun(index, record, facts, at, mintRunId, opensRun, transition);

  switch (record.hook_event_name) {
    case "SessionStart":
      return sessionStart(index, record, facts, at, mintRunId);

    case "SessionEnd":
      return apply(false, (run) => endingPatch(run, at));

    // The activity events that clear waiting-for-approval (SESS-09): each
    // follows the dialog being answered. Stop also clears, below.
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
      return apply(true, activity(true, at));

    // Activity that never follows a dialog, so it leaves waiting in place
    // (RESEARCH Q7, Pitfall 5).
    case "PermissionDenied":
    case "TaskCreated":
    case "TaskCompleted":
      return apply(true, activity(false, at));

    case "SubagentStart": {
      const agentId = record.agent_id;
      return apply(true, (run) => ({
        ...activity(false, at)(run),
        subagentActiveIds:
          agentId === undefined || run.subagentActiveIds.includes(agentId)
            ? run.subagentActiveIds
            : [...run.subagentActiveIds, agentId],
        subagentLastType: record.agent_type ?? run.subagentLastType,
      }));
    }

    case "SubagentStop": {
      const agentId = record.agent_id;
      return apply(true, (run) => ({
        state: alive(run.state),
        subagentActiveIds: run.subagentActiveIds.filter((id) => id !== agentId),
        lastActivityAt: later(run.lastActivityAt, at),
      }));
    }

    case "Stop":
      return apply(true, (run) => ({
        state: run.state === "waiting-for-approval" ? "running" : alive(run.state),
        activity: "idle",
        lastActivityAt: later(run.lastActivityAt, at),
      }));

    case "StopFailure":
      return apply(true, (run) => ({
        state: alive(run.state),
        activity: "idle",
        lastError: record.stop_error,
        lastActivityAt: later(run.lastActivityAt, at),
      }));

    case "PermissionRequest":
      return apply(true, (run) => ({
        state: "waiting-for-approval",
        lastActivityAt: later(run.lastActivityAt, at),
      }));

    case "Notification":
      return apply(true, (run) => {
        if (record.notification_type === "permission_prompt") {
          return { state: "waiting-for-approval" };
        }
        if (record.notification_type === "idle_prompt") {
          return { state: alive(run.state), activity: "idle" };
        }
        return { state: alive(run.state) };
      });

    case "PostModelSwitch":
      return apply(true, (run) => ({
        state: alive(run.state),
        model: record.to_model ?? record.model ?? run.model,
      }));
  }
}

/**
 * The Run a pre-registered dashboard launch waits in, when this record's
 * `CCC_RUN_ID` names one that has not yet attached to a process. A Run
 * that already has a PID is never re-adopted: every later hook in that
 * process still carries the variable.
 */
function preRegistered(index: RunIndex, record: KnownHookRecord): SessionRun | null {
  const hinted = record.env?.CCC_RUN_ID;
  if (hinted === undefined) return null;
  const run = index.byRunId(hinted as RunId);
  if (run === null || run.pid !== null) return null;
  return run.state === "queued" || run.state === "starting" || run.state === "stale" ? run : null;
}

/**
 * The previous Run on this record's process, when the process start time
 * does not contradict it (a reused PID is a different process).
 */
function previousOnProcess(
  index: RunIndex,
  pid: number | null,
  sessionId: string,
  facts: SessionFacts,
  requireKnownStart: boolean,
): SessionRun | null {
  if (pid === null) return null;
  const previous = index.latestByPid(pid);
  if (previous === null || previous.claudeSessionId === sessionId) return null;
  const known = previous.pidStartedAt !== null && facts.pidStartedAt !== null;
  if (known && previous.pidStartedAt !== facts.pidStartedAt) return null;
  if (requireKnownStart && !known) return null;
  return previous;
}

function sessionStart(
  index: RunIndex,
  record: Extract<KnownHookRecord, { hook_event_name: "SessionStart" }>,
  facts: SessionFacts,
  at: string,
  mintRunId: () => RunId,
): ReduceResult {
  const label = "hook:SessionStart";
  const sessionId = record.session_id;
  const pid = pidOf(record);
  const live = (run: SessionRun): Patch => ({ state: alive(run.state) });

  switch (record.source) {
    case "compact": {
      const run = findRun(index, sessionId, pid);
      if (run === null) return rejected(null, null, label, "no-run");
      if (TERMINAL.has(run.state)) return rejected(run.runId, run.state, label, "terminal");
      return upserted(write(run, { ...metadata(run, record, facts), ...live(run) }));
    }

    case "startup":
    case "resume":
    case "fork":
    case "clear": {
      const source = record.source;
      const registered = preRegistered(index, record);
      if (registered !== null) {
        const resumedFrom = source === "resume" ? index.latestBySession(sessionId) : null;
        return upserted(
          write(registered, {
            ...metadata(registered, record, facts),
            claudeSessionId: sessionId,
            pid,
            state: "running",
            linkKind: source === "fork" ? "fork" : registered.linkKind,
            linkedFromRunId:
              registered.linkedFromRunId ??
              (resumedFrom !== null && resumedFrom.runId !== registered.runId
                ? resumedFrom.runId
                : null),
          }),
        );
      }

      // A re-delivered SessionStart for a live Run updates it in place.
      const existing = index.byIdentity(sessionId, pid);
      if (existing !== null && !TERMINAL.has(existing.state)) {
        return upserted(
          write(existing, { ...metadata(existing, record, facts), ...live(existing) }),
        );
      }

      let linkKind: RunLinkKind | null = null;
      let linkedFrom: SessionRun | null = null;
      let ended: SessionRun | null = null;
      if (source === "resume") {
        linkKind = "resume";
        linkedFrom = index.latestBySession(sessionId);
      } else if (source === "fork") {
        linkKind = "fork";
        linkedFrom = previousOnProcess(index, pid, sessionId, facts, true);
      } else if (source === "clear") {
        // `/clear` ends the old session on this process (D-21). Its own
        // SessionEnd(reason "clear") usually arrives first; this is the
        // explicit fallback when that event was lost. The fallback ends the
        // old Run only when both process start times are known and equal:
        // with either unknown, a reused PID cannot be ruled out, so the new
        // Run is linked and the old one left for its own evidence (SESS-06,
        // wave 2 review). Linking alone invents no terminal state.
        linkKind = "clear";
        linkedFrom = previousOnProcess(index, pid, sessionId, facts, false);
        if (
          linkedFrom !== null &&
          !TERMINAL.has(linkedFrom.state) &&
          linkedFrom.pidStartedAt !== null &&
          linkedFrom.pidStartedAt === facts.pidStartedAt
        ) {
          ended = write(linkedFrom, endingPatch(linkedFrom, at));
        }
      }

      const opened = create(mintRunId(), at, {
        ...metadata(null, record, facts),
        claudeSessionId: sessionId,
        pid,
        state: "running",
        linkKind,
        linkedFromRunId: linkedFrom?.runId ?? null,
      });
      return upserted(ended, opened);
    }
  }
}
