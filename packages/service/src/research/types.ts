import type {
  ResearchErrorCode,
  ResearchListRequest,
  ResearchListResponse,
  ResearchReportRequest,
  ResearchReportResponse,
  ResearchRunResponse,
  ResearchStatusResponse,
} from "@ccc/domain";

/**
 * The research route layer's contract (plan 07-14; D-23, T-07-07). The routes talk to
 * {@link ResearchRouteServices} and nothing else: they never see the vault, the store, the clock
 * or the allowlist file. Every service function answers a {@link ResearchRouteResult}, so a refusal
 * is a closed code and never a message that could name a path, a title or a payload.
 */

/** A value, or one closed error code. */
export type ResearchRouteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ResearchErrorCode };

export interface ResearchRouteServices {
  /** Starts a run now, or answers the run already in flight (D-19). */
  run(): ResearchRouteResult<ResearchRunResponse>;
  /** One page of the report list, newest first. */
  list(request: ResearchListRequest): ResearchRouteResult<ResearchListResponse>;
  /** One page of one report's view model. */
  report(request: ResearchReportRequest): ResearchRouteResult<ResearchReportResponse>;
  /** The run status strip (DIAG-05). */
  status(): ResearchRouteResult<ResearchStatusResponse>;
}
