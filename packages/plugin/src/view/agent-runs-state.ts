// RED scaffold (Task 1 tracer, TDD): a stub so `agent-runs.tsx` and
// `agent-runs.test.tsx` can resolve their imports and fail on real
// assertions rather than a module-resolution crash. GREEN replaces this
// with the real grouping logic — no test file changes between RED and
// GREEN.
import type { SessionView } from "@ccc/domain/session.js";
import { signal } from "@preact/signals";

export const selectedRunId = signal<string | null>(null);

export const RECENT_PAGE_SIZE = 25;

export interface GroupedSessions {
  readonly active: readonly SessionView[];
  readonly recent: readonly SessionView[];
  readonly unclassified: readonly SessionView[];
}

/** RED stub: always empty, regardless of input. */
export function groupSessions(
  _sessions: readonly SessionView[],
  _nowMs: number,
): GroupedSessions {
  return { active: [], recent: [], unclassified: [] };
}
