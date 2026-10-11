import {
  CODEX_INACTIVITY_MS,
  deriveLifecycle,
  evaluateCliRecognition,
  UNVERSIONED,
} from "@ccc/collectors";
import {
  CODEX_SESSION_STATES,
  CODEX_SESSIONS_CAP,
  type CodexSessionOrigin,
  type CodexSessionsSnapshot,
  CodexSessionsSnapshotSchema,
  type CodexSessionsUpdatedPayload,
  CodexSessionsUpdatedPayloadSchema,
  type CodexSessionView,
  CodexSessionViewSchema,
} from "@ccc/domain";
import type { Attribution, AttributionInput } from "../claude/attribution.js";
import type { CodexHomePort } from "./codex-home.js";
import type { HeadroomTimers } from "./headroom-service.js";
import {
  DEFAULT_TAIL_READ_BYTES,
  FIRST_SIGHT_BYTES,
  type RolloutTailEntry,
  readRolloutTail,
} from "./rollout-tail.js";
import {
  type CodexStoreReader,
  MAX_THREAD_LIMIT,
  type ThreadRow,
  type ThreadsRead,
} from "./store-reader.js";

/**
 * The Codex session mirror (plan 05.1-22, CODEX-04, CODEX-05, CODEX-07, D-14
 * to D-18, T-05.1-07, T-05.1-12, T-05.1-27).
 *
 * An in-memory, read-only picture of recent Codex threads keyed by thread id.
 * It is built from the allowlisted store rows (plan 14's reader) and the tail
 * of each rollout (plan 8's parsers), attributed to registered projects
 * through the existing attribution function with no Claude session id, and
 * persisted nowhere. Never rows in the runs table.
 *
 * Honesty: a state is the LAST lifecycle event in file order inside the
 * inactivity window. A started turn older than the window is `stale`, never
 * `completed`, and a thread with no lifecycle event is hidden while fresh and
 * `stale` when old (D-18). A sub-agent rollout that begins with the parent's
 * turn resolves by its last event.
 *
 * Privacy: a view is built by PICKING domain-validated fields, then parsed by
 * the strict domain schema. The thread's `cwd` and rollout path live only in
 * the private cache and are reachable only through {@link
 * CodexSessionMirror.resolveThread}; they never reach a snapshot, an event or
 * a log line. A prompt-derived title is selected and shown only while
 * transcript analysis is on (D-17).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Threads older than this are not read at all (D-15). */
export const SESSION_WINDOW_MS = 7 * DAY_MS;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_MAX_THREADS = 300;
export const DEFAULT_MAX_ROLLOUT_READS_PER_POLL = 40;
export const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
/** How long a cwd-to-project answer is reused before git is asked again. */
const ATTRIBUTION_TTL_MS = 60_000;
const MAX_TITLE_LENGTH = 200;

export interface CodexSessionMirrorLimits {
  /** Threads read from the store per poll (clamped to the reader's own maximum). */
  readonly maxThreads?: number;
  /** Rollouts that may be READ (bytes > 0) per poll; the rest are carried to the next poll. */
  readonly maxRolloutReadsPerPoll?: number;
  /** Total rollout bytes read per poll. */
  readonly maxBytesPerPoll?: number;
}

export interface CodexSessionMirrorDeps {
  /** Only the allowlisted rollout operations of plan 14's port. */
  readonly port: Pick<CodexHomePort, "statRollout" | "readRolloutRange">;
  readonly reader: CodexStoreReader;
  /** The Phase 5 attribution function; called with `claudeSessionId: null`. */
  readonly attribute: (input: AttributionInput) => Promise<Attribution>;
  /** The registered project's display name, or null. */
  readonly projectName: (projectId: string) => string | null;
  /** True while transcript analysis is on (D-17); read at every poll. */
  readonly analysisOn: () => boolean;
  /** Open event-stream subscribers; the poll timer reads only while this is above zero. */
  readonly subscribers: () => number;
  readonly publish: (type: "codex.sessions.updated", payload: CodexSessionsUpdatedPayload) => void;
  readonly now: () => number;
  readonly timers: HeadroomTimers;
  readonly pollIntervalMs?: number;
  /** The inactivity window; default 30 minutes (Assumption A5). */
  readonly inactivityMs?: number;
  readonly limits?: CodexSessionMirrorLimits;
  /** False when Codex is not installed: no read is attempted and the snapshot is not-installed. */
  readonly installed?: () => boolean;
  /** Reason codes only. */
  readonly logger?: {
    warn(fields: { readonly reason: string; readonly errorName?: string }, message: string): void;
  };
}

