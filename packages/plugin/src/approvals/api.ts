import type {
  ApprovalDecision,
  ApprovalSummary,
  ApprovalsSnapshot,
  ApprovalTestRequest,
  ApprovalTestResponse,
  DecideResponse,
} from "@ccc/domain/approval.js";
import { ApprovalsSnapshotSchema } from "@ccc/domain/approval.js";
import type { ApprovalItemView } from "@ccc/domain/approval-view.js";
import { adoptApprovalsSnapshot } from "./signals.js";

/**
 * The seam between approval view code and the service (D-24's "components
 * never import the client" rule). Views call these plain functions; the
 * wiring plan configures them from the authenticated approvals client. The
 * service client package is never imported here, because its value exports
 * pull in Node HTTP that the plugin's browser-platform bundle cannot resolve.
 */

/** What `get` returns for one request. */
export interface ApprovalDetailResponse {
  readonly summary: ApprovalSummary;
  /** The service-built view; `null` when the payload was purged or can no longer be rendered. */
  readonly view: ApprovalItemView | null;
  readonly purged: boolean;
  /** The full payload hash a decision must echo back (the owner decides on what they saw). */
  readonly payloadHash: string;
}

/** What a decision names: one request, one decision, the hash of what was shown. Nothing else. */
export interface ApprovalDecideInput {
  readonly proposalId: string;
  readonly decision: ApprovalDecision;
  readonly payloadHash: string;
}

export interface ApprovalsApi {
  list(): Promise<ApprovalsSnapshot>;
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  decide(input: ApprovalDecideInput): Promise<DecideResponse>;
  test(request?: ApprovalTestRequest): Promise<ApprovalTestResponse>;
}

/** Closed error vocabulary the holder itself raises; the wiring maps client errors onto codes only. */
export class ApprovalsApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ApprovalsApiError";
    this.code = code;
  }
}

function disconnected(): Promise<never> {
  return Promise.reject(new ApprovalsApiError("service-disconnected"));
}

/** The default until the host configures one: every call rejects as if the service were away. */
const DISCONNECTED_API: ApprovalsApi = {
  list: disconnected,
  get: disconnected,
  decide: disconnected,
  test: disconnected,
};

let current: ApprovalsApi = DISCONNECTED_API;

/** Counts refreshes so that only the most recently started one may adopt its snapshot. */
let refreshSequence = 0;

/** Installs the API the view code reaches (or, with `null`, restores the disconnected default). */
export function configureApprovalsApi(api: ApprovalsApi | null): void {
  current = api ?? DISCONNECTED_API;
}

/** The currently configured API: exactly the four functions, nothing else. */
export function approvalsApi(): ApprovalsApi {
  return {
    list: () => current.list(),
    get: (proposalId) => current.get(proposalId),
    decide: (input) => current.decide(input),
    test: (request) => current.test(request),
  };
}

/**
 * Fetches the inbox and adopts it. Resolves `false`, changing nothing, when no
 * API is configured, the call fails or the response does not parse; `true`
 * once a validated snapshot has been adopted. A refresh superseded by a later
 * one resolves `false` without adopting.
 */
export async function refreshApprovals(): Promise<boolean> {
  refreshSequence += 1;
  const mine = refreshSequence;
  try {
    const parsed = ApprovalsSnapshotSchema.safeParse(await current.list());
    if (!parsed.success) return false;
    // A newer refresh started while this one was in flight: only the latest resolves.
    if (mine !== refreshSequence) return false;
    adoptApprovalsSnapshot(parsed.data);
    return true;
  } catch {
    return false;
  }
}
