import { describe, expect, it } from "vitest";
import { parseClaudeStream } from "./stream.js";

/**
 * Synthetic stream-json transcripts. The shapes follow what the 10-RESEARCH.md experiments saw on
 * CLI 2.1.316; every value is made up (plugin sources use the reserved example.com domain, never a real email).
 */
const MODEL = "claude-haiku-5-5";
const SYNTH_PLUGIN_SOURCE = "synthetic-owner@example.com";
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

// ---------------------------------------------------------------------------------------------
// Task 2: every isolation anomaly and error shape ends in exactly one closed code.
// ---------------------------------------------------------------------------------------------

const SYNTH_TOOL = "SyntheticToolName";
const LEAK_MARKERS = [
  SYNTH_PLUGIN_SOURCE,
  SYNTH_ORG_ID,
  "SYNTHETIC-SIGNATURE-BLOB",
  "A synthetic reply fragment.",
  SYNTH_TOOL,
  "synthetic-secret-token",
  "/tmp/synthetic",
];

/** The outcome as one short string: `ok` or the closed code. */
function codeOf(stdout: string): string {
  const outcome = parseClaudeStream(stdout, { model: MODEL });
  return outcome.ok ? "ok" : outcome.code;
}

const hookEvent = (subtype: string): Json => ({
  type: "system",
  subtype,
  hook_name: "SessionStart:startup",
  session_id: "00000000-0000-4000-8000-000000000001",
});

/** Each case replaces the clean transcript; the key is the test name. */
const REFUSED: ReadonlyArray<readonly [string, () => unknown[]]> = [
  ["a non-empty tools list", () => [init({ tools: [SYNTH_TOOL] }), assistant([TEXT]), result()]],
  [
    "a non-empty mcp_servers list",
    () => [
      init({ mcp_servers: [{ name: SYNTH_TOOL, status: "connected" }] }),
      assistant([TEXT]),
      result(),
    ],
  ],
  [
    "a non-empty slash_commands list",
    () => [init({ slash_commands: [SYNTH_TOOL] }), assistant([TEXT]), result()],
  ],
  ["a non-empty skills list", () => [init({ skills: [SYNTH_TOOL] }), assistant([TEXT]), result()]],
  [
    "a missing tools key",
    () => {
      const { tools: _tools, ...rest } = init();
      return [rest, assistant([TEXT]), result()];
    },
  ],
  [
    "a missing mcp_servers key",
    () => {
      const { mcp_servers: _m, ...rest } = init();
      return [rest, assistant([TEXT]), result()];
    },
  ],
  [
    "a missing plugins key",
    () => {
      const { plugins: _p, ...rest } = init();
      return [rest, assistant([TEXT]), result()];
    },
  ],
  [
    "a plugin whose path is not builtin",
    () => [
      init({
        plugins: [
          { name: "a", path: "builtin", source: SYNTH_PLUGIN_SOURCE },
          { name: "b", path: "/Users/USERNAME/.claude/plugins/b", source: SYNTH_PLUGIN_SOURCE },
        ],
      }),
      assistant([TEXT]),
      result(),
    ],
  ],
  [
    "a non-empty plugin_errors",
    () => [init({ plugin_errors: [{ plugin: SYNTH_TOOL }] }), assistant([TEXT]), result()],
  ],
  [
    "a non-empty mcp_server_errors",
    () => [init({ mcp_server_errors: { [SYNTH_TOOL]: "boom" } }), assistant([TEXT]), result()],
  ],
  [
    "an apiKeySource other than none",
    () => [init({ apiKeySource: "ANTHROPIC_API_KEY" }), assistant([TEXT]), result()],
  ],
  [
    "a missing apiKeySource",
    () => {
      const { apiKeySource: _a, ...rest } = init();
      return [rest, assistant([TEXT]), result()];
    },
  ],
  [
    "a permissionMode other than default",
    () => [init({ permissionMode: "auto" }), assistant([TEXT]), result()],
  ],
  [
    "an init model other than the requested one",
    () => [init({ model: "claude-sonnet-5-5" }), assistant([TEXT]), result()],
  ],
  [
    "an assistant tool_use block",
    () => [
      init(),
      assistant([{ type: "tool_use", id: "tu_1", name: SYNTH_TOOL, input: {} }]),
      result(),
    ],
  ],
  [
    "an assistant block of another unknown type",
    () => [init(), assistant([{ type: "server_tool_use", name: SYNTH_TOOL }]), result()],
  ],
  [
    "an assistant message without an id",
    () => [
      init(),
      { type: "assistant", message: { role: "assistant", content: [TEXT] } },
      result(),
    ],
  ],
  [
    "two distinct assistant message ids",
    () => [init(), assistant([TEXT], "msg_a"), assistant([TEXT], "msg_b"), result()],
  ],
  [
    "a user event",
    () => [
      init(),
      { type: "user", message: { role: "user", content: [] } },
      assistant([TEXT]),
      result(),
    ],
  ],
  [
    "a hook_started system event",
    () => [hookEvent("hook_started"), init(), assistant([TEXT]), result()],
  ],
  [
    "a hook_response system event",
    () => [init(), hookEvent("hook_response"), assistant([TEXT]), result()],
  ],
  [
    "an unknown system subtype",
    () => [init(), { type: "system", subtype: "synthetic_new_thing" }, assistant([TEXT]), result()],
  ],
  [
    "an unknown event type",
    () => [init(), { type: "stream_event", event: {} }, assistant([TEXT]), result()],
  ],
  ["no init event", () => [assistant([TEXT]), result()]],
  ["a second init event", () => [init(), init(), assistant([TEXT]), result()]],
  ["an init after the assistant event", () => [assistant([TEXT]), init(), result()]],
  ["num_turns of 2", () => [init(), assistant([TEXT]), result({ num_turns: 2 })]],
  [
    "a missing num_turns",
    () => {
      const { num_turns: _n, ...rest } = result();
      return [init(), assistant([TEXT]), rest];
    },
  ],
  [
    "a non-empty permission_denials",
    () => [init(), assistant([TEXT]), result({ permission_denials: [{ tool_name: SYNTH_TOOL }] })],
  ],
  [
    "permission_denials on an error result",
    () => [
      init(),
      assistant([TEXT]),
      result({ is_error: true, permission_denials: [{ tool_name: SYNTH_TOOL }] }),
    ],
  ],
  [
    "an anomaly together with a not-logged-in result",
    () => [
      init({ apiKeySource: "ANTHROPIC_API_KEY" }),
      assistant([TEXT]),
      result({ is_error: true, api_error_status: 401, result: "Invalid API key" }),
    ],
  ],
];

