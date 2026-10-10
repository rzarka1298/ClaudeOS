import { CODEX_INACTIVITY_MS, deriveLifecycle } from "@ccc/collectors";
import {
  CODEX_SESSION_STATES,
  CODEX_SESSIONS_CAP,
  type CodexSessionOrigin,
  type CodexSessionsSnapshot,
  type CodexSessionsUpdatedPayload,
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
import { type CodexStoreReader, MAX_THREAD_LIMIT, type ThreadRow } from "./store-reader.js";

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
}

export interface CodexSessionMirror {
  /** The cached snapshot, read synchronously; null before the first successful poll. */
  snapshot(): CodexSessionsSnapshot | null;
  /** Reads the store and rollouts once; a poll already in flight is joined. */
  pollNow(): Promise<void>;
  /** Service-private: the rollout path of a listed thread, for the transcript opener only. */
  resolveThread(threadId: string): { readonly rolloutPath: string } | null;
  /** The number of private cache entries (a bound, never their content). */
  cacheSize(): number;
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
  let base: BaseState | null = null;
  let inFlight: Promise<void> | null = null;

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

  function assemble(state: BaseState): AvailableSnapshot {
    const ordered = [...state.views]
      .map((entry) => entry.view)
      .sort((a, b) => {
        const rank = (STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99);
        if (rank !== 0) return rank;
        return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      });
    const sessions = ordered.slice(0, CODEX_SESSIONS_CAP);
    const overflow = ordered.length - sessions.length;
    return {
      kind: "available",
      sessions,
      hiddenCount: state.hiddenBase + overflow,
      analysisOn: state.analysisOn,
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

  async function poll(): Promise<void> {
    const nowMs = deps.now();
    const analysis = deps.analysisOn();
    const read = deps.reader.readThreads({
      sinceMs: nowMs - SESSION_WINDOW_MS,
      limit: maxThreads,
      includePromptDerived: analysis,
    });
    if (read.kind !== "ok") return;

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
      views.push({ view: parsed.data });
    }

    // Eviction: only the threads this poll returned stay reachable.
    cache = next;
    const seenCwds = new Set([...next.values()].map((entry) => entry.cwd));
    attributions = new Map([...attributions].filter(([cwd]) => seenCwds.has(cwd)));

    base = {
      views,
      hiddenBase: read.hiddenCount + notListed,
      partial,
      analysisOn: analysis,
      observedAtMs: nowMs,
    };
  }

  function pollNow(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const attempt = poll().finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  }

  return {
    snapshot() {
      if (base === null) return null;
      return { ...assemble(base), freshness: ageOf(base.observedAtMs) };
    },
    pollNow,
    resolveThread(threadId) {
      const entry = cache.get(threadId);
      return entry === undefined ? null : { rolloutPath: entry.rolloutPath };
    },
    cacheSize: () => cache.size,
  };
}
