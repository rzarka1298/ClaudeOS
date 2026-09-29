import type { UsageSummary } from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import type { WidgetBodyProps, WidgetDefinition } from "./contract.js";

/**
 * RED scaffold (05-10 Task 1, TDD). `claude-usage.test.tsx` resolves its
 * imports against this file and fails on real assertions — the body below
 * deliberately renders nothing usage-shaped. GREEN replaces this with the
 * real three-section card (UI-SPEC S2).
 */

export interface ClaudeUsageData {
  readonly summary: UsageSummary;
  readonly nowMs: number;
}

function ClaudeUsageBody(_props: WidgetBodyProps<ClaudeUsageData>): VNode {
  return <p className="ccc-state-body">RED scaffold</p>;
}

export const claudeUsageWidget: WidgetDefinition<ClaudeUsageData> = {
  id: "claude-usage",
  title: "Claude usage",
  description: "Plan capacity, token activity and an estimated cost.",
  dataKeys: [{ key: "usage.rollup", transport: "service", sourceLabel: "Claude usage collector" }],
  refresh: { kind: "event-driven" },
  minSize: "medium",
  preferredSize: "wide",
  featureFlag: "widget.claude-usage",
  quickActions: [],
  renderBody: ClaudeUsageBody,
  renderEmpty: () => null,
};
