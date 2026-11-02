import { z } from "zod";
import type { SummariserErrorCode } from "../research/summariser-error.js";

/**
 * The strict stream-json parser of the subscription summariser (plan 10-02, D-02, D-05, D-08).
 *
 * The child's stdout is untrusted, the init event included. The parser reads it as NDJSON,
 * refuses every isolation anomaly the research observed, and lets out one thing only: the result
 * text. Nothing else the stream carries (the init event, a plugin source, an account identifier,
 * a model reply fragment, a thinking signature, an error message) is copied into the outcome or
 * into any error: an outcome holds a closed code and a summary of counts and booleans (D-09,
 * T-10-04). Pure: no process module, no file system, no clock.
 *
 * Order of decisions, each ending in exactly one closed code:
 *
 * 1. Framing: every non-blank line must be a JSON object, else `summariser-failed`.
 * 2. Anomalies, `summariser-refused`: an event type or system subtype outside the allowlist
 *    (hook events included), a missing, repeated or late init, any tool, MCP server, slash
 *    command or skill, a plugin whose path is not `builtin`, a plugin or MCP error, an
 *    `apiKeySource` other than `none`, a `permissionMode` other than `default`, another model than
 *    the requested one, an assistant block that is not `text` or `thinking`, more than one distinct
 *    assistant message id, or a non-empty `permission_denials`.
 * 3. Result framing, `summariser-failed`: exactly one `result`, and it is the last event.
 * 4. The result: `is_error` is read BEFORE `subtype` (the CLI reports `subtype: "success"` on
 *    errors). `Not logged in` or HTTP 401 is `summariser-unconfigured`, any other error
 *    `summariser-failed`. A successful result must have `num_turns` 1 (else refused) and no
 *    contradicting subtype, terminal or stop reason (else failed); an empty or missing text is
 *    `summariser-invalid-output`.
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

/** The closed literal the CLI's signed-out result begins with; compared, never stored. */
const NOT_LOGGED_IN_PREFIX = "Not logged in";

/**
 * Event shapes. The CLI adds members across versions, so every object is loose (unknown members
 * pass the schema and are never read); only the members the gates need are typed.
 */
const InitSchema = z.looseObject({
  tools: z.array(z.unknown()),
  mcp_servers: z.array(z.unknown()),
  slash_commands: z.array(z.unknown()),
  skills: z.array(z.unknown()),
  plugins: z.array(z.looseObject({ path: z.string() })),
  plugin_errors: z.unknown().optional(),
  mcp_server_errors: z.unknown().optional(),
  apiKeySource: z.string(),
  permissionMode: z.string(),
  model: z.string(),
});
type Init = z.infer<typeof InitSchema>;

const AssistantSchema = z.looseObject({
  message: z.looseObject({
    id: z.string().min(1),
    content: z.array(z.looseObject({ type: z.string() })),
  }),
});

const ResultSchema = z.looseObject({
  is_error: z.boolean(),
  subtype: z.unknown().optional(),
  api_error_status: z.unknown().optional(),
  num_turns: z.unknown().optional(),
  result: z.unknown().optional(),
  stop_reason: z.unknown().optional(),
  terminal_reason: z.unknown().optional(),
  permission_denials: z.unknown().optional(),
});

