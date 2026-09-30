// `@ccc/plugin`'s real entry point is `main.ts` (esbuild bundles it to
// `main.js` at the plugin root, per Obsidian's loader contract) — this
// file exists so the package follows the same `src/index.ts` shape every
// other workspace package does; it re-exports the side-effect-free pieces.

export type { SessionView } from "@ccc/domain/session.js";
export type { UsageSummary } from "@ccc/domain/usage.js";
export type { ConnectionState, LastEventInfo } from "./connection-state.js";
export {
  attachEventClient,
  connectionChangedAt,
  connectionState,
  lastEvent,
} from "./connection-state.js";
export type { MotionMode } from "./motion.js";
export { motionMode } from "./motion.js";
export { AgentRuns } from "./view/agent-runs.js";
export { RECENT_PAGE_SIZE, selectedRunId } from "./view/agent-runs-state.js";
export type {
  DataDependencyKey,
  QuickActionDescriptor,
  RefreshPolicy,
  SizeHint,
  WidgetDefinition,
  WidgetState,
} from "./widgets/contract.js";
export type { FeatureFlag } from "./widgets/feature-flags.js";
export { ENABLED_FLAGS, FEATURE_FLAGS } from "./widgets/feature-flags.js";
export { WidgetFooter } from "./widgets/footer.js";
export { WidgetFrame } from "./widgets/frame.js";
export type {
  ActiveSessionsData,
  ClaudeUsageData,
  GithubDiscoveriesData,
  ProjectShortcutsData,
  QuickActionsData,
  TechIntelData,
  TodayData,
} from "./widgets/panels.js";
export type {
  CardPresentation,
  FooterModel,
  FooterSource,
  SourceStatus,
} from "./widgets/presentation.js";
export { resolveCardPresentation } from "./widgets/presentation.js";
export type { AnyWidgetDefinition, WidgetId } from "./widgets/registry.js";
export { isWidgetId, PRD_PANEL_ORDER, WIDGET_IDS, WIDGETS } from "./widgets/registry.js";
export { formatAbsoluteTime, formatRelativeTime } from "./widgets/relative-time.js";
export type { ServiceHealthData } from "./widgets/service-health.js";
export {
  serviceHealthState,
  serviceHealthStateFor,
  serviceHealthWidget,
} from "./widgets/service-health.js";
export { claudeIntegration, sessionsById } from "./widgets/session-signals.js";
export { usageSummary } from "./widgets/usage-signals.js";
export {
  permissionRequiredState,
  UNAVAILABLE_STATE,
  widgetStateFor,
} from "./widgets/widget-data.js";
