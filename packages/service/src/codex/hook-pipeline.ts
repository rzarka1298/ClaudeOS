import { type CodexHookEvent, CodexHookRecordSchema } from "@ccc/domain";
import type { IngestOutcome } from "../claude/pipeline.js";
import type { CodexSessionMirror } from "./session-mirror.js";

/**
 * The Codex hook ingest pipeline (plan 05.1-32, D-19, CODEX-05, CODEX-06,
 * T-05.1-07, T-05.1-12, T-05.1-38).
 *
 * A hook record is a hostile hint: it arrives from a process and a file the
 * service does not control. The strict domain schema has no content member, so
 * nothing but a small allowlist can arrive, and this module keeps even less:
 * one fact per thread of event name, thread id, turn id, `activityAt` and
 * `receivedAt`. The cwd, model, source and reason are validated and dropped.
 *
 * Ordering is by `activityAt`, the event's own timestamp clamped to the service
 * clock at receipt, never by receipt time: a late older Stop (a socket retry or
 * a spool replay) cannot replace a newer fact, and a future stamp is capped at
 * receipt so it cannot freeze out later real activity. Receipt time is
 * diagnostic only (stats, `lastEventAt`, hook status). The outcome union is the
 * one Phase 5 uses so the reused spool poller accepts the pipeline structurally.
 *
 * Memory is bounded: the 2,048 newest event ids and the 512 most recently
 * updated threads. A thread the mirror does not know yet is kept in that map
 * and applied by the overlay once a poll lists it; a poll is requested only
 * while the event stream has subscribers, and at most one is in flight.
 */

export const HOOK_EVENT_IDS_CAP = 2048;
export const HOOK_THREADS_CAP = 512;

/** What is retained per thread. Nothing else of a record survives ingest. */
export interface HookFact {
  /** The event time clamped to the service clock at receipt, in epoch milliseconds. */
  readonly activityAt: number;
  readonly event: CodexHookEvent;
  /** Service receipt time in epoch milliseconds; diagnostic only. */
  readonly receivedAt: number;
  readonly threadId: string;
  readonly turnId: string | null;
}

/** The three mirror operations the pipeline needs; nothing else of the mirror is reachable. */
export interface HookMirrorControl {
  /** True when the mirror has the thread in its private cache. */
  knows(threadId: string): boolean;
  invalidate(): void;
  pollNow(): Promise<void>;
}

export interface HookPipelineStats {
  /** Valid, new records (including ones whose fact was older than the retained one). */
  readonly applied: number;
  readonly duplicate: number;
  readonly invalid: number;
  /** Valid records whose fact did not replace the retained one (older or equal time). */
  readonly ignoredOlder: number;
  readonly evicted: number;
  /** Records the hook dropped at its spool cap (the drop counter file's byte size). */
  readonly dropped: number;
  /** Receipt time of the last valid new record, or null. */
  readonly lastReceiptAt: number | null;
}

export interface CodexHookPipelineDeps {
  readonly now: () => number;
  readonly mirrorControl: HookMirrorControl;
  /** Open event-stream subscribers; an unknown thread triggers a poll only while this is above zero. */
  readonly subscribers: () => number;
  /** Called once, when the first valid record arrives (the status moves to installed). */
  readonly onStatusChange?: () => void;
  /** Reason codes only: no field of a record ever reaches it. */
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
}

