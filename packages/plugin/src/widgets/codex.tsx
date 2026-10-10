import type { VNode } from "preact";
import { CODEX_COPY } from "./codex-format.js";
import { CodexHeadroomSection } from "./codex-headroom.js";
import { CodexPlanUsageSection } from "./codex-plan-usage.js";
import type { CodexCardData } from "./codex-signals.js";
import type { WidgetBodyProps, WidgetDefinition } from "./contract.js";

export type { CodexCardData } from "./codex-signals.js";

function CodexBody({ data }: WidgetBodyProps<CodexCardData>): VNode {
  return (
    <div className="ccc-codex-sections">
      <CodexHeadroomSection data={data} />
      <CodexPlanUsageSection usage={data.usage} nowMs={data.nowMs} />
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
