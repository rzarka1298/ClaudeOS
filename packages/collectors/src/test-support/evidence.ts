import {
  HOOK_RECORD_SCHEMAS,
  type HookRecordOf,
  isTerminalRunState,
  type KnownHookEvent,
  type RunId,
  type RunLinkKind,
  type SessionRun,
} from "@ccc/domain";
import type { Evidence, RunIndex, SessionFacts } from "../sessions/reducer.js";

/**
 * Seeded builders for reducer evidence and minimal known hook records.
 * Package-local on purpose: nothing may import `@ccc/test-fixtures` except
 * test-fixtures itself (05-PATTERNS fact 2). Every value is synthetic.
 *
 * Records are built as plain objects and then parsed by the real
 * `HOOK_RECORD_SCHEMAS`, so a fixture that would not survive the service's
 * classification cannot reach a reducer test.
 */

/** The fixed default seed: the same seed yields the same evidence on every machine. */
export const DEFAULT_EVIDENCE_SEED = 20260929;

/** mulberry32: a tiny seeded PRNG (the generator test-fixtures' synthetic notes use). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function pick<T>(next: () => number, items: readonly T[]): T {
  const item = items[Math.floor(next() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

function hexString(next: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += pick(next, HEX.split(""));
  return out;
}

/** A seeded RFC 9562 v4-shaped UUID, so the envelope's `z.uuid()` accepts it. */
export function seededUuid(next: () => number): string {
  return [
    hexString(next, 8),
    hexString(next, 4),
    `4${hexString(next, 3)}`,
    `8${hexString(next, 3)}`,
    hexString(next, 12),
  ].join("-");
}

/**
 * A deterministic RunId minter shaped like the service's (25 base-36
 * characters). Tests inject it where the service injects the real one
 * (ADR-0006: only the service mints).
 */
export function testRunIdMinter(prefix = "t"): () => RunId {
  let counter = 0;
  return () => {
    counter += 1;
    const body = counter.toString(36);
    const filler = prefix.replace(/[^0-9a-z]/g, "").slice(0, 8) || "t";
    return `${filler}${"0".repeat(25 - filler.length - body.length)}${body}` as RunId;
  };
}

/** A fixed RunId from a short label, for runs a test registers by hand. */
export function fixedRunId(label: string): RunId {
  const clean = label.toLowerCase().replace(/[^0-9a-z]/g, "");
  return clean.padEnd(25, "0").slice(0, 25) as RunId;
}

/** Synthetic session IDs (UUID-shaped, as Claude Code assigns them). */
export const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const SESSION_C = "cccccccc-0000-4000-8000-000000000003";

/** Synthetic process IDs. */
export const PID_1 = 41001;
export const PID_2 = 41002;

/** An ISO timestamp `seconds` after a fixed synthetic epoch. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 28, 12, 0, 0) + seconds * 1000).toISOString();
}

/** Every fact unknown: what the service passes for most non-SessionStart records. */
export const NO_FACTS: SessionFacts = {
  pidStartedAt: null,
  launchSource: null,
  projectId: null,
  worktreeRoot: null,
  transcriptPath: null,
};

/** Facts as the service would resolve them for a terminal-launched SessionStart. */
export function startFacts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    pidStartedAt: "Mon Sep 28 12:00:00 2026",
    launchSource: "terminal",
    projectId: "project-synthetic-1",
    worktreeRoot: "/Users/USERNAME/code/synthetic-project",
    transcriptPath: "/Users/USERNAME/.claude/projects/synthetic-project/session.jsonl",
    ...overrides,
  };
}

export interface RecordOptions {
  readonly sessionId?: string;
  /** `null` omits CLAUDE_PID (a PID-less Claude Code). Defaults to {@link PID_1}. */
  readonly pid?: number | null;
  readonly cccRunId?: RunId;
  readonly observedAt?: string;
  readonly eventId?: string;
  /** Event-specific or optional common fields (source, stop_error, model, agent_id, ...). */
  readonly fields?: Readonly<Record<string, unknown>>;
}

let eventCounter = 0;

/**
 * One validated minimal record for `event`. Throws if the built object does
 * not parse, so a malformed fixture fails loudly at construction.
 */
export function hookRecord<TEvent extends KnownHookEvent>(
  event: TEvent,
  options: RecordOptions = {},
): HookRecordOf<TEvent> {
  eventCounter += 1;
  const env: Record<string, string> = {};
  const pid = options.pid === undefined ? PID_1 : options.pid;
  if (pid !== null) env.CLAUDE_PID = String(pid);
  if (options.cccRunId !== undefined) env.CCC_RUN_ID = options.cccRunId;
  const raw = {
    eventId:
      options.eventId ??
      `00000000-0000-4000-8000-${eventCounter.toString(16).padStart(12, "0").slice(-12)}`,
    observedAt: options.observedAt ?? at(eventCounter),
    hook_event_name: event,
    session_id: options.sessionId ?? SESSION_A,
    env,
    ...options.fields,
  };
  return HOOK_RECORD_SCHEMAS[event].parse(raw) as HookRecordOf<TEvent>;
}