describe("parseClaudeStream refuses isolation anomalies (Test 1)", () => {
  it.each(REFUSED)("%s is summariser-refused", (_name, make) => {
    expect(codeOf(ndjson(make()))).toBe("summariser-refused");
  });

  it("reports the counts of what it refused, never the names", () => {
    const outcome = parseClaudeStream(
      ndjson([
        init({
          tools: [SYNTH_TOOL, "Other"],
          mcp_servers: [{ name: SYNTH_TOOL }],
          skills: ["s"],
          slash_commands: ["a", "b", "c"],
          plugins: [{ name: "x", path: "/somewhere", source: SYNTH_PLUGIN_SOURCE }],
          apiKeySource: "ANTHROPIC_API_KEY",
          permissionMode: "auto",
        }),
        assistant([{ type: "tool_use", id: "t1", name: SYNTH_TOOL, input: {} }]),
        result(),
      ]),
      { model: MODEL },
    );
    expect(outcome.ok).toBe(false);
    expect(json({ ...outcome.summary })).toBe(
      json({
        initSeen: true,
        toolCount: 2,
        mcpServerCount: 1,
        slashCommandCount: 3,
        skillCount: 1,
        nonBuiltinPluginCount: 1,
        apiKeySourceIsNone: false,
        permissionModeIsDefault: false,
        assistantMessageCount: 1,
        toolUseCount: 1,
        hookEventCount: 0,
        numTurns: 1,
      }),
    );
  });

  it("counts hook events in the summary of a refusal", () => {
    const outcome = parseClaudeStream(
      ndjson([
        hookEvent("hook_started"),
        hookEvent("hook_response"),
        init(),
        assistant([TEXT]),
        result(),
      ]),
      { model: MODEL },
    );
    expect(outcome.summary.hookEventCount).toBe(2);
  });
});

