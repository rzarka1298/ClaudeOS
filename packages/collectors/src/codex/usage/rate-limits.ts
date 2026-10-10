import {
  CODEX_LIMIT_LABEL_PATTERN,
  CODEX_REACHED_TYPES,
  CODEX_VERSION_PATTERN,
  type CodexReachedType,
  type CodexUsageSnapshot,
  CodexUsageSnapshotSchema,
  type CodexUsageSource,
  type CodexUsageUnavailableReason,
  type CodexUsageWindow,
} from "@ccc/domain";
import { ageFreshness } from "./guard.js";

/**
 * Normalises the untrusted `account/rateLimits/read` reply (and, as the bar-only
 * fallback, a rollout's `rate_limits`) into a domain snapshot (plan 05.1-07,
 * D-21, CODEX-08, CODEX-09).
 *
 * Pure and total: no I/O, no clock of its own and no throw. The caller injects
 * the observation time (and, optionally, "now" so a fallback can be aged).
 *
 * Privacy by construction: the result is built by picking named fields only,
 * never by spreading the input, and the final object is parsed with the strict
 * domain schema, which has no member for the account id, reset-credit data,
 * credits, the plan name or any unknown key. Nothing from the reply is ever
 * placed in an error or a log line, because this module has neither.
 *
 * Stability posture (research R2): the parse is structural, by hand. Unknown
 * keys never fail the read (the upstream schema grows); a missing or wrongly
 * typed required field always does.
 */

/** Inputs the caller injects so this module never reads a clock or the environment. */
export interface NormalizeOptions {
  /** When the reply was read (epoch milliseconds). */
  readonly observedAtMs: number;
  /** "Now", used only to age the snapshot; defaults to the observation time. */
  readonly nowMs?: number;
  readonly codexVersion?: string | null;
}

/** The domain schema keeps at most this many windows. */
const MAX_WINDOWS = 8;

/** Latest epoch second whose ISO form is four-digit-year (9999-12-31T23:59:59Z). */
const MAX_EPOCH_SECONDS = 253_402_300_799;

type PlainObject = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The names a reply flavour uses for the members this module reads. */
interface Names {
  readonly limitId: string;
  readonly reachedType: string;
  readonly percent: string;
  readonly minutes: string;
  readonly resetsAt: string;
}

const REPLY_NAMES: Names = {
  limitId: "limitId",
  reachedType: "rateLimitReachedType",
  percent: "usedPercent",
  minutes: "windowDurationMins",
  resetsAt: "resetsAt",
};

const ROLLOUT_NAMES: Names = {
  limitId: "limit_id",
  reachedType: "rate_limit_reached_type",
  percent: "used_percent",
  minutes: "window_minutes",
  resetsAt: "resets_at",
};

interface Scan {
  readonly windows: CodexUsageWindow[];
  /** Windows that were present but unusable (not an object, or no valid percent). */
  invalid: number;
  reached: boolean;
  reachedValue: unknown;
}

function newScan(): Scan {
  return { windows: [], invalid: 0, reached: false, reachedValue: undefined };
}

function safeVersion(version: string | null | undefined): string | null {
  return typeof version === "string" && version.length <= 64 && CODEX_VERSION_PATTERN.test(version)
    ? version
    : null;
}

function isoOfMs(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

function epochSecondsToIso(value: unknown): string | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_EPOCH_SECONDS
    ? new Date(value * 1000).toISOString()
    : null;
}

function labelOf(value: unknown): string | null {
  return typeof value === "string" && CODEX_LIMIT_LABEL_PATTERN.test(value) ? value : null;
}

function scanWindow(raw: unknown, names: Names, limitLabel: string | null, scan: Scan): void {
  if (raw === null || raw === undefined) return;
  if (!isPlainObject(raw)) {
    scan.invalid += 1;
    return;
  }
  const percent = raw[names.percent];
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
    scan.invalid += 1;
    return;
  }
  const minutes = raw[names.minutes];
  scan.windows.push({
    windowMinutes:
      typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null,
    usedPercent: Math.min(percent, 100),
    resetsAt: epochSecondsToIso(raw[names.resetsAt]),
    limitLabel,
  });
}

