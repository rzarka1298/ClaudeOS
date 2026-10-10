import type { HeadroomSignal } from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

// RED stub (plan 05.1-06 task 1): signatures only.
export type CodexClientErrorCode = string;

export class CodexRequestError extends Error {
  readonly status: number;
  readonly code: CodexClientErrorCode;

  constructor(status: number, code: CodexClientErrorCode) {
    super("");
    this.name = "CodexRequestError";
    this.status = status;
    this.code = code;
  }
}

export function getCodexHeadroom(_client: SocketApiClient): Promise<HeadroomSignal> {
  return Promise.resolve(undefined as never);
}
