// RED scaffold (Task 2, TDD): a stub so `agent-runs-usage.test.tsx` can
// resolve its imports and fail on real assertions rather than a
// module-resolution crash. GREEN replaces this with the real usage section
// — no test file changes between RED and GREEN.
import type { UsageSummary } from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import type { QuickActionDescriptor } from "../widgets/contract.js";

export interface AgentRunsUsageProps {
  readonly summary: UsageSummary;
  readonly nowMs: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function AgentRunsUsage(_props: AgentRunsUsageProps): VNode {
  return <section className="ccc-agent-runs-usage" />;
}
