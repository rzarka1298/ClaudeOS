// RED stub (10-02 task 1): the real parser lands in the GREEN commit.
import type { SummariserErrorCode } from "../research/summariser-error.js";

export interface ClaudeStreamSummary {
  readonly initSeen: boolean;
  readonly toolCount: number;
  readonly mcpServerCount: number;
  readonly slashCommandCount: number;
  readonly skillCount: number;
  readonly nonBuiltinPluginCount: number;
  readonly apiKeySourceIsNone: boolean;
  readonly permissionModeIsDefault: boolean;
  readonly assistantMessageCount: number;
  readonly toolUseCount: number;
  readonly hookEventCount: number;
  readonly numTurns: number | null;
}

export type ClaudeStreamOutcome =
  | { readonly ok: true; readonly text: string; readonly summary: ClaudeStreamSummary }
  | {
      readonly ok: false;
      readonly code: SummariserErrorCode;
      readonly summary: ClaudeStreamSummary;
    };

export function parseClaudeStream(
  _stdout: string,
  _opts: { readonly model: string },
): ClaudeStreamOutcome {
  return {
    ok: false,
    code: "summariser-failed",
    summary: {
      initSeen: false,
      toolCount: 0,
      mcpServerCount: 0,
      slashCommandCount: 0,
      skillCount: 0,
      nonBuiltinPluginCount: 0,
      apiKeySourceIsNone: false,
      permissionModeIsDefault: false,
      assistantMessageCount: 0,
      toolUseCount: 0,
      hookEventCount: 0,
      numTurns: null,
    },
  };
}
