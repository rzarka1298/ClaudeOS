/**
 * The Codex store shape gate, its privacy-bounded SELECT, thread-source
 * classification and the rollout freshness canary (CODEX-04, CODEX-07, D-16,
 * D-17). Pure: the caller (the service store reader, plan 05.1-14) opens the
 * SQLite file read-only, lists the `threads` columns and hands the names in.
 *
 * Codex's `threads` table has grown from 8 to 42 columns, including account
 * identifiers and prompt-derived text. So the gate keys on DATA SHAPE (the
 * migrations table and the required columns), never on the CLI version
 * string, and the SELECT is built from named allowlisted columns, never `*`.
 */

/** Columns the product cannot work without; any one missing is a format change. */
export const REQUIRED_THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "cwd",
  "source",
  "cli_version",
  "archived",
  "updated_at_ms",
  "created_at_ms",
] as const;
export type RequiredThreadColumn = (typeof REQUIRED_THREAD_COLUMNS)[number];

/** Columns read when present and omitted when absent (RESEARCH R3 supported floor). */
export const OPTIONAL_THREAD_COLUMNS = [
  "model",
  "reasoning_effort",
  "thread_source",
  "agent_nickname",
] as const;
export type OptionalThreadColumn = (typeof OPTIONAL_THREAD_COLUMNS)[number];

/** Prompt-derived text: selected ONLY when the analysis flag is on (D-17). */
export const PROMPT_DERIVED_THREAD_COLUMNS = ["name", "title"] as const;
export type PromptDerivedThreadColumn = (typeof PROMPT_DERIVED_THREAD_COLUMNS)[number];

/**
 * Columns that are never selected for any flag value: prompt text and its
 * preview, git origin and refs, and the creator's user and account ids
 * (Pitfall 10, CODEX-07). The builder's own assertion and the tests use this.
 */
export const NEVER_SELECT_THREAD_COLUMNS = [
  "first_user_message",
  "preview",
  "git_origin_url",
  "git_sha",
  "git_branch",
  "creator_user_id",
  "creator_account_id",
] as const;

const REQUIRED: readonly string[] = REQUIRED_THREAD_COLUMNS;
const OPTIONAL: readonly string[] = OPTIONAL_THREAD_COLUMNS;
const PROMPT_DERIVED: readonly string[] = PROMPT_DERIVED_THREAD_COLUMNS;
const NEVER: readonly string[] = NEVER_SELECT_THREAD_COLUMNS;

export type StoreShapeVerdict =
  | {
      readonly ok: true;
      /** Optional columns present in this store. */
      readonly optional: readonly OptionalThreadColumn[];
      /** Prompt-derived columns present (still selected only under the flag). */
      readonly promptDerived: readonly PromptDerivedThreadColumn[];
    }
  | { readonly ok: false; readonly reason: "no-migrations-table" }
  | { readonly ok: false; readonly reason: "missing-column"; readonly column: string };

/**
 * The shape gate (D-16): the migrations table must exist and every required
 * thread column must be present. Optional columns are reported when present.
 */
export function evaluateStoreShape(input: {
  readonly migrationsTable: boolean;
  readonly columns: readonly string[];
}): StoreShapeVerdict {
  if (!input.migrationsTable) return { ok: false, reason: "no-migrations-table" };
  const present = new Set(input.columns);
  for (const column of REQUIRED_THREAD_COLUMNS) {
    if (!present.has(column)) return { ok: false, reason: "missing-column", column };
  }
  return {
    ok: true,
    optional: OPTIONAL_THREAD_COLUMNS.filter((column) => present.has(column)),
    promptDerived: PROMPT_DERIVED_THREAD_COLUMNS.filter((column) => present.has(column)),
  };
}

export interface ThreadsSelect {
  /** Parameterised SQL naming allowlisted columns only; two positional placeholders. */
  readonly sql: string;
  /** The selected columns, in SELECT order. */
  readonly columns: readonly string[];
  /** What the two `?` placeholders bind, in order. */
  readonly bindOrder: readonly ["sinceMs", "limit"];
}

/**
 * Throws if a column may not be selected. A programmer error (never user
 * input): the allowlist is the only source of column names.
 */
function assertSelectable(column: string, includePromptDerived: boolean): void {
  if (NEVER.includes(column)) {
    throw new Error(`threads column "${column}" is never selectable (CODEX-07)`);
  }
  if (PROMPT_DERIVED.includes(column)) {
    if (!includePromptDerived) {
      throw new Error(`threads column "${column}" is prompt-derived and needs the analysis flag`);
    }
    return;
  }
  if (!REQUIRED.includes(column) && !OPTIONAL.includes(column)) {
    throw new Error(`threads column "${column}" is not on the allowlist`);
  }
}

/**
 * Builds the thread SELECT from named allowlisted columns that exist in the
 * store. `columns` is the table's column list (the caller has passed the
 * shape gate, so every required column is present; a missing one throws).
 * Optional columns absent from the table are omitted. `name` and `title` are
 * added only when `includePromptDerived` is true AND the column exists.
 * `select` optionally narrows the list; naming a never-select, unlisted or
 * flag-gated column throws.
 */
