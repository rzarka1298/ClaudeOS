import type { HostRegistry, ProtocolParams } from "../host-registry.js";

/** The `obsidian://ccc-approval?id=...` action (D-26). */
export const APPROVAL_PROTOCOL_ACTION = "ccc-approval";

export interface ApprovalProtocolHandlerDeps {
  /** Selects the request, or shows the unknown-request pane for `null`. */
  readonly navigateToApproval: (id: string | null) => void;
}

export interface ApprovalProtocolDeps extends ApprovalProtocolHandlerDeps {
  readonly log: (message: string) => void;
}

/** The handler for a delivered link. It navigates and does nothing else. */
export function createApprovalProtocolHandler(
  deps: ApprovalProtocolHandlerDeps,
): (params: Readonly<Record<string, unknown>>) => void {
  return (params) => {
    const raw = params.id;
    deps.navigateToApproval(typeof raw === "string" ? raw : null);
  };
}

/**
 * Registers the deep link through the registry. Obsidian THROWS when an action
 * is registered twice (a hot reload that loads before the previous unload
 * finished), and a throw out of `onload` would abort the whole plugin, so it is
 * caught and reported, never rethrown.
 */
export function registerApprovalProtocol(registry: HostRegistry, deps: ApprovalProtocolDeps): void {
  const handler = createApprovalProtocolHandler(deps);
  try {
    registry.protocolHandler(APPROVAL_PROTOCOL_ACTION, (params: ProtocolParams) => {
      handler(params);
    });
  } catch (error) {
    deps.log(
      `could not register the ${APPROVAL_PROTOCOL_ACTION} link handler: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