const FAILED: ReadonlyArray<readonly [string, () => string]> = [
  ["an empty stdout", () => ""],
  ["a whitespace-only stdout", () => "\n  \n"],
  [
    "a non-JSON line",
    () => `${JSON.stringify(init())}\nthis is not json\n${JSON.stringify(result())}\n`,
  ],
  [
    "a JSON line that is not an object",
    () => `${JSON.stringify(init())}\n[1,2]\n${JSON.stringify(result())}\n`,
  ],
  ["a stream with no result", () => ndjson([init(), assistant([TEXT])])],
  ["a stream cut after init", () => ndjson([init()])],
  [
    "a result followed by another event",
    () => ndjson([init(), assistant([TEXT]), result(), rateLimit()]),
  ],
  ["two result events", () => ndjson([init(), assistant([TEXT]), result(), result()])],
  [
    "an error result with a missing is_error",
    () => {
      const { is_error: _e, ...rest } = result();
      return ndjson([init(), assistant([TEXT]), rest]);
    },
  ],
  [
    "a non-success subtype",
    () => ndjson([init(), assistant([TEXT]), result({ subtype: "error_during_execution" })]),
  ],
  [
    "a terminal_reason other than completed",
    () => ndjson([init(), assistant([TEXT]), result({ terminal_reason: "max_turns" })]),
  ],
  [
    "a stop_reason other than end_turn",
    () => ndjson([init(), assistant([TEXT]), result({ stop_reason: "max_tokens" })]),
  ],
  [
    "a 404 bad-model error",
    () =>
      ndjson([
        init(),
        assistant([TEXT]),
        result({
          is_error: true,
          api_error_status: 404,
          terminal_reason: "api_error",
          result: "There's an issue with the selected model (claude-nonexistent-9-9).",
        }),
      ]),
  ],
  [
    "a usage-limit error",
    () =>
      ndjson([
        init(),
        assistant([TEXT]),
        result({ is_error: true, api_error_status: null, result: "You've hit your weekly limit" }),
      ]),
  ],
  [
    "an error whose text only contains the not-logged-in words",
    () =>
      ndjson([
        init(),
        assistant([TEXT]),
        result({ is_error: true, api_error_status: 500, result: "Oops: Not logged in" }),
      ]),
  ],
  [
    "an error result with no text and no status",
    () => ndjson([init(), assistant([TEXT]), result({ is_error: true, result: undefined })]),
  ],
];

const UNCONFIGURED: ReadonlyArray<readonly [string, () => string]> = [
  [
    "a Not logged in result under a success subtype",
    () =>
      ndjson([
        init(),
        assistant([{ type: "text", text: "Not logged in · Please run /login" }]),
        result({
          is_error: true,
          api_error_status: null,
          terminal_reason: "api_error",
          result: "Not logged in · Please run /login",
        }),
      ]),
  ],
  [
    "an api_error_status of 401",
    () =>
      ndjson([
        init(),
        assistant([TEXT]),
        result({
          is_error: true,
          api_error_status: 401,
          terminal_reason: "api_error",
          result: "Failed to authenticate. API Error: 401",
        }),
      ]),
  ],
];

const INVALID: ReadonlyArray<readonly [string, () => string]> = [
  ["an empty result text", () => ndjson([init(), assistant([TEXT]), result({ result: "" })])],
  [
    "a whitespace result text",
    () => ndjson([init(), assistant([TEXT]), result({ result: " \n\t " })]),
  ],
  [
    "a non-string result text",
    () => ndjson([init(), assistant([TEXT]), result({ result: { a: 1 } })]),
  ],
  [
    "a missing result text",
    () => {
      const { result: _r, ...rest } = result();
      return ndjson([init(), assistant([TEXT]), rest]);
    },
  ],
];

