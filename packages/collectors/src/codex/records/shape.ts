// RED stub: signatures only (plan 05.1-08 Task 2). The implementation lands in the green commit.

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

export const OPTIONAL_THREAD_COLUMNS = [
  "model",
  "reasoning_effort",
  "thread_source",
  "agent_nickname",
] as const;
export type OptionalThreadColumn = (typeof OPTIONAL_THREAD_COLUMNS)[number];

export const PROMPT_DERIVED_THREAD_COLUMNS = ["name", "title"] as const;
export type PromptDerivedThreadColumn = (typeof PROMPT_DERIVED_THREAD_COLUMNS)[number];

export const NEVER_SELECT_THREAD_COLUMNS = [
  "first_user_message",
  "preview",
  "git_origin_url",
  "git_sha",
  "git_branch",
  "creator_user_id",
  "creator_account_id",
] as const;

export type StoreShapeVerdict =
  | {
      readonly ok: true;
      readonly optional: readonly OptionalThreadColumn[];
      readonly promptDerived: readonly PromptDerivedThreadColumn[];
    }
  | { readonly ok: false; readonly reason: "no-migrations-table" }
  | { readonly ok: false; readonly reason: "missing-column"; readonly column: string };

export function evaluateStoreShape(_input: {
  readonly migrationsTable: boolean;
  readonly columns: readonly string[];
}): StoreShapeVerdict {
  return { ok: false, reason: "no-migrations-table" };
}

export interface ThreadsSelect {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly bindOrder: readonly ["sinceMs", "limit"];
}

export function buildThreadsSelect(
  _columns: readonly string[],
  _options: { readonly includePromptDerived: boolean; readonly select?: readonly string[] },
): ThreadsSelect {
  return { sql: "", columns: [], bindOrder: ["sinceMs", "limit"] };
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
  readonly visible: boolean;
}

export function classifyThreadSource(_source: unknown): ThreadSourceClass {
  return { origin: "unknown", visible: true };
}

export interface CanaryRow {
  readonly updatedAtMs: number;
  readonly rolloutMtimeMs: number | null;
}

export interface CanaryVerdict {
  readonly verdict: "ok" | "suspect";
  readonly sampled: number;
  readonly mismatched: number;
}

export function evaluateRolloutCanary(_rows: readonly CanaryRow[]): CanaryVerdict {
  return { verdict: "ok", sampled: 0, mismatched: 0 };
}