/** Hook evidence for one record. */
export function hook<TEvent extends KnownHookEvent>(
  event: TEvent,
  options: RecordOptions = {},
  facts: SessionFacts = NO_FACTS,
): Evidence {
  return { kind: "hook", record: hookRecord(event, options), facts };
}

/** SessionStart evidence with the given source (and startup facts by default). */
export function sessionStart(
  source: "startup" | "resume" | "clear" | "compact" | "fork",
  options: RecordOptions = {},
  facts: SessionFacts = startFacts(),
): Evidence {
  return hook("SessionStart", { ...options, fields: { source, ...options.fields } }, facts);
}

export function pidGone(runId: RunId, observedAt: string): Evidence {
  return { kind: "pid-gone", runId, observedAt };
}

export function pidAlive(runId: RunId, observedAt: string): Evidence {
  return { kind: "pid-alive", runId, observedAt };
}

export function startTimeout(runId: RunId, observedAt: string): Evidence {
  return { kind: "start-timeout", runId, observedAt };
}

export function inactivityTimeout(runId: RunId, observedAt: string): Evidence {
  return { kind: "inactivity-timeout", runId, observedAt };
}

export function launchRegistered(
  runId: RunId,
  whenAt: string,
  options: {
    readonly claudeSessionId?: string | null;
    readonly linkKind?: RunLinkKind | null;
    readonly linkedFromRunId?: RunId | null;
    readonly cwd?: string;
    readonly worktreeRoot?: string | null;
    readonly permissionMode?: string | null;
  } = {},
): Evidence {
  return {
    kind: "launch-registered",
    runId,
    claudeSessionId: options.claudeSessionId ?? null,
    linkKind: options.linkKind ?? null,
    linkedFromRunId: options.linkedFromRunId ?? null,
    cwd: options.cwd ?? "/Users/USERNAME/code/synthetic-project",
    worktreeRoot: options.worktreeRoot ?? null,
    permissionMode: options.permissionMode ?? null,
    at: whenAt,
  };
}

export function launchStarted(runId: RunId, whenAt: string): Evidence {
  return { kind: "launch-started", runId, at: whenAt };
}

export function launchFailed(runId: RunId, whenAt: string): Evidence {
  return { kind: "launch-failed", runId, at: whenAt };
}

export function terminateRequested(runId: RunId, whenAt: string): Evidence {
  return { kind: "terminate-requested", runId, at: whenAt };
}

/**
 * A test-only {@link RunIndex} over an in-memory list. The service's real
 * index reads the operational store (05-05/05-08); this one keeps insertion
 * order so "latest" is the most recently created Run.
 */
export class InMemoryRunIndex implements RunIndex {
  private readonly runs = new Map<RunId, SessionRun>();

  constructor(initial: readonly SessionRun[] = []) {
    for (const run of initial) this.runs.set(run.runId, run);
  }

  /** Applies a reduce result's upserts (a new RunId is appended, so it becomes the latest). */
  apply(upserts: readonly SessionRun[]): void {
    for (const run of upserts) this.runs.set(run.runId, run);
  }

  all(): SessionRun[] {
    return [...this.runs.values()];
  }

  byRunId(runId: RunId): SessionRun | null {
    return this.runs.get(runId) ?? null;
  }

  byIdentity(claudeSessionId: string, pid: number | null): SessionRun | null {
    return this.latest((run) => run.claudeSessionId === claudeSessionId && run.pid === pid);
  }

  latestBySession(claudeSessionId: string): SessionRun | null {
    return this.latest((run) => run.claudeSessionId === claudeSessionId);
  }

  liveByPid(pid: number): SessionRun | null {
    return this.latest((run) => run.pid === pid && !isTerminalRunState(run.state));
  }

  latestByPid(pid: number): SessionRun | null {
    return this.latest((run) => run.pid === pid);
  }

  private latest(predicate: (run: SessionRun) => boolean): SessionRun | null {
    let found: SessionRun | null = null;
    for (const run of this.runs.values()) if (predicate(run)) found = run;
    return found;
  }
}

/** A complete SessionRun with every optional fact unknown, for seeding an index. */
export function seedRun(overrides: Partial<SessionRun> & Pick<SessionRun, "runId">): SessionRun {
  return {
    revision: 1,
    claudeSessionId: SESSION_A,
    pid: PID_1,
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
    startedAt: at(0),
    lastActivityAt: null,
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    promptSeenAt: null,
    ...overrides,
  };
}

/** Draws a seeded value from a list (exported for the property test). */
export function seededPick<T>(next: () => number, items: readonly T[]): T {
  return pick(next, items);
}

/** A seeded base-36 token (for unknown-RunId draws in the property test). */
export function seededRunId(next: () => number): RunId {
  let out = "";
  for (let i = 0; i < 25; i += 1) out += pick(next, BASE36.split(""));
  return out as RunId;
}
