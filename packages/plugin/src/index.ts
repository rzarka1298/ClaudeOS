// `@ccc/plugin`'s real entry point is `main.ts` (esbuild bundles it to
// `main.js` at the plugin root, per Obsidian's loader contract) — this
// file exists so the package follows the same `src/index.ts` shape every
// other workspace package does; it re-exports the side-effect-free pieces.

export type { ApprovalSummary, ApprovalsSnapshot } from "@ccc/domain/approval.js";
// Phase 05.1 (plan 27) harness contract: the pair action id the Codex visual cells key their status by.
export { LAUNCH_PAIR_ACTION } from "@ccc/domain/launch.js";
// Phase 7 (plan 13) harness contract: the research view models the visual cells build.
export type {
  ResearchListResponse,
  ResearchListRow,
  ResearchReportHeader,
  ResearchReportItem,
  ResearchReportItemsPage,
  ResearchReportResponse,
  ResearchReportSource,
  ResearchReportSourcesPage,
  ResearchRunResponse,
  ResearchStatusResponse,
} from "@ccc/domain/research-routes.js";
export type { SessionView } from "@ccc/domain/session.js";
export type { UsageSummary } from "@ccc/domain/usage.js";
export type { ApprovalDetailResponse, ApprovalsApi } from "./approvals/api.js";
export { configureApprovalsApi } from "./approvals/api.js";
export { adoptApprovalsFromSnapshot, applyApprovalServiceEvent } from "./approvals/events.js";
export {
  adoptApprovalsSnapshot,
  applyApprovalSummary,
  approvalDetailFocusRequested,
  approvalsById,
  approvalsCounts,
  approvalsHydrated,
  approvalsReady,
  approvalsTruncated,
  pendingApprovalCount,
  resetApprovalsState,
  selectedProposalId,
} from "./approvals/signals.js";
export type { ConnectionState, LastEventInfo } from "./connection-state.js";
export { connectionChangedAt, connectionState, lastEvent } from "./connection-state.js";
export { serializeTaskFrontmatter } from "./frontmatter-serializer.js";
// Phase 8 (plan 21) harness contract: the Settings destination, the Diagnostics frame and the Overview slice,
// mounted by the visual harness against fixture seams. Nothing here reaches Obsidian, Electron or the file system.
export type { HealthApi } from "./health/api.js";
export { configureHealth } from "./health/api.js";
export type { VerifyAndSerialise } from "./health/bundle-input.js";
export type { MotionMode } from "./motion.js";
export { motionMode } from "./motion.js";
export type { FolderPick, PickFolderOptions } from "./projects/folder-picker.js";
// Phase 05.1 (plan 27) harness contract: the one launch status store the pair-launch cells pre-load.
export type {
  LaunchStatus,
  PairClaudeLineStatus,
  PairLaunchStatus,
  PairLineStatus,
} from "./projects/launch-status.js";
export { launchStatus, launchStatusKey, resetLaunchStatus } from "./projects/launch-status.js";
export type { LaunchersActions } from "./projects/launchers-actions.js";
export type { ProjectsActions, ScanActions } from "./projects/projects-actions.js";
export { projectShortcutsStateFor } from "./projects/projects-state.js";
export { scanState } from "./projects/scan-state.js";
export type { ResearchApi, ResearchHostPorts } from "./research/api.js";
export { configureResearch, ResearchApiError } from "./research/api.js";
export { resetReaderState } from "./research/reader-state.js";
export { onResearchUpdated, resetResearchState } from "./research/state.js";
export { attachEventClient } from "./service-connection.js";
export type { TaskActionResult, TaskSaveInput } from "./tasks/actions.js";
export {
  acceptTask,
  completeTask,
  dismissTask,
  reopenTask,
  saveTask,
} from "./tasks/actions.js";
export type { TaskActionsPort } from "./tasks/actions-port.js";
export { configureTaskActionsPort } from "./tasks/actions-port.js";
export type { TasksApi } from "./tasks/api.js";
export { configureTasksApi, TasksApiError } from "./tasks/api.js";
export { createProjectTasksContext, createTasksContext } from "./tasks/contexts.js";
export { tasksAttention, tasksRebuilding } from "./tasks/rebuild.js";
export { parseTaskContent, readTaskForEdit, updateTaskNote } from "./tasks/task-update.js";
export { AgentRuns } from "./view/agent-runs.js";
export { RECENT_PAGE_SIZE, selectedRunId } from "./view/agent-runs-state.js";
export { approvalChip, approvalsMissedSync, resetApprovalsView } from "./view/approvals-state.js";
export { DestinationTabs } from "./view/destination-tabs.js";
export { DiagnosticBundleBlock } from "./view/diagnostics-bundle.js";
export { DiagnosticsSection } from "./view/diagnostics-section.js";
export { createLaunchersSession } from "./view/launchers-settings.js";
export { Overview } from "./view/overview.js";
export { ProjectTasksPanel } from "./view/project-tasks.js";
export { ResearchDestination } from "./view/research.js";
export {
  createSettingsSession,
  SECTION_VIEWS,
  SettingsDestination,
} from "./view/settings-destination.js";
export type { SettingsHost } from "./view/settings-host.js";
export { createInertSettingsHost } from "./view/settings-host.js";
export { IntegrationsSection } from "./view/settings-integrations.js";
export { SecuritySection } from "./view/settings-security.js";
export { TasksDestination } from "./view/tasks.js";
export { createTasksViewState } from "./view/tasks-view-state.js";
// ===== Phase 05.1: Codex visual harness contract =====
export type { CodexCardData } from "./widgets/codex.js";
export type { CodexParts } from "./widgets/codex-signals.js";
export { codexStateFor } from "./widgets/codex-signals.js";
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
export type { LayoutResolution } from "./widgets/layout.js";
export type {
  ActiveSessionsData,
  ClaudeUsageData,
  GithubDiscoveriesData,
  ProjectRow,
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
export type { WidgetHost } from "./widgets/widget-host.js";
export { WidgetHostContext } from "./widgets/widget-host.js";