describe("parseClaudeStream classifies errors and framing (Test 2)", () => {
  it.each(FAILED)("%s is summariser-failed", (_name, make) => {
    expect(codeOf(make())).toBe("summariser-failed");
  });

  it.each(UNCONFIGURED)("%s is summariser-unconfigured", (_name, make) => {
    expect(codeOf(make())).toBe("summariser-unconfigured");
  });

  it.each(INVALID)("%s is summariser-invalid-output", (_name, make) => {
    expect(codeOf(make())).toBe("summariser-invalid-output");
  });

  it("reads is_error before the subtype: a success subtype with is_error never yields text", () => {
    const outcome = parseClaudeStream(
      ndjson([
        init(),
        assistant([TEXT]),
        result({ subtype: "success", is_error: true, result: "boom" }),
      ]),
      { model: MODEL },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("parseClaudeStream carries nothing out (Test 3)", () => {
  /** Every hostile stream, with the synthetic markers also planted in unknown members. */
  const ALL: ReadonlyArray<readonly [string, string]> = [
    ...REFUSED.map(([n, make]) => [n, ndjson(make())] as const),
    ...FAILED.map(([n, make]) => [n, make()] as const),
    ...UNCONFIGURED.map(([n, make]) => [n, make()] as const),
    ...INVALID.map(([n, make]) => [n, make()] as const),
  ];

  it.each(ALL)("the outcome for %s holds no stream text", (_name, stdout) => {
    const planted = stdout.replaceAll(
      '"type":"system","subtype":"init"',
      '"type":"system","subtype":"init","account_email":"synthetic-owner@example.com","note":"synthetic-secret-token"',
    );
    for (const text of [stdout, planted]) {
      const outcome = parseClaudeStream(text, { model: MODEL });
      if (outcome.ok) continue;
      const serialised = JSON.stringify(outcome);
      for (const marker of LEAK_MARKERS) expect(serialised).not.toContain(marker);
      expect(Object.keys(outcome).sort().join(",")).toBe("code,ok,summary");
    }
  });

  it("a successful outcome has the result text and a summary with no stream text", () => {
    const outcome = parseClaudeStream(ndjson(clean()), { model: MODEL });
    expect(outcome.ok).toBe(true);
    expect(Object.keys(outcome).sort().join(",")).toBe("ok,summary,text");
    const summary = JSON.stringify(outcome.summary);
    for (const marker of LEAK_MARKERS) expect(summary).not.toContain(marker);
    // Only counts and booleans: no string value anywhere in the summary.
    for (const value of Object.values(outcome.summary)) {
      expect(["number", "boolean", "object"]).toContain(typeof value);
    }
  });

  it("never throws on a hostile stream, whatever the line holds", () => {
    for (const stdout of ["\0", "{", "null", "[]", '{"type":1}', '"x"', "{}\n{}\n"]) {
      expect(() => parseClaudeStream(stdout, { model: MODEL })).not.toThrow();
      expect(codeOf(stdout)).not.toBe("ok");
    }
  });
});

describe("parseClaudeStream tolerates benign variation (Test 4)", () => {
  it("accepts an api_retry system event", () => {
    const events = [
      init(),
      { type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: 500 },
      assistant([THINKING]),
      assistant([TEXT]),
      result(),
    ];
    expect(codeOf(ndjson(events))).toBe("ok");
  });

  it("accepts unknown members on init, assistant and result, and unknown members are never copied out", () => {
    const events = [
      init({ future_member: { a: 1 }, plugin_errors: [], mcp_server_errors: [] }),
      assistant([TEXT], "msg_synthetic_1", { future_member: "synthetic-secret-token" }),
      result({ future_member: "synthetic-secret-token", usage: { input_tokens: 5 } }),
    ];
    const outcome = parseClaudeStream(ndjson(events), { model: MODEL });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("synthetic-secret-token");
  });

  it("accepts 4 or 6 built-in agents and an absent terminal_reason and stop_reason", () => {
    for (const agents of [
      ["claude", "Explore", "general-purpose", "Plan"],
      ["claude", "Explore", "general-purpose", "Plan", "statusline-setup", "web-fetch"],
    ]) {
      const { terminal_reason: _t, stop_reason: _s, ...rest } = result();
      expect(codeOf(ndjson([init({ agents }), assistant([TEXT]), rest]))).toBe("ok");
    }
  });

  it("accepts a blank line, CRLF line ends and no trailing newline", () => {
    const body = clean()
      .map((e) => JSON.stringify(e))
      .join("\r\n\r\n");
    expect(codeOf(body)).toBe("ok");
  });

  it("accepts a stream with no assistant event at all (the result carries the text)", () => {
    expect(codeOf(ndjson([init(), result()]))).toBe("ok");
  });

  it("returns the result text untrimmed", () => {
    const outcome = parseClaudeStream(
      ndjson([init(), assistant([TEXT]), result({ result: `  ${REPLY}\n` })]),
      {
        model: MODEL,
      },
    );
    expect(outcome.ok && outcome.text).toBe(`  ${REPLY}\n`);
  });

  it("counts distinct assistant message ids, not events", () => {
    const outcome = parseClaudeStream(
      ndjson([init(), assistant([THINKING], "m1"), assistant([TEXT], "m1"), result()]),
      { model: MODEL },
    );
    expect(outcome.ok && outcome.summary.assistantMessageCount).toBe(1);
  });
});
