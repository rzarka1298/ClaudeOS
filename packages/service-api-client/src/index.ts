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
  LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS,
  LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
  LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS,
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
