import {
  CollectorsRowSchema,
  type DiagnosticsHealthResponse,
  type HealthTrigger,
  HooksRowSchema,
  LaunchersRowSchema,
  type ProbeOutcome,
  SchedulerRowSchema,
  type ServiceSideRow,
  VaultRowSchema,
} from "@ccc/domain";

/**
 * Capped, concurrent, single-flight probes (plan 08-07; D-05, T-08-16, T-08-17).
 *
 * Every probe runs under its own cap and all of them under one overall cap, both as
 * `AbortSignal`s joined with `AbortSignal.any`, so aborting also reaps any child process a probe
 * started through the command runner. A probe that does not finish reads `unknown` /
 * `probe-timeout`; one that throws, or returns something the strict row schema refuses, reads
 * `unknown` / `probe-error`; neither is ever `ok`, and a result that arrives after its cap is
 * discarded. Every timer is cleared in a `finally`, so a run leaves nothing pending.
 *
 * Nothing logged here carries an error object, a message, a path or probe output: only the
 * subsystem, a closed code and the error class name (threat T-08-15).
 */

/** Each probe's own cap (D-05). */
export const PER_PROBE_CAP_MS = 2000;
/** All probes together (D-05). */
export const OVERALL_CAP_MS = 5000;
/** How long a finished run answers later requests as `cached` (research A section 2). */
export const HEALTH_CACHE_TTL_MS = 2000;

export type SubsystemRowId = ServiceSideRow["id"];

/** One subsystem's check. It must stop when `signal` aborts; it must not throw (a throw is `probe-error`). */
export type Probe = (signal: AbortSignal, trigger: HealthTrigger) => Promise<ProbeOutcome>;

export interface NamedProbe {
  readonly id: SubsystemRowId;
  readonly run: Probe;
}

/** What the log hears about a probe that did not answer: never an error object. */
export interface ProbeLogEntry {
  readonly subsystem: SubsystemRowId;
  readonly code: "probe-timeout" | "probe-error";
  readonly errorName?: string;
}

export interface RunProbesOptions {
  readonly perProbeMs?: number;
  readonly overallMs?: number;
  readonly now: () => Date;
  readonly log?: (entry: ProbeLogEntry) => void;
}

const ROW_SCHEMAS = {
  vault: VaultRowSchema,
  hooks: HooksRowSchema,
  collectors: CollectorsRowSchema,
  scheduler: SchedulerRowSchema,
  launchers: LaunchersRowSchema,
} as const satisfies Record<SubsystemRowId, { safeParse(input: unknown): { success: boolean } }>;

type Settled =
  | { readonly kind: "answered"; readonly outcome: unknown }
  | { readonly kind: "threw"; readonly errorName: string }
  | { readonly kind: "cut" };

function errorNameOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Resolves when `signal` aborts (immediately if it already has) and removes its listener on `dispose`. */
function whenAborted(signal: AbortSignal): { promise: Promise<void>; dispose: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(), dispose: () => undefined };
  let onAbort: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/** The `unknown` row for a probe that gave no answer. */
function noAnswerRow(
  id: SubsystemRowId,
  reasonCode: "probe-timeout" | "probe-error",
  checkedAt: string,
): ServiceSideRow {
  return {
    id,
    status: "unknown",
    reasonCode,
    checkedAt,
    freshness: "unavailable",
  } as ServiceSideRow;
}

/**
 * Runs one probe under `overall` and its own cap. Never rejects. The returned row's `checkedAt` is
 * the instant the answer (or the cut) was decided.
 */
async function capped(
  probe: NamedProbe,
  trigger: HealthTrigger,
  overall: AbortSignal,
  options: {
    readonly perProbeMs: number;
    readonly now: () => Date;
    readonly log: ((entry: ProbeLogEntry) => void) | undefined;
  },
): Promise<ServiceSideRow> {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), options.perProbeMs);
  const signal = AbortSignal.any([overall, own.signal]);
  const aborted = whenAborted(signal);
  try {
    // A synchronous throw from the probe is caught by the async wrapper, so it settles as `threw`.
    const answer: Promise<Settled> = (async () => probe.run(signal, trigger))().then(
      (outcome): Settled => ({ kind: "answered", outcome }),
      (err: unknown): Settled => ({ kind: "threw", errorName: errorNameOf(err) }),
    );
    const settled = await Promise.race([
      answer,
      aborted.promise.then((): Settled => ({ kind: "cut" })),
    ]);
    const checkedAt = options.now().toISOString();

    // Whatever a probe returned, a signal that has fired means its cap passed: the answer is late.
    if (settled.kind === "cut" || signal.aborted) {
      options.log?.({ subsystem: probe.id, code: "probe-timeout" });
      return noAnswerRow(probe.id, "probe-timeout", checkedAt);
    }
    if (settled.kind === "threw") {
      options.log?.({ subsystem: probe.id, code: "probe-error", errorName: settled.errorName });
      return noAnswerRow(probe.id, "probe-error", checkedAt);
    }
    const row = { ...(settled.outcome as object), checkedAt, freshness: "live" };
    if (!ROW_SCHEMAS[probe.id].safeParse(row).success) {
      options.log?.({
        subsystem: probe.id,
        code: "probe-error",
        errorName: "ProbeOutcomeInvalid",
      });
      return noAnswerRow(probe.id, "probe-error", checkedAt);
    }
    const reason = (row as { reasonCode?: unknown }).reasonCode;
    // A probe that itself reports it did not finish gave no answer either.
    return (
      reason === "probe-timeout" || reason === "probe-error"
        ? { ...row, freshness: "unavailable" }
        : row
    ) as ServiceSideRow;
  } finally {
    clearTimeout(timer);
    aborted.dispose();
  }
}

