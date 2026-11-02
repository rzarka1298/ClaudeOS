import { describe, expect, it } from "vitest";
import { parseClaudeStream } from "./stream.js";

/**
 * Synthetic stream-json transcripts. The shapes follow what the 10-RESEARCH.md experiments saw on
 * CLI 2.1.316; every value is made up (plugin sources are `example.invalid`, never a real email).
 */
const MODEL = "claude-haiku-5-5";
const SYNTH_PLUGIN_SOURCE = "synthetic-owner@example.invalid";
const SYNTH_ORG_ID = "org-00000000-synthetic";
const REPLY = '{"summaries":[{"sourceId":"s1","text":"A synthetic reply fragment."}]}';

type Json = Record<string, unknown>;

function init(over: Json = {}): Json {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp/synthetic",
    session_id: "00000000-0000-4000-8000-000000000001",
    tools: [],
    mcp_servers: [],
    model: MODEL,
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.316",
    output_style: "default",
    agents: ["claude", "Explore", "general-purpose", "Plan"],
    skills: [],
    plugins: [
      { name: "builtin-a", path: "builtin", source: SYNTH_PLUGIN_SOURCE },
      { name: "builtin-b", path: "builtin", source: SYNTH_PLUGIN_SOURCE },
      { name: "builtin-c", path: "builtin", source: SYNTH_PLUGIN_SOURCE },
    ],
    organization_id: SYNTH_ORG_ID,
    uuid: "00000000-0000-4000-8000-000000000002",
    ...over,
  };
}

function assistant(blocks: Json[], id = "msg_synthetic_1", over: Json = {}): Json {
  return {
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: MODEL, content: blocks, ...over },
    session_id: "00000000-0000-4000-8000-000000000001",
    uuid: "00000000-0000-4000-8000-000000000003",
  };
}

const THINKING: Json = { type: "thinking", thinking: "", signature: "SYNTHETIC-SIGNATURE-BLOB" };
const TEXT: Json = { type: "text", text: REPLY };

function rateLimit(): Json {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.1 },
    uuid: "00000000-0000-4000-8000-000000000004",
  };
}

function result(over: Json = {}): Json {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 1234,
    num_turns: 1,
    result: REPLY,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    total_cost_usd: 0.001,
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000005",
    ...over,
  };
}

/** One-line comparison: a failure prints a single-line diff, which the RED classifier can read. */
const json = (value: unknown): string => JSON.stringify(value);

function ndjson(events: readonly unknown[]): string {
  return `${events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n")}\n`;
}

/** The clean transcript: init, one assistant message split over two events, a rate-limit event, result. */
function clean(): Json[] {
  return [init(), assistant([THINKING]), assistant([TEXT]), rateLimit(), result()];
}

describe("parseClaudeStream tracer (Test 3)", () => {
  it("turns the canned clean transcript into the result text with all-zero isolation counts", () => {
    const outcome = parseClaudeStream(ndjson(clean()), { model: MODEL });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(REPLY);
    expect(json(outcome.summary)).toBe(
      json({
        initSeen: true,
        toolCount: 0,
        mcpServerCount: 0,
        slashCommandCount: 0,
        skillCount: 0,
        nonBuiltinPluginCount: 0,
        apiKeySourceIsNone: true,
        permissionModeIsDefault: true,
        assistantMessageCount: 1,
        toolUseCount: 0,
        hookEventCount: 0,
        numTurns: 1,
      }),
    );
  });
});