export function buildThreadsSelect(
  columns: readonly string[],
  options: { readonly includePromptDerived: boolean; readonly select?: readonly string[] },
): ThreadsSelect {
  const { includePromptDerived } = options;
  const present = new Set(columns);
  const wanted: readonly string[] = options.select ?? [
    ...REQUIRED_THREAD_COLUMNS,
    ...OPTIONAL_THREAD_COLUMNS,
    ...(includePromptDerived ? PROMPT_DERIVED_THREAD_COLUMNS : []),
  ];

  const chosen: string[] = [];
  for (const column of wanted) {
    assertSelectable(column, includePromptDerived);
    if (chosen.includes(column)) continue;
    if (present.has(column)) {
      chosen.push(column);
    } else if (REQUIRED.includes(column)) {
      throw new Error(`threads is missing the required column "${column}"`);
    }
  }
  for (const column of REQUIRED_THREAD_COLUMNS) {
    if (!present.has(column)) throw new Error(`threads is missing the required column "${column}"`);
  }
  for (const column of chosen) assertSelectable(column, includePromptDerived);

  return {
    sql: `SELECT ${chosen.join(", ")} FROM threads WHERE updated_at_ms > ? ORDER BY updated_at_ms DESC LIMIT ?`,
    columns: chosen,
    bindOrder: ["sinceMs", "limit"],
  };
}

export type ThreadOrigin =
  | "interactive"
  | "headless"
  | "editor"
  | "review"
  | "spawned"
  | "guardian"
  | "unknown";

export interface ThreadSourceClass {
  readonly origin: ThreadOrigin;
  /** Whether Recent sessions lists the thread (Assumption A4). */
  readonly visible: boolean;
}

const HIDDEN_UNKNOWN: ThreadSourceClass = { origin: "unknown", visible: false };

/** A JSON `source` is a short object; anything longer is not parsed at all. */
const MAX_SOURCE_JSON = 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classifies a thread's `source`: `cli`, `exec`, `vscode` or a JSON string
 * such as `{"subagent":"review"}` (RESEARCH R3). Assumption A4: show cli,
 * exec, vscode and review; hide spawned (`thread_spawn`) and guardian
 * children. Anything else is hidden as unknown. The JSON parse is bounded and
 * never throws.
 */
export function classifyThreadSource(source: unknown): ThreadSourceClass {
  if (typeof source !== "string") return HIDDEN_UNKNOWN;
  const text = source.trim();
  if (text === "cli") return { origin: "interactive", visible: true };
  if (text === "exec") return { origin: "headless", visible: true };
  if (text === "vscode") return { origin: "editor", visible: true };
  if (!text.startsWith("{") || text.length > MAX_SOURCE_JSON) return HIDDEN_UNKNOWN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return HIDDEN_UNKNOWN;
  }
  if (!isObject(parsed)) return HIDDEN_UNKNOWN;
  const sub = parsed.subagent;
  if (sub === "review") return { origin: "review", visible: true };
  if (isObject(sub)) {
    if (isObject(sub.thread_spawn)) return { origin: "spawned", visible: false };
    if (sub.other === "guardian") return { origin: "guardian", visible: false };
  }
  return HIDDEN_UNKNOWN;
}

/** How many of the newest recent threads the canary inspects. */
export const ROLLOUT_CANARY_SAMPLE = 8;
/** This many mismatched threads in the sample make the verdict suspect. */
export const ROLLOUT_CANARY_SUSPECT_AT = 3;
/** A rollout older than its thread's update time by more than this is a mismatch. */
export const ROLLOUT_CANARY_SKEW_MS = 5 * 60 * 1000;

export interface CanaryRow {
  readonly updatedAtMs: number;
  /** The rollout file's modification time, or null when the file is missing. */
  readonly rolloutMtimeMs: number | null;
}

export interface CanaryVerdict {
  readonly verdict: "ok" | "suspect";
  readonly sampled: number;
  readonly mismatched: number;
}

/**
 * The rollout freshness canary (Assumption A17): Codex now keeps a second
 * history database, and if it ever stops writing rollouts the lifecycle read
 * would go stale silently. Among the newest recent threads, a missing rollout
 * or one much older than the thread's update time is a mismatch; enough
 * mismatches make the card read unavailable instead of wrong.
 */
export function evaluateRolloutCanary(rows: readonly CanaryRow[]): CanaryVerdict {
  const sample = [...rows]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, ROLLOUT_CANARY_SAMPLE);
  const mismatched = sample.filter(
    (row) =>
      row.rolloutMtimeMs === null || row.rolloutMtimeMs < row.updatedAtMs - ROLLOUT_CANARY_SKEW_MS,
  ).length;
  return {
    verdict: mismatched >= ROLLOUT_CANARY_SUSPECT_AT ? "suspect" : "ok",
    sampled: sample.length,
    mismatched,
  };
}