function scanLimit(raw: PlainObject, names: Names, scan: Scan): void {
  const reached = raw[names.reachedType];
  if (reached) {
    scan.reached = true;
    scan.reachedValue ??= reached;
  }
  const label = labelOf(raw[names.limitId]);
  scanWindow(raw.primary, names, label, scan);
  scanWindow(raw.secondary, names, label, scan);
}

/** The eight highest windows, in their original order (T-05.1-12; the worst is always kept). */
function capWindows(windows: readonly CodexUsageWindow[]): CodexUsageWindow[] {
  if (windows.length <= MAX_WINDOWS) return [...windows];
  const keep = windows
    .map((window, index) => ({ index, percent: window.usedPercent }))
    .sort((a, b) => b.percent - a.percent || a.index - b.index)
    .slice(0, MAX_WINDOWS)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
  return keep.flatMap((index) => {
    const window = windows[index];
    return window === undefined ? [] : [window];
  });
}

function reachedTypeOf(value: unknown): CodexReachedType {
  return CODEX_REACHED_TYPES.find((known) => known === value) ?? "other";
}

function unavailable(
  reason: CodexUsageUnavailableReason,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  return {
    kind: "unavailable",
    reason,
    version: safeVersion(options.codexVersion),
    observedAt: isoOfMs(options.observedAtMs),
  };
}

function finish(
  scan: Scan,
  ordinaryUsageAllowed: boolean | null,
  source: CodexUsageSource,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  if (scan.windows.length === 0) {
    return unavailable(scan.invalid > 0 ? "shape-changed" : "no-limits", options);
  }
  const freshness = ageFreshness(options.observedAtMs, options.nowMs ?? options.observedAtMs);
  const version = safeVersion(options.codexVersion);
  const candidate = {
    kind: "available" as const,
    windows: capWindows(scan.windows),
    ordinaryUsageAllowed,
    rateLimitReached: scan.reached,
    rateLimitReachedType: scan.reached ? reachedTypeOf(scan.reachedValue) : null,
    source,
    observedAt: isoOfMs(options.observedAtMs),
    freshness: freshness === "live" ? ("live" as const) : ("stale" as const),
    ...(version === null ? {} : { codexVersion: version }),
  };
  const parsed = CodexUsageSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data : unavailable("shape-changed", options);
}

/** The `account/rateLimits/read` result (camelCase) as a snapshot with source `app-server`. */
export function normalizeRateLimitsReply(
  raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  if (!isPlainObject(raw)) return unavailable("shape-changed", options);
  const limits = raw.rateLimits;
  if (!limits) return unavailable("no-limits", options);
  if (!isPlainObject(limits)) return unavailable("shape-changed", options);
  const byId = raw.rateLimitsByLimitId;
  if (byId !== null && byId !== undefined && !isPlainObject(byId)) {
    // A limit that cannot be read must not be silently ignored by the guard.
    return unavailable("shape-changed", options);
  }
  const scan = newScan();
  scanLimit(limits, REPLY_NAMES, scan);
  for (const entry of Object.values(byId ?? {})) {
    if (isPlainObject(entry)) scanLimit(entry, REPLY_NAMES, scan);
  }
  const allowed = raw.ordinaryUsageAllowed;
  return finish(scan, typeof allowed === "boolean" ? allowed : null, "app-server", options);
}

/**
 * A rollout's snake-case `rate_limits` as a snapshot with source
 * `rollout-fallback` (OQ-3). A rollout does not say whether ordinary usage is
 * allowed, so that member is null: the guard never allows from this snapshot.
 */
export function normalizeRolloutRateLimits(
  raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  if (!isPlainObject(raw)) return unavailable("shape-changed", options);
  const scan = newScan();
  scanLimit(raw, ROLLOUT_NAMES, scan);
  return finish(scan, null, "rollout-fallback", options);
}