/** Applied in order to each built view; may only return a valid view for the same thread. */
export interface SessionOverlayContext {
  /** True when a limit-hit fact follows the last lifecycle event (or there is no lifecycle event). */
  readonly limitHitAfter: boolean;
  /** The thread the view describes (plan 05.1-26): lets an overlay match its own records. */
  readonly threadId: string;
  /** The ISO time of the last lifecycle event, or null when the rollout has none. */
  readonly lastLifecycleAt: string | null;
}

export type SessionOverlay = (
  view: CodexSessionView,
  context: SessionOverlayContext,
) => CodexSessionView;

/** Called on each subscriber-gated tick, before the poll starts; must not throw. */
export type TickHook = () => void | Promise<void>;

export interface CodexSessionMirror {
  /** The cached snapshot, read synchronously; null before the first successful poll. */
  snapshot(): CodexSessionsSnapshot | null;
  /** Reads the store and rollouts once; a poll already in flight is joined. */
  pollNow(): Promise<void>;
  /** Service-private: the rollout path of a listed thread, for the transcript opener only. */
  resolveThread(threadId: string): { readonly rolloutPath: string } | null;
  /** The number of private cache entries (a bound, never their content). */
  cacheSize(): number;
  start(): void;
  stop(): void;
  refreshIfStale(): void;
  addOverlay(overlay: SessionOverlay): () => void;
  /** Registers work to run on each subscriber-gated tick (plan 05.1-26); returns a remover. */
  addTickHook(hook: TickHook): () => void;
  invalidate(): void;
}

/**
 * The inactivity window: `CCC_CODEX_INACTIVITY_MS` when it is a whole number of
 * milliseconds between one second and thirty days, else the thirty minute
 * default (Assumption A5). An off-shape value is ignored, never guessed at.
 */
export function resolveCodexInactivityMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.CCC_CODEX_INACTIVITY_MS;
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) return CODEX_INACTIVITY_MS;
  const value = Number(raw);
  return value >= 1000 && value <= 30 * DAY_MS ? value : CODEX_INACTIVITY_MS;
}

/** What the mirror keeps privately per thread. Never placed on any output. */
interface PrivateEntry {
  readonly rolloutPath: string;
  readonly cwd: string;
  readonly tail: RolloutTailEntry | undefined;
}

/** A built view plus the facts the overlay seam may want. */
interface BaseView {
  readonly view: CodexSessionView;
  readonly limitHitAfter: boolean;
  readonly lastLifecycleAt: string | null;
}

interface BaseState {
  readonly views: readonly BaseView[];
  /** Threads the reader hid plus those the mirror chose not to list. */
  readonly hiddenBase: number;
  readonly partial: boolean;
  readonly analysisOn: boolean;
  readonly observedAtMs: number;
}

type AvailableSnapshot = Extract<CodexSessionsSnapshot, { kind: "available" }>;
type UnavailableSnapshot = Extract<CodexSessionsSnapshot, { kind: "unavailable" }>;

type Current =
  | { readonly kind: "available"; readonly base: BaseState; readonly assembled: AvailableSnapshot }
  | { readonly kind: "unavailable"; readonly snapshot: UnavailableSnapshot };

/** The change key: everything a viewer sees except the two clock-derived members. */
function changeKey(snapshot: CodexSessionsSnapshot): string {
  return snapshot.kind === "unavailable"
    ? JSON.stringify(snapshot)
    : JSON.stringify({ ...snapshot, observedAt: null, freshness: null });
}

const STATE_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  CODEX_SESSION_STATES.map((state, index) => [state, index]),
);