/** Absent and an empty array are both "none"; anything else counts as present. */
function isPresent(value: unknown): boolean {
  if (value === undefined) return false;
  return !(Array.isArray(value) && value.length === 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Tally {
  init: Init | null;
  initMalformed: boolean;
  initCount: number;
  messageIds: Set<string>;
  toolUseCount: number;
  hookEventCount: number;
  numTurns: number | null;
}

function summarise(tally: Tally): ClaudeStreamSummary {
  const init = tally.init;
  return {
    initSeen: tally.initCount > 0,
    toolCount: init?.tools.length ?? 0,
    mcpServerCount: init?.mcp_servers.length ?? 0,
    slashCommandCount: init?.slash_commands.length ?? 0,
    skillCount: init?.skills.length ?? 0,
    nonBuiltinPluginCount: init?.plugins.filter((p) => p.path !== "builtin").length ?? 0,
    apiKeySourceIsNone: init?.apiKeySource === "none",
    permissionModeIsDefault: init?.permissionMode === "default",
    assistantMessageCount: tally.messageIds.size,
    toolUseCount: tally.toolUseCount,
    hookEventCount: tally.hookEventCount,
    numTurns: tally.numTurns,
  };
}

export function parseClaudeStream(
  stdout: string,
  opts: { readonly model: string },
): ClaudeStreamOutcome {
  const tally: Tally = {
    init: null,
    initMalformed: false,
    initCount: 0,
    messageIds: new Set(),
    toolUseCount: 0,
    hookEventCount: 0,
    numTurns: null,
  };
  const fail = (code: SummariserErrorCode): ClaudeStreamOutcome => ({
    ok: false,
    code,
    summary: summarise(tally),
  });

  // 1. Framing.
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail("summariser-failed");
    }
    if (!isObject(parsed)) return fail("summariser-failed");
    events.push(parsed);
  }
  if (events.length === 0) return fail("summariser-failed");

  // 2. Anomalies: every event is checked against the allowlist; nothing unknown is ignored.
  let anomaly = false;
  let resultIndex = -1;
  let resultCount = 0;
  let resultEvent: Record<string, unknown> | null = null;
  let assistantSeen = false;
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          tally.initCount += 1;
          if (tally.initCount > 1 || assistantSeen) anomaly = true;
          const parsedInit = InitSchema.safeParse(event);
          if (parsedInit.success) {
            if (tally.init === null) tally.init = parsedInit.data;
          } else {
            tally.initMalformed = true;
          }
        } else if (event.subtype === "api_retry") {
          // Benign: the CLI retried a request.
        } else {
          if (typeof event.subtype === "string" && event.subtype.startsWith("hook")) {
            tally.hookEventCount += 1;
          }
          anomaly = true;
        }
        break;
      }
      case "assistant": {
        assistantSeen = true;
        const parsedAssistant = AssistantSchema.safeParse(event);
        if (!parsedAssistant.success) {
          anomaly = true;
          break;
        }
        tally.messageIds.add(parsedAssistant.data.message.id);
        for (const block of parsedAssistant.data.message.content) {
          if (block.type === "tool_use") tally.toolUseCount += 1;
          if (block.type !== "text" && block.type !== "thinking") anomaly = true;
        }
        break;
      }
      case "rate_limit_event":
        break;
      case "result":
        resultCount += 1;
        resultIndex = index;
        resultEvent = event;
        break;
      default:
        // A `user` event, a partial-message stream event, a type from a newer CLI: refused.
        anomaly = true;
    }
  }
  if (tally.initCount === 0 || tally.init === null || tally.initMalformed) anomaly = true;
  const init = tally.init;
  if (init !== null) {
    if (init.tools.length > 0) anomaly = true;
    if (init.mcp_servers.length > 0) anomaly = true;
    if (init.slash_commands.length > 0) anomaly = true;
    if (init.skills.length > 0) anomaly = true;
    if (init.plugins.some((p) => p.path !== "builtin")) anomaly = true;
    if (isPresent(init.plugin_errors) || isPresent(init.mcp_server_errors)) anomaly = true;
    if (init.apiKeySource !== "none") anomaly = true;
    if (init.permissionMode !== "default") anomaly = true;
    if (init.model !== opts.model) anomaly = true;
  }
  if (tally.messageIds.size > 1) anomaly = true;

  // The result's own numbers feed the summary and one gate even when the result is malformed.
  const parsedResult = resultEvent === null ? null : ResultSchema.safeParse(resultEvent);
  if (resultEvent !== null) {
    const turns = resultEvent.num_turns;
    tally.numTurns = typeof turns === "number" && Number.isFinite(turns) ? turns : null;
    if (isPresent(resultEvent.permission_denials)) anomaly = true;
  }
  if (anomaly) return fail("summariser-refused");

  // 3. Result framing.
  if (resultCount !== 1 || resultIndex !== events.length - 1) return fail("summariser-failed");
  if (parsedResult === null || !parsedResult.success) return fail("summariser-failed");
  const res = parsedResult.data;

  // 4. The result. `is_error` first: the subtype is "success" even on an error.
  if (res.is_error) {
    const status = res.api_error_status;
    const text = typeof res.result === "string" ? res.result : "";
    if (status === 401 || text.startsWith(NOT_LOGGED_IN_PREFIX)) {
      return fail("summariser-unconfigured");
    }
    return fail("summariser-failed");
  }
  if (tally.numTurns !== 1) return fail("summariser-refused");
  if (res.subtype !== "success") return fail("summariser-failed");
  if (res.terminal_reason !== undefined && res.terminal_reason !== "completed") {
    return fail("summariser-failed");
  }
  if (res.stop_reason !== undefined && res.stop_reason !== "end_turn") {
    return fail("summariser-failed");
  }
  if (typeof res.result !== "string" || res.result.trim() === "") {
    return fail("summariser-invalid-output");
  }
  return { ok: true, text: res.result, summary: summarise(tally) };
}
