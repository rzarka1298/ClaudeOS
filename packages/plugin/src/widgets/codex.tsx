import type { VNode } from "preact";
import { CodexCurrentRunSection } from "./codex-current-run.js";
import { CODEX_COPY } from "./codex-format.js";
import { CodexHeadroomSection } from "./codex-headroom.js";
import { CodexPlanUsageSection } from "./codex-plan-usage.js";
import { buildCodexSessionRows } from "./codex-session-rows.js";
import { CodexSessionsSection } from "./codex-sessions.js";
import type { CodexCardData } from "./codex-signals.js";
import { CodexTokenActivitySection } from "./codex-token-activity.js";
import type { WidgetBodyProps, WidgetDefinition } from "./contract.js";

export type { CodexCardData } from "./codex-signals.js";

function CodexBody({ data, size, onQuickAction }: WidgetBodyProps<CodexCardData>): VNode {
  const rows =
    data.sessions === null
      ? { kind: "unavailable" as const, reason: "no-data" as const, version: null }
      : buildCodexSessionRows(data.sessions, {
          nowMs: data.nowMs,
          analysisOn: data.analysisOn,
          size,
          hookInstalled:
            data.integration === null || data.integration.hooks.state === "unknown"
              ? null
              : data.integration.hooks.state !== "not-installed",
        });
  return (
    <div className="ccc-codex-sections">
      <CodexHeadroomSection data={data} />
      <CodexPlanUsageSection usage={data.usage} nowMs={data.nowMs} />
      <CodexCurrentRunSection rows={rows} size={size} onQuickAction={onQuickAction} />
      <CodexSessionsSection rows={rows} size={size} onQuickAction={onQuickAction} />
      <CodexTokenActivitySection
        summary={data.tokens}
        analysisOn={data.analysisOn}
        nowMs={data.nowMs}
        onQuickAction={onQuickAction}
      />
    </div>
  );
}
const EMPTY_DATA: CodexCardData = {
  sessions: null,
  usage: null,
  headroom: null,
  tokens: null,
  integration: null,
  nowMs: 0,
  analysisOn: false,
};
export const codexWidget: WidgetDefinition<CodexCardData> = {
  id: "codex",
  title: CODEX_COPY.cardTitle,
  description: CODEX_COPY.cardDescription,
  preferredSize: "tall",
  minSize: "medium",
  featureFlag: "widget.codex",
  refresh: { kind: "event-driven" },
  ownsEmptyCopy: true,
  quickActions: [],
  dataKeys: [
    { key: "codex.sessions", sourceLabel: CODEX_COPY.sessionsSource, transport: "service" },
    { key: "codex.usage", sourceLabel: CODEX_COPY.usageSource, transport: "service" },
    { key: "codex.token-activity", sourceLabel: CODEX_COPY.tokenSource, transport: "service" },
    { key: "codex.headroom", sourceLabel: CODEX_COPY.headroomSource, transport: "service" },
  ],
  renderBody: CodexBody,
  renderEmpty: () => <CodexBody data={EMPTY_DATA} size="tall" />,
};
