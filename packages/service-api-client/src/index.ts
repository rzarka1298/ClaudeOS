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
export { ProjectsRequestError, registerProject, refreshProjects } from "./projects-api.js";
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
