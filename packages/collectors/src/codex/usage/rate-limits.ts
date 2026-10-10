import {
  CODEX_VERSION_PATTERN,
  type CodexUsageSnapshot,
  type CodexUsageUnavailableReason,
  type CodexUsageWindow,
} from "@ccc/domain";

/**
 * Normalises the untrusted `account/rateLimits/read` reply into a domain
 * snapshot (plan 05.1-07, D-21, CODEX-09).
 *
 * Pure: no I/O and no clock. The caller injects the observation time. The
 * result is built by picking named fields only, never by spreading the input,
 * so the account id, reset-credit details, credits and every unknown key have
 * nowhere to travel.
 */

/** Inputs the caller injects so this module never reads a clock or the environment. */
export interface NormalizeOptions {
  readonly observedAtMs: number;
  readonly nowMs?: number;
  readonly codexVersion?: string | null;
}

type PlainObject = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(
  reason: CodexUsageUnavailableReason,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  return {
    kind: "unavailable",
    reason,
    version: safeVersion(options.codexVersion),
    observedAt: isoOf(options.observedAtMs),
  };
}

function safeVersion(version: string | null | undefined): string | null {
  return typeof version === "string" && version.length <= 64 && CODEX_VERSION_PATTERN.test(version)
    ? version
    : null;
}

function isoOf(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

function epochSecondsToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function windowOf(raw: PlainObject): CodexUsageWindow | null {
  const percent = raw["usedPercent"];
  if (typeof percent !== "number") return null;
  const minutes = raw["windowDurationMins"];
  return {
    windowMinutes:
      typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    usedPercent: Math.min(percent, 100),
    resetsAt: epochSecondsToIso(raw["resetsAt"]),
    limitLabel: null,
  };
}

export function normalizeRateLimitsReply(
  raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  if (!isPlainObject(raw)) return unavailable("shape-changed", options);
  const limits = raw["rateLimits"];
  if (!isPlainObject(limits)) return unavailable("no-limits", options);
  const windows: CodexUsageWindow[] = [];
  for (const candidate of [limits["primary"], limits["secondary"]]) {
    if (!isPlainObject(candidate)) continue;
    const window = windowOf(candidate);
    if (window !== null) windows.push(window);
  }
  if (windows.length === 0) return unavailable("shape-changed", options);
  const allowed = raw["ordinaryUsageAllowed"];
  const version = safeVersion(options.codexVersion);
  return {
    kind: "available",
    windows,
    ordinaryUsageAllowed: typeof allowed === "boolean" ? allowed : null,
    rateLimitReached: Boolean(limits["rateLimitReachedType"]),
    rateLimitReachedType: null,
    source: "app-server",
    observedAt: isoOf(options.observedAtMs),
    freshness: "live",
    ...(version === null ? {} : { codexVersion: version }),
  };
}

// Task 2 adds the snake-case rollout fallback; until then it reuses the signature.
export function normalizeRolloutRateLimits(
  raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  return unavailable(raw === undefined ? "read-failed" : "shape-changed", options);
}
