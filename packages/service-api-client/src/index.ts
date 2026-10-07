export type {
  ApprovalClientErrorCode,
  ApprovalDecideInput,
  ApprovalsClient,
} from "./approvals-client.js";
export { ApprovalRequestError, createApprovalsClient } from "./approvals-client.js";
export type { ClaudeClientErrorCode, SessionActionName } from "./claude-client.js";
export {
  ClaudeRequestError,
  deleteUsageAnalytics,
  getClaudeIntegration,
  getSessionUsage,
  requestSessionAction,
  setTranscriptAnalysis,
} from "./claude-client.js";
export type {
  CreateEventClientOptions,
  EventClient,
  EventClientState,
} from "./event-client.js";
export { createEventClient } from "./event-client.js";
export type {
  AuthenticatedSocketApiClient,
  CreateAuthenticatedClientOptions,
} from "./handshake.js";
export { createAuthenticatedClient } from "./handshake.js";
export type { SaveLauncherConfigResult } from "./projects-api.js";
export {
  addScanRoot,
  detectLaunchers,
  dismissSuggestion,
  getLauncherConfigs,
  LAUNCHER_SAVE_CLIENT_TIMEOUT_MS,
  LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS,
  LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
  LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS,
  listScanState,
  listSuggestionsPage,
  markLauncherTested,
  openSystemSettings,
  ProjectsRequestError,
  pinProject,
  refreshProjects,
  registerProject,
  registerSuggestion,
  removeProject,
  removeScanRoot,
  renameProject,
  requestLaunch,
  rescanScanRoot,
  SCAN_ROOTS_CLIENT_TIMEOUT_MS,
  saveLauncherConfig,
  setGithubLink,
  testLauncher,
} from "./projects-api.js";
export type {
  SocketApiClient,
  SocketApiClientOptions,
  SocketRequestOptions,
  SocketResponse,
} from "./socket-api-client.js";
export {
  createSocketApiClient,
  requestVaultSetup,
  requestVaultSetupPlan,
  SocketUnreachableError,
  VaultSetupRequestError,
} from "./socket-api-client.js";
export type { TasksClient } from "./tasks-client.js";
export { createTasksClient, TaskRequestError } from "./tasks-client.js";