function isoOrNull(ms: number): string | null {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapOrigin(origin: ThreadRow["origin"]): CodexSessionOrigin | null {
  return origin === "interactive" ||
    origin === "headless" ||
    origin === "review" ||
    origin === "editor"
    ? origin
    : null;
}

/** A prompt-derived title bounded to 200 characters with control characters removed. */
function cleanTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let text = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    text += control ? " " : char;
  }
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  return trimmed.length === 0 ? null : trimmed;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function createCodexSessionMirror(deps: CodexSessionMirrorDeps): CodexSessionMirror {
  const intervalMs = clamp(deps.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1, 24 * 60 * 60 * 1000);
  const inactivityMs = clamp(deps.inactivityMs, CODEX_INACTIVITY_MS, 1, 30 * DAY_MS);
  const maxThreads = clamp(deps.limits?.maxThreads, DEFAULT_MAX_THREADS, 1, MAX_THREAD_LIMIT);
  const maxReads = clamp(
    deps.limits?.maxRolloutReadsPerPoll,
    DEFAULT_MAX_ROLLOUT_READS_PER_POLL,
    1,
    10_000,
  );
  const maxBytes = clamp(
    deps.limits?.maxBytesPerPoll,
    DEFAULT_MAX_BYTES_PER_POLL,
    1,
    1024 * 1024 * 1024,
  );

  /** Private per-thread cache; rebuilt each poll from the threads the reader returned. */
  let cache = new Map<string, PrivateEntry>();
  /** Private cwd -> project answers, reused for {@link ATTRIBUTION_TTL_MS}. */
  let attributions = new Map<
    string,
    { readonly projectId: string | null; readonly atMs: number }
  >();
  let current: Current | null = null;
  let inFlight: Promise<void> | null = null;
  let lastAttemptMs: number | null = null;
  let timerHandle: unknown = null;
  let lastPublishedKey: string | null = null;
  const overlays: SessionOverlay[] = [];
  const tickHooks: TickHook[] = [];

  async function projectFor(cwd: string, nowMs: number): Promise<string | null> {
    const known = attributions.get(cwd);
    if (known !== undefined && nowMs - known.atMs <= ATTRIBUTION_TTL_MS) return known.projectId;
    let projectId: string | null = null;
    try {
      projectId = (await deps.attribute({ cwd, claudeSessionId: null })).projectId;
    } catch {
      // An attribution failure leaves the session unattributed; nothing about it is kept.
      projectId = null;
    }
    attributions.set(cwd, { projectId, atMs: nowMs });
    return projectId;
  }

  /** Runs the overlays over one base view; a failing or invalid overlay is skipped for it. */
  function overlaid(entry: BaseView, analysisOn: boolean, failures: { count: number }) {
    let view = entry.view;
    for (const overlay of overlays) {
      try {
        const parsed = CodexSessionViewSchema.safeParse(
          overlay(view, {
            limitHitAfter: entry.limitHitAfter,
            threadId: view.threadId,
            lastLifecycleAt: entry.lastLifecycleAt,
          }),
        );
        if (parsed.success && parsed.data.threadId === view.threadId) view = parsed.data;
        else failures.count += 1;
      } catch {
        failures.count += 1;
      }
    }
    // Whatever an overlay did, a prompt-derived title needs analysis to be on (D-17).
    return analysisOn || view.title === null ? view : { ...view, title: null };
  }

  function assemble(state: BaseState): AvailableSnapshot {
    const analysisOn = state.analysisOn && deps.analysisOn();
    const failures = { count: 0 };
    const ordered = state.views
      .map((entry) => overlaid(entry, analysisOn, failures))
      .sort((a, b) => {
        const rank = (STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99);
        if (rank !== 0) return rank;
        return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      });
    if (failures.count > 0) {
      deps.logger?.warn({ reason: "overlay-skipped" }, "codex session overlay skipped");
    }
    const sessions = ordered.slice(0, CODEX_SESSIONS_CAP);
    const overflow = ordered.length - sessions.length;
    return {
      kind: "available",
      sessions,
      hiddenCount: state.hiddenBase + overflow,
      analysisOn,
      observedAt: new Date(state.observedAtMs).toISOString(),
      freshness: "live",
      partiality: state.partial
        ? { partial: true, missingSources: ["codex-rollouts"] }
        : { partial: false },
    };
  }

  function ageOf(observedAtMs: number): "live" | "cached" | "stale" {
    const age = deps.now() - observedAtMs;
    if (age <= 2 * intervalMs) return "live";
    return age <= 3 * intervalMs ? "cached" : "stale";
  }

  function snapshot(): CodexSessionsSnapshot | null {
    if (current === null) return null;
    if (current.kind === "unavailable") return current.snapshot;
    const freshness = ageOf(current.base.observedAtMs);
    const assembled = current.assembled;
    // Turning analysis off takes effect at once, not at the next poll (D-17).
    if (assembled.analysisOn && !deps.analysisOn()) {
      return {
        ...assembled,
        freshness,
        analysisOn: false,
        sessions: assembled.sessions.map((session) => ({ ...session, title: null })),
      };
    }
    return { ...assembled, freshness };
  }

  /** The one gate before the wire: the strict domain schema, then a change check. */
  function publishIfChanged(): void {
    const value = snapshot();
    if (value === null) return;
    // A machine that never showed any sign of Codex hears nothing about it: the first
    // not-installed answer is the absence of a feature, not a change (the snapshot and the
    // list route still carry it). A Codex that disappears later is a change and is published.
    if (
      value.kind === "unavailable" &&
      value.reason === "not-installed" &&
      lastPublishedKey === null
    )
      return;
    const key = changeKey(value);
    if (key === lastPublishedKey) return;
    const payload = CodexSessionsUpdatedPayloadSchema.safeParse(value);
    if (!payload.success) {
      deps.logger?.warn({ reason: "payload-invalid" }, "codex sessions event not published");
      return;
    }
    lastPublishedKey = key;
    deps.publish("codex.sessions.updated", payload.data);
  }

  function setUnavailable(reason: UnavailableSnapshot["reason"], version: string | null): void {
    const candidate = { kind: "unavailable" as const, reason, version };
    const parsed = CodexSessionsSnapshotSchema.safeParse(candidate);
    // A version that is off-shape is dropped, never shown.
    const safe = parsed.success
      ? candidate
      : { kind: "unavailable" as const, reason, version: null };
    current = { kind: "unavailable", snapshot: safe };
  }

  async function poll(): Promise<void> {
    const nowMs = deps.now();
    try {
      if (deps.installed?.() === false) {
        cache = new Map();
        attributions = new Map();
        setUnavailable("not-installed", null);
        return;
      }
      const analysis = deps.analysisOn();
      const read = deps.reader.readThreads({
        sinceMs: nowMs - SESSION_WINDOW_MS,
        limit: maxThreads,
        includePromptDerived: analysis,
      });
      if (read.kind !== "ok") {
        if (read.reason === "format-changed")
          setUnavailable("format-changed", read.newestCliVersion);
        else if (read.reason === "no-store") {
          cache = new Map();
          attributions = new Map();
          setUnavailable("no-data", null);
        }
        // Busy and read-failed keep whatever is there; it ages by the clock.
        return;
      }
      await build(read, nowMs, analysis);
    } catch (error: unknown) {
      deps.logger?.warn(
        { reason: "poll-threw", errorName: error instanceof Error ? error.name : "non-error" },
        "codex sessions poll failed",
      );
    } finally {
      lastAttemptMs = deps.now();
      publishIfChanged();
    }
  }

  async function build(
    read: Extract<ThreadsRead, { kind: "ok" }>,
    nowMs: number,
    analysis: boolean,
  ): Promise<void> {
    const next = new Map<string, PrivateEntry>();
    const staged: Array<{ row: ThreadRow; tail: RolloutTailEntry | undefined; has: boolean }> = [];
    let reads = 0;
    let bytesLeft = maxBytes;
    let notListed = 0;
    let partial = false;

    for (const row of read.threads) {
      if (row.archived) {
        notListed += 1;
        continue;
      }
      const previous = cache.get(row.id)?.tail;
      const result = readRolloutTail(deps.port, { path: row.rolloutPath }, previous, {
        firstSightBytes: FIRST_SIGHT_BYTES,
        maxBytes: reads >= maxReads ? 0 : Math.min(bytesLeft, DEFAULT_TAIL_READ_BYTES),
      });
      let tail = previous;
      let has = previous !== undefined;
      if (result.kind === "ok") {
        tail = result.entry;
        has = true;
        if (result.bytesRead > 0) {
          reads += 1;
          bytesLeft -= result.bytesRead;
        }
        if (!result.caughtUp) partial = true;
      } else if (result.kind === "deferred") {
        partial = true;
        if (previous === undefined) {
          // Never read yet: carried to a later poll rather than guessed at.
          next.set(row.id, { rolloutPath: row.rolloutPath, cwd: row.cwd, tail: undefined });
          notListed += 1;
          continue;
        }
      } else if (result.kind === "failed") {
        partial = true;
      }
      next.set(row.id, { rolloutPath: row.rolloutPath, cwd: row.cwd, tail });
      staged.push({ row, tail, has });
    }

    // Eviction: only the threads this poll returned stay reachable.
    cache = next;
    const seenCwds = new Set([...next.values()].map((entry) => entry.cwd));
    attributions = new Map([...attributions].filter(([cwd]) => seenCwds.has(cwd)));

    // Per-version recognition (D-16): a version whose rollouts stopped parsing reads unavailable.
    const byVersion: Record<string, { sessions: number; recognized: number }> = {};
    for (const { row, tail } of staged) {
      if (tail === undefined || tail.lines === 0) continue;
      const key = row.cliVersion ?? UNVERSIONED;
      const tally = byVersion[key] ?? { sessions: 0, recognized: 0 };
      tally.sessions += 1;
      if (tail.recognized > 0) tally.recognized += 1;
      byVersion[key] = tally;
    }
    const verdict = evaluateCliRecognition(byVersion);
    if (verdict.kind === "unavailable") {
      setUnavailable("format-changed", verdict.version);
      return;
    }

    const views: BaseView[] = [];
    for (const { row, tail, has } of staged) {
      const origin = mapOrigin(row.origin);
      const startedAt = isoOrNull(row.createdAtMs);
      const lastActivityAt = isoOrNull(row.updatedAtMs);
      if (origin === null || startedAt === null || lastActivityAt === null) {
        notListed += 1;
        continue;
      }
      const lifecycle = deriveLifecycle(tail?.retained ?? [], {
        nowMs,
        inactivityMs,
        lastActivityMs: row.updatedAtMs,
      });
      if (lifecycle.display === null) {
        notListed += 1;
        continue;
      }
      const projectId = await projectFor(row.cwd, nowMs);
      const projectName = projectId === null ? null : deps.projectName(projectId);
      const candidate = {
        threadId: row.id,
        projectId,
        projectName,
        origin,
        state: lifecycle.display,
        model: CodexSessionViewSchema.shape.model.safeParse(row.model ?? null).data ?? null,
        effort:
          CodexSessionViewSchema.shape.effort.safeParse(row.reasoningEffort ?? null).data ?? null,
        startedAt,
        lastActivityAt,
        resumesAfter: null,
        title: analysis ? cleanTitle(row.title ?? row.name) : null,
        hasTranscript: has,
        liveLogRunId: null,
      };
      const parsed = CodexSessionViewSchema.safeParse(candidate);
      if (!parsed.success) {
        notListed += 1;
        continue;
      }
      views.push({
        view: parsed.data,
        limitHitAfter: lifecycle.limitHitAfter,
        lastLifecycleAt: lifecycle.lastEventAt,
      });
    }

    const state: BaseState = {
      views,
      hiddenBase: read.hiddenCount + notListed,
      partial,
      analysisOn: analysis,
      observedAtMs: nowMs,
    };
    current = { kind: "available", base: state, assembled: assemble(state) };
  }

  function pollNow(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const attempt = poll().finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  }

  /**
   * Runs the registered tick hooks (plan 05.1-26). A hook that throws or rejects is contained and
   * never reaches a log line (its message can carry a path); the poll starts regardless.
   */
  function runTickHooks(): void {
    for (const hook of [...tickHooks]) {
      try {
        void Promise.resolve(hook()).catch(() => undefined);
      } catch {
        // Contained: a failing hook never breaks the tick.
      }
    }
  }

  /** Rebuilds the assembled snapshot from the cached base (no store read). */
  function rebuild(): void {
    if (current === null || current.kind !== "available") return;
    current = { ...current, assembled: assemble(current.base) };
  }

  /** Fire-and-forget poll: a throwing publish (poll's finally) must not become an unhandled rejection. */
  function pollContained(): void {
    pollNow().catch(() => {
      deps.logger?.warn({ reason: "poll-publish-failed" }, "codex sessions poll publish failed");
    });
  }

  return {
    snapshot,
    pollNow,
    resolveThread(threadId) {
      const entry = cache.get(threadId);
      return entry === undefined ? null : { rolloutPath: entry.rolloutPath };
    },
    cacheSize: () => cache.size,
    start() {
      if (timerHandle !== null) return;
      timerHandle = deps.timers.setInterval(() => {
        if (deps.subscribers() <= 0) return;
        runTickHooks();
        pollContained();
      }, intervalMs);
    },
    stop() {
      if (timerHandle === null) return;
      deps.timers.clearInterval(timerHandle);
      timerHandle = null;
    },
    refreshIfStale() {
      const stale =
        current === null || lastAttemptMs === null || deps.now() - lastAttemptMs > 3 * intervalMs;
      if (stale) pollContained();
    },
    addTickHook(hook) {
      tickHooks.push(hook);
      return () => {
        const index = tickHooks.indexOf(hook);
        if (index >= 0) tickHooks.splice(index, 1);
      };
    },
    addOverlay(overlay) {
      overlays.push(overlay);
      return () => {
        const index = overlays.indexOf(overlay);
        if (index >= 0) overlays.splice(index, 1);
      };
    },
    invalidate() {
      rebuild();
      publishIfChanged();
    },
  };
}
