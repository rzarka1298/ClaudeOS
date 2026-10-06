// Imports node: builtins and relative files only, plus TYPE-ONLY imports
// from @ccc/domain (erased at compile time; purity.test.ts).
import type { StatusLineSnapshot } from "@ccc/domain";

/** Wrapper-minted identity for one status-line snapshot. */
export interface StatusLineMeta {
  readonly eventId: string;
  readonly observedAt: string;
}

/** `StatusLineSnapshotSchema` length caps for its free-text fields. */
const SESSION_NAME_CAP = 256;
const MODEL_ID_CAP = 128;
const VERSION_CAP = 64;

/** The two documented rate-limit windows; each may be independently absent. */
const RATE_LIMIT_WINDOWS = ["five_hour", "seven_day"] as const;

type RateLimits = NonNullable<StatusLineSnapshot["rate_limits"]>;
type RateLimitWindow = NonNullable<RateLimits["five_hour"]>;

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === "object" && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : undefined;
}

/** Cuts `value` to at most `cap` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, cap: number): string {
  if (value.length <= cap) return value;
  const cut = value.slice(0, cap);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * One window's two documented fields, copied only when each is a scalar of
 * a type the schema accepts. A window of any other shape is omitted rather
 * than forwarded.
 */
function rateLimitWindow(value: Record<string, unknown> | undefined): RateLimitWindow | undefined {
  if (value === undefined) return undefined;
  const used = value.used_percentage;
  const resets = value.resets_at;
  if (typeof used !== "number" || (typeof resets !== "number" && typeof resets !== "string")) {
    return undefined;
  }
  return { used_percentage: used, resets_at: resets };
}

/**
 * Maps Claude Code's status-line JSON (statusline.md) to the snapshot the
 * service ingests (PR-14, RESEARCH Open Question 4): `session_id`,
 * `session_name`, `model.id`, `version`, `cost.total_cost_usd`, the two
 * `rate_limits` windows' `used_percentage`/`resets_at`, and `effort.level`.
 * The snapshot is built from that list, so `workspace` (and its repository
 * name), `pr`, `worktree`, paths, context-window detail and every future
 * key never cross. Returns `null` when the input does not parse or carries
 * no string `session_id`.
 */
export function minimizeStatusLine(raw: string, meta: StatusLineMeta): StatusLineSnapshot | null {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const status = input as Record<string, unknown>;
  if (typeof status.session_id !== "string" || status.session_id.length === 0) return null;

  const snapshot: {
    -readonly [K in keyof StatusLineSnapshot]: StatusLineSnapshot[K];
  } = {
    eventId: meta.eventId,
    observedAt: meta.observedAt,
    session_id: status.session_id,
  };
  if (typeof status.session_name === "string") {
    snapshot.session_name = truncate(status.session_name, SESSION_NAME_CAP);
  }
  const modelId = objectAt(status, "model")?.id;
  if (typeof modelId === "string") snapshot.model_id = truncate(modelId, MODEL_ID_CAP);
  if (typeof status.version === "string") snapshot.version = truncate(status.version, VERSION_CAP);
  const cost = objectAt(status, "cost")?.total_cost_usd;
  if (typeof cost === "number") snapshot.cost_total_usd = cost;
  const effort = objectAt(status, "effort")?.level;
  if (typeof effort === "string") snapshot.effort_level = effort;

  const limits = objectAt(status, "rate_limits");
  const rateLimits: { -readonly [K in keyof RateLimits]: RateLimits[K] } = {};
  for (const window of RATE_LIMIT_WINDOWS) {
    const kept = rateLimitWindow(objectAt(limits, window));
    if (kept !== undefined) rateLimits[window] = kept;
  }
  if (Object.keys(rateLimits).length > 0) snapshot.rate_limits = rateLimits;
  return snapshot;
}
