import type {
  ApprovalDetailResponse,
  ApprovalsSnapshot,
  ApprovalTestRequest,
  ApprovalTestResponse,
  DecideRequest,
  DecideResponse,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

// Skeleton for the RED commit: every call rejects until the GREEN step.
export type ApprovalClientErrorCode = string;

export class ApprovalRequestError extends Error {
  readonly status: number;
  readonly code: ApprovalClientErrorCode;
  constructor(status: number, code: ApprovalClientErrorCode) {
    super(code);
    this.name = "ApprovalRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface ApprovalsClient {
  list(): Promise<ApprovalsSnapshot>;
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  decide(input: DecideRequest): Promise<DecideResponse>;
  test(request?: ApprovalTestRequest): Promise<ApprovalTestResponse>;
}

const notImplemented = (): Promise<never> => Promise.reject(new Error("not implemented"));

export function createApprovalsClient(_client: SocketApiClient): ApprovalsClient {
  return {
    list: notImplemented,
    get: notImplemented,
    decide: notImplemented,
    test: notImplemented,
  };
}