export interface CodexHookPipeline {
  /** Validates and applies one record. Never throws for a bad record. */
  ingest(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome>;
  latestFor(threadId: string): HookFact | undefined;
  stats(): HookPipelineStats;
  /** Receipt time of the last valid record, or null before the first. */
  lastEventAt(): number | null;
  /** The spool poller's drop counter, wired after the poller exists. */
  attachDropCount(read: () => number): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapts the real mirror to the three operations the pipeline uses. */
export function mirrorControlFor(
  mirror: Pick<CodexSessionMirror, "resolveThread" | "invalidate" | "pollNow">,
): HookMirrorControl {
  return {
    knows: (threadId) => mirror.resolveThread(threadId) !== null,
    invalidate: () => mirror.invalidate(),
    pollNow: () => mirror.pollNow(),
  };
}

export function createCodexHookPipeline(deps: CodexHookPipelineDeps): CodexHookPipeline {
  const seen = new Set<string>();
  const facts = new Map<string, HookFact>();
  let applied = 0;
  let duplicate = 0;
  let invalid = 0;
  let ignoredOlder = 0;
  let evicted = 0;
  let lastReceiptAt: number | null = null;
  let pollInFlight = false;
  let readDropCount: () => number = () => 0;

  function remember(eventId: string): void {
    seen.add(eventId);
    if (seen.size > HOOK_EVENT_IDS_CAP) {
      const oldest = seen.values().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
  }

  function retain(fact: HookFact): void {
    // Re-inserting moves the thread to the newest position of the insertion order.
    facts.delete(fact.threadId);
    facts.set(fact.threadId, fact);
    if (facts.size > HOOK_THREADS_CAP) {
      const oldest = facts.keys().next();
      if (oldest.done !== true) {
        facts.delete(oldest.value);
        evicted += 1;
      }
    }
  }

  function requestRefresh(threadId: string): void {
    const control = deps.mirrorControl;
    try {
      if (control.knows(threadId)) {
        control.invalidate();
        return;
      }
      if (deps.subscribers() <= 0 || pollInFlight) return;
      pollInFlight = true;
      let polled: Promise<void>;
      try {
        polled = control.pollNow();
      } catch (error: unknown) {
        pollInFlight = false;
        throw error;
      }
      polled
        .catch(() => {
          deps.logger?.warn({ reason: "mirror-poll-failed" }, "codex hook poll request failed");
        })
        .finally(() => {
          pollInFlight = false;
        });
    } catch {
      // The error can name a path; only a reason code is kept.
      deps.logger?.warn({ reason: "mirror-refresh-failed" }, "codex hook refresh failed");
    }
  }

  async function ingest(input: unknown): Promise<IngestOutcome> {
    if (!isPlainObject(input)) return "envelope-invalid";
    const parsed = CodexHookRecordSchema.safeParse(input);
    const observedMs = parsed.success ? Date.parse(parsed.data.observedAt) : Number.NaN;
    if (!parsed.success || !Number.isFinite(observedMs)) {
      invalid += 1;
      deps.logger?.warn({ reason: "shape-invalid" }, "codex hook record rejected");
      return "shape-invalid";
    }
    const record = parsed.data;
    if (seen.has(record.eventId)) {
      duplicate += 1;
      return "duplicate";
    }
    remember(record.eventId);

    const receivedAt = deps.now();
    const activityAt = Math.min(observedMs, receivedAt);
    applied += 1;
    const first = lastReceiptAt === null;
    lastReceiptAt = receivedAt;

    const previous = facts.get(record.session_id);
    if (previous !== undefined && activityAt <= previous.activityAt) {
      // Older or tied: the retained fact stays and nothing is refreshed.
      ignoredOlder += 1;
    } else {
      // A SessionEnd after a Stop or an Interrupt does not undo what that event said
      // (only an unfinished turn ends unknown), so the earlier verdict is kept and only
      // its time moves.
      const endsAfterVerdict =
        record.hook_event_name === "SessionEnd" &&
        previous !== undefined &&
        (previous.event === "Stop" || previous.event === "Interrupt");
      retain(
        endsAfterVerdict
          ? { ...previous, activityAt, receivedAt }
          : {
              activityAt,
              event: record.hook_event_name,
              receivedAt,
              threadId: record.session_id,
              turnId: record.turn_id ?? null,
            },
      );
      requestRefresh(record.session_id);
    }
    if (first) {
      try {
        deps.onStatusChange?.();
      } catch {
        deps.logger?.warn(
          { reason: "status-callback-failed" },
          "codex hook status callback failed",
        );
      }
    }
    return "applied";
  }

  return {
    ingest: (input) => ingest(input),
    latestFor(threadId) {
      const fact = facts.get(threadId);
      return fact === undefined ? undefined : { ...fact };
    },
    stats: () => ({
      applied,
      duplicate,
      invalid,
      ignoredOlder,
      evicted,
      dropped: readDropCount(),
      lastReceiptAt,
    }),
    lastEventAt: () => lastReceiptAt,
    attachDropCount(read) {
      readDropCount = read;
    },
  };
}