/**
 * Runs every probe at once and answers one row per probe, in the order given. Resolves within the
 * overall cap plus a tick whatever the probes do; never rejects.
 */
export async function runProbes(
  probes: readonly NamedProbe[],
  trigger: HealthTrigger,
  options: RunProbesOptions,
): Promise<ServiceSideRow[]> {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), options.overallMs ?? OVERALL_CAP_MS);
  const resolved = {
    perProbeMs: options.perProbeMs ?? PER_PROBE_CAP_MS,
    now: options.now,
    log: options.log,
  };
  try {
    const settled = await Promise.allSettled(
      probes.map((probe) => capped(probe, trigger, overall.signal, resolved)),
    );
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      // `capped` never rejects; if it somehow does, the row says so rather than nothing.
      const id = (probes[index] as NamedProbe).id;
      options.log?.({ subsystem: id, code: "probe-error", errorName: errorNameOf(result.reason) });
      return noAnswerRow(id, "probe-error", options.now().toISOString());
    });
  } finally {
    clearTimeout(overallTimer);
  }
}

// ---------------------------------------------------------------------------
// Single-flight and a short result cache

export interface HealthCacheOptions {
  readonly ttlMs?: number;
  /** Milliseconds since the epoch. */
  readonly nowMs: () => number;
}

export interface HealthCacheAnswer {
  readonly response: DiagnosticsHealthResponse;
  /**
   * True when the response is an earlier result read from the cache. A call that joined a run in
   * flight is not cached: it waited for a result computed during its own request.
   */
  readonly cached: boolean;
}

export interface HealthCache {
  /**
   * Answers from the run in flight for `trigger`, or a result younger than the TTL, or runs
   * `compute` once. The key is the trigger: a `reconnect` call never joins a `gesture` run and never
   * reads a result a `gesture` did not itself leave, so it can neither cause nor inherit a
   * Keychain check (Amendment A1). A failed run is not cached.
   */
  get(
    trigger: HealthTrigger,
    compute: () => Promise<DiagnosticsHealthResponse>,
  ): Promise<HealthCacheAnswer>;
}

interface Slot {
  inFlight: Promise<DiagnosticsHealthResponse> | null;
  last: { response: DiagnosticsHealthResponse; atMs: number } | null;
}

export function createHealthCache(options: HealthCacheOptions): HealthCache {
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_TTL_MS;
  const slots: Record<HealthTrigger, Slot> = {
    gesture: { inFlight: null, last: null },
    reconnect: { inFlight: null, last: null },
  };
  return {
    async get(trigger, compute) {
      const slot = slots[trigger];
      if (slot.inFlight !== null) {
        return { response: await slot.inFlight, cached: false };
      }
      if (slot.last !== null && options.nowMs() - slot.last.atMs < ttlMs) {
        return { response: slot.last.response, cached: true };
      }
      const run = compute();
      slot.inFlight = run;
      try {
        const response = await run;
        slot.last = { response, atMs: options.nowMs() };
        return { response, cached: false };
      } finally {
        slot.inFlight = null;
      }
    },
  };
}

/**
 * The same response served again: every `live` row becomes `cached` (with its original
 * `checkedAt`), an `unavailable` row stays `unavailable`.
 */
export function asCachedResponse(response: DiagnosticsHealthResponse): DiagnosticsHealthResponse {
  return {
    ...response,
    rows: response.rows.map((row) =>
      row.freshness === "live" ? { ...row, freshness: "cached" } : row,
    ) as DiagnosticsHealthResponse["rows"],
  };
}
