// RED scaffold (Task 1 tracer, TDD): a stub so `agent-runs.test.tsx` and
// `shell.tsx`'s import can resolve, and fail on real assertions rather than
// a module-resolution crash. GREEN replaces this with the real destination
// (groups, tables, detail-pane slot, banners) — no test file changes
// between RED and GREEN.
import type { VNode } from "preact";
import type { QuickActionDescriptor } from "../widgets/contract.js";

export interface AgentRunsProps {
  readonly now: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function AgentRuns(_props: AgentRunsProps): VNode {
  return <div className="ccc-agent-runs" />;
}
