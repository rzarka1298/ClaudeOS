import type { SummariserErrorCode } from "../research/summariser-error.js";

/**
 * What the parser lets out about a stream: counts and booleans, never the init event, a plugin
 * source, an account identifier or a model reply fragment (D-09, T-10-04).
 */
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Parses the stdout of one `claude -p --output-format stream-json --verbose` call into the result
 * text. This first cut reads the clean path only; the isolation gates follow in the next commit.
 */
export function parseClaudeStream(
  stdout: string,
  _opts: { readonly model: string },
): ClaudeStreamOutcome {
  let init: Record<string, unknown> | null = null;
  const messageIds = new Set<string>();
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      event = null;
    }
    if (event === null) return fail("summariser-failed", init, messageIds);
    if (event.type === "system" && event.subtype === "init") init = event;
    if (event.type === "assistant") {
      const id = asRecord(event.message)?.id;
      if (typeof id === "string") messageIds.add(id);
    }
    if (event.type === "result") result = event;
  }
  if (init === null || result === null || typeof result.result !== "string") {
    return fail("summariser-failed", init, messageIds);
  }
  return {
    ok: true,
    text: result.result,
    summary: summarise(init, messageIds, result),
  };
}

function summarise(
  init: Record<string, unknown> | null,
  messageIds: ReadonlySet<string>,
  result: Record<string, unknown> | null,
): ClaudeStreamSummary {
  const plugins = Array.isArray(init?.plugins) ? init.plugins : [];
  return {
    initSeen: init !== null,
    toolCount: count(init?.tools),
    mcpServerCount: count(init?.mcp_servers),
    slashCommandCount: count(init?.slash_commands),
    skillCount: count(init?.skills),
    nonBuiltinPluginCount: plugins.filter((p) => asRecord(p)?.path !== "builtin").length,
    apiKeySourceIsNone: init?.apiKeySource === "none",
    permissionModeIsDefault: init?.permissionMode === "default",
    assistantMessageCount: messageIds.size,
    toolUseCount: 0,
    hookEventCount: 0,
    numTurns: typeof result?.num_turns === "number" ? result.num_turns : null,
  };
}

function fail(
  code: SummariserErrorCode,
  init: Record<string, unknown> | null,
  messageIds: ReadonlySet<string>,
): ClaudeStreamOutcome {
  return { ok: false, code, summary: summarise(init, messageIds, null) };
}
