// RED scaffold (Task 1, TDD). Exports the right shapes so the test file
// resolves and fails on real assertions rather than a module-resolution
// crash. GREEN replaces every body below with the real implementation.

import type { ClaudeIntegrationStatus } from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

export class ClaudeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ClaudeRequestError";
    this.status = status;
    this.code = code;
  }
}

export function getClaudeIntegration(_client: SocketApiClient): Promise<ClaudeIntegrationStatus> {
  throw new Error("not implemented");
}

export function setTranscriptAnalysis(
  _client: SocketApiClient,
  _enabled: boolean,
): Promise<{ enabled: boolean }> {
  throw new Error("not implemented");
}
