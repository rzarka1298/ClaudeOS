import type { SessionView } from "@ccc/domain";
import type { VNode } from "preact";
import type { HeroMetric, WidgetBodyProps, WidgetDefinition } from "./contract.js";

// RED SCAFFOLD (05-06 task 1): the widget exists so the test files resolve
// their imports, but the metric and body are stubs. GREEN replaces this file.

export interface ActiveSessionsData {
  readonly sessions: readonly SessionView[];
  readonly nowMs: number;
}

export function activeSessionsMetric(_data: ActiveSessionsData): HeroMetric {
  return { value: -1, caption: "not implemented", share: null, srLabel: "not implemented" };
}

function ActiveSessionsBody(_props: WidgetBodyProps<ActiveSessionsData>): VNode | null {
  return null;
}

export const activeSessionsWidget: WidgetDefinition<ActiveSessionsData> = {
  id: "active-sessions",
  title: "Active Claude sessions",
  description: "Running, waiting, completed and failed sessions.",
  dataKeys: [{ key: "sessions.active", transport: "service", sourceLabel: "Claude Code hooks" }],
  refresh: { kind: "event-driven" },
  minSize: "medium",
  preferredSize: "tall",
  featureFlag: "widget.active-sessions",
  quickActions: [],
  renderBody: ActiveSessionsBody,
  renderEmpty: () => null,
  variant: { kind: "hero", metric: activeSessionsMetric },
};
