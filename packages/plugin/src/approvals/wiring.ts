import type { ApprovalsClient } from "@ccc/service-api-client";
import type { HostRegistry } from "../host-registry.js";
import { approvalsSectionVisible } from "../view/approvals-state.js";
import { requestDestination } from "../view/navigation-request.js";
import {
  type ApprovalsApi,
  ApprovalsApiError,
  configureApprovalsApi,
  refreshApprovals,
} from "./api.js";
import { registerOpenApprovalInboxCommand } from "./commands.js";
import { createApprovalNotifier, createWebNotification, type NotifyDeps } from "./notify.js";
import { registerApprovalProtocol } from "./protocol.js";
import { setApprovalUpsertHook } from "./signals.js";

/**
 * Connects the approval modules to Obsidian and the service (plan 06-23).
 * Every registration goes through the host registry, and nothing here imports
 * a function that decides or approves a request (APPR-01, APPR-09): the only
 * proposal-creating call reachable from this file is the test route.
 */

/** The delay between pressing Send a test approval and the request being made (R-22). */
export const TEST_APPROVAL_DELAY_MS = 5_000;

export const TEST_APPROVAL_STARTED_NOTICE =
  "The test request arrives in 5 seconds. Switch to another app to see the notification.";
export const TEST_APPROVAL_FAILED_NOTICE =
  "Couldn't send the test request. Check the service in Settings → Diagnostics, then try again.";

export interface TestApprovalAction {
  /** Starts a test request, or does nothing while one is already waiting out its delay. */
  press(): void;
}

/**
 * The Send a test approval action (D-20, UI-SPEC S5). The start Notice shows at
 * once; the call itself is made after five seconds through a registry timer
 * slot, so unloading the plugin cancels it. A second press within the delay is
 * ignored; once the timer has fired the action can be used again.
 */
export function createTestApprovalAction(
  registry: Pick<HostRegistry, "timer">,
  api: Pick<ApprovalsApi, "test">,
  notice: (message: string) => void,
): TestApprovalAction {
  const slot = registry.timer();
  let waiting = false;
  return {
    press() {
      if (waiting) return;
      waiting = true;
      notice(TEST_APPROVAL_STARTED_NOTICE);
      slot.schedule(() => {
        waiting = false;
        api.test().then(
          () => undefined,
          () => {
            notice(TEST_APPROVAL_FAILED_NOTICE);
          },
        );
      }, TEST_APPROVAL_DELAY_MS);
    },
  };
}

/** An id that is never minted, so selecting it shows the standard "not in the inbox" pane. */
const NEVER_MINTED_ID = "0".repeat(25);

/** The closed vocabulary a client failure is reduced to; anything else is unrecognised. */
const CLOSED_CODES: ReadonlySet<string> = new Set([
  "approval-unavailable",
  "operation-reserved",
  "too-many-pending",
  "not-found",
  "action-failed",
  "timeout",
  "service-disconnected",
  "unrecognised-response",
]);

function toApiError(error: unknown): ApprovalsApiError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new ApprovalsApiError(
    typeof code === "string" && CLOSED_CODES.has(code) ? code : "unrecognised-response",
  );
}

async function closed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toApiError(error);
  }
}

export interface WireApprovalsDeps {
  /** The approvals client built from the authenticated connection (injected, never imported by value). */
  readonly client: ApprovalsClient;
  /** An Obsidian Notice. */
  readonly notice: (message: string) => void;
  /** `settings.notifyApprovals`, read live. */
  readonly notifyEnabled: () => boolean;
  /** Whether Obsidian has focus; in production `activeDocument.hasFocus()` so popout windows count. */
  readonly appFocused: () => boolean;
  /** Brings Obsidian forward. Defaults to `window.focus()` (research Pattern 8). */
  readonly focusWindow?: (() => void) | undefined;
  /** Reveals the command center view. */
  readonly reveal: () => void;
  readonly log: (message: string) => void;
  readonly now: () => number;
  /** Builds a web notification; defaults to the guarded constructor wrapper. */
  readonly createNotification?: NotifyDeps["create"] | undefined;
}

export interface ApprovalsWiring {
  /** The Send a test approval action for the settings tab. */
  readonly testAction: TestApprovalAction;
  /** The connect hook: refreshes the approvals snapshot; a failure changes nothing. */
  readonly onLive: () => void;
}

/**
 * Wires the approval features to Obsidian (APPR-07, APPR-09, D-26): the API
 * holder over the client, the notifier on the upsert hook, the deep link, the
 * palette command and the test action. Everything that must be undone on unload
 * is registered through the registry. The API holder passes `decide` through to
 * the client for the inbox view, which is the only caller; nothing wired here
 * (the notifier, deep link, command, test action, reconnect refresh) decides a
 * request itself. The test action only creates a request that does nothing.
 */
export function wireApprovals(registry: HostRegistry, deps: WireApprovalsDeps): ApprovalsWiring {
  const client = deps.client;
  const api: ApprovalsApi = {
    list: () => closed(() => client.list()),
    get: (proposalId) => closed(() => client.get(proposalId)),
    decide: (input) => closed(() => client.decide(input)),
    test: (request) => closed(() => client.test(request)),
  };
  configureApprovalsApi(api);
  registry.cleanup(() => configureApprovalsApi(null));

  /** The one navigation a notification click and the deep link share. */
  const select = (proposalId: string): void => {
    requestDestination("agent-runs", { focusProposalId: proposalId });
    deps.reveal();
  };

  setApprovalUpsertHook(
    createApprovalNotifier({
      enabled: deps.notifyEnabled,
      appFocused: deps.appFocused,
      approvalsVisible: () => approvalsSectionVisible.value,
      notice: deps.notice,
      create: deps.createNotification ?? createWebNotification,
      focusWindow:
        deps.focusWindow ??
        (() => {
          window.focus();
        }),
      select,
      now: deps.now,
    }),
  );
  registry.cleanup(() => setApprovalUpsertHook(null));

  registerApprovalProtocol(registry, {
    navigateToApproval: (id) => select(id ?? NEVER_MINTED_ID),
    log: deps.log,
  });
  registerOpenApprovalInboxCommand(registry, deps.reveal);

  return {
    testAction: createTestApprovalAction(registry, api, deps.notice),
    onLive: () => {
      refreshApprovals().catch(() => undefined);
    },
  };
}
