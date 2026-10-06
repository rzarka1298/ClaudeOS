import type {
  ApprovalItemView,
  ApprovalSummary,
  ApprovalsSnapshot,
  ApprovalTestRequest,
  ApprovalTestResponse,
  DecideResponse,
} from "@ccc/domain";
import type { EngineDecideInput, SubmitRejection } from "../approval/index.js";

/**
 * What the approval routes need from the running service (plan 06-13, D-28).
 *
 * The route layer never sees the engine: it talks to this narrow interface,
 * which the composition root (06-21) satisfies from the engine, the store and
 * the clock. Route tests use a fake of it. Nothing here can name an operation
 * or carry a payload: a decision is one request, one choice and one hash, and
 * the only request a client can cause to exist is the zero-effect test.
 */

/** The most bytes any response the client will accept may take (the client's own inbound cap). */
export const CLIENT_RESPONSE_CAP_BYTES = 64 * 1024;

/**
 * One request's detail as the services hand it to the route: the summary, the
 * service-built view (or null once purged or unreadable) and the FULL payload
 * hash a decision must echo back. The hash comes from the stored row, so it is
 * present even when the view is not.
 */
export interface ApprovalFound {
  readonly kind: "found";
  readonly summary: ApprovalSummary;
  readonly view: ApprovalItemView | null;
  readonly purged: boolean;
  readonly payloadHash: string;
}

export type ApprovalGetResult = ApprovalFound | { readonly kind: "not-found" };

/** The test route's answer: a request now exists, or the engine refused to create one. */
export type ApprovalTestResult =
  | ApprovalTestResponse
  | { readonly kind: "rejected"; readonly reason: SubmitRejection };

export interface ApprovalServices {
  /** False until startup recovery has finished; the snapshot reports it. */
  readonly ready: boolean;
  /**
   * The inbox, trimmed so the approvals part takes at most `budgetBytes` UTF-8
   * bytes. Called with no budget, it uses the domain default.
   */
  snapshot(budgetBytes?: number): ApprovalsSnapshot;
  get(proposalId: string): ApprovalGetResult;
  decide(input: EngineDecideInput): Promise<DecideResponse>;
  /** Raises a test approval that does nothing; every call is a distinct request (D-20). */
  test(request: ApprovalTestRequest): ApprovalTestResult;
}
