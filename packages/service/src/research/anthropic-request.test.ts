import { SUMMARISER_MODELS } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  AnthropicRequestSchema,
  buildAnthropicRequest,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_LIMIT,
  MIN_TOKENS_LIMIT,
  parseAnthropicResponse,
  SYSTEM_MAX_CHARS,
  THINKING_BY_MODEL,
  USER_CONTENT_MAX_CHARS,
} from "./anthropic-request.js";
import { SummariserError } from "./summariser-error.js";

const FORBIDDEN_KEYS = [
  "tools",
  "tool_choice",
  "mcp_servers",
  "container",
  "betas",
  "fallbacks",
  "stop_sequences",
  "temperature",
  "metadata",
  "stream",
] as const;

function build(model: (typeof SUMMARISER_MODELS)[number], maxTokens?: number) {
  return buildAnthropicRequest({
    model,
    instructions: "Summarise the delimited blocks.",
    input: "<blocks>",
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
}

describe("Test 2: the serialised body has exactly five keys", () => {
  for (const model of SUMMARISER_MODELS) {
    it(`${model}: key set, one user message, per-model thinking`, () => {
      const body = JSON.parse(JSON.stringify(build(model))) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        ["max_tokens", "messages", "model", "system", "thinking"].sort(),
      );
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
      expect(body.system).toBe("Summarise the delimited blocks.");
      expect(body.messages).toEqual([{ role: "user", content: "<blocks>" }]);
      expect(body.thinking).toEqual(THINKING_BY_MODEL[model]);
    });
  }

  it("Haiku 5.5 sends disabled and Sonnet 5.5 sends between_tools with no other field", () => {
    expect(build("claude-haiku-5-5").thinking).toEqual({ type: "disabled" });
    expect(build("claude-sonnet-5-5").thinking).toEqual({ type: "between_tools" });
    expect(Object.keys(build("claude-sonnet-5-5").thinking)).toEqual(["type"]);
  });

  it("the model set is exactly Haiku 5.5 and Sonnet 5.5 (Opus cannot disable thinking)", () => {
    expect([...SUMMARISER_MODELS]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(Object.keys(THINKING_BY_MODEL).sort()).toEqual([...SUMMARISER_MODELS].sort());
  });

  it("the schema pairs each model with its own thinking value only", () => {
    const base = build("claude-haiku-5-5");
    expect(AnthropicRequestSchema.safeParse(base).success).toBe(true);
    expect(
      AnthropicRequestSchema.safeParse({ ...base, thinking: { type: "between_tools" } }).success,
    ).toBe(false);
    const sonnet = build("claude-sonnet-5-5");
    expect(
      AnthropicRequestSchema.safeParse({ ...sonnet, thinking: { type: "disabled" } }).success,
    ).toBe(false);
    expect(
      AnthropicRequestSchema.safeParse({
        ...base,
        thinking: { type: "enabled", budget_tokens: 2048 },
      }).success,
    ).toBe(false);
    expect(
      AnthropicRequestSchema.safeParse({ ...base, thinking: { type: "disabled", extra: 1 } })
        .success,
    ).toBe(false);
  });

  for (const key of FORBIDDEN_KEYS) {
    it(`the schema rejects an added ${key}`, () => {
      const base = build("claude-haiku-5-5");
      expect(AnthropicRequestSchema.safeParse({ ...base, [key]: [] }).success).toBe(false);
      expect(AnthropicRequestSchema.safeParse({ ...base, [key]: {} }).success).toBe(false);
      expect(AnthropicRequestSchema.safeParse({ ...base, [key]: "x" }).success).toBe(false);
    });
  }

  it("the schema rejects extra keys on the message, a second message and an assistant prefill", () => {
    const base = build("claude-haiku-5-5");
    const message = { role: "user", content: "x" };
    expect(
      AnthropicRequestSchema.safeParse({
        ...base,
        messages: [{ ...message, cache_control: { type: "ephemeral" } }],
      }).success,
    ).toBe(false);
    expect(
      AnthropicRequestSchema.safeParse({
        ...base,
        messages: [message, { role: "assistant", content: "{" }],
      }).success,
    ).toBe(false);
    expect(
      AnthropicRequestSchema.safeParse({ ...base, messages: [{ role: "assistant", content: "{" }] })
        .success,
    ).toBe(false);
    expect(AnthropicRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
    expect(
      AnthropicRequestSchema.safeParse({ ...base, messages: [{ role: "user", content: [] }] })
        .success,
    ).toBe(false);
  });

  it("buildAnthropicRequest takes no key beyond its four named inputs", () => {
    const hostile = {
      model: "claude-haiku-5-5",
      instructions: "i",
      input: "x",
      tools: [{ name: "web_search" }],
      mcp_servers: [{ url: "https://example.com" }],
    } as unknown as Parameters<typeof buildAnthropicRequest>[0];
    const body = JSON.parse(JSON.stringify(buildAnthropicRequest(hostile))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "system", "thinking"].sort(),
    );
  });

  it("an unknown model never reaches a body", () => {
    for (const model of ["claude-opus-5-5", "claude-haiku-4-5", "", "CLAUDE-HAIKU-5-5"]) {
      expect(() =>
        buildAnthropicRequest({
          model: model as never,
          instructions: "i",
          input: "x",
        }),
      ).toThrow(SummariserError);
    }
  });
});

describe("Test 3: bounds are checked before any request", () => {
  it("max_tokens is 1024 to 16000, default 8192", () => {
    expect(MIN_TOKENS_LIMIT).toBe(1024);
    expect(MAX_TOKENS_LIMIT).toBe(16000);
    expect(DEFAULT_MAX_TOKENS).toBe(8192);
    expect(build("claude-haiku-5-5", 1024).max_tokens).toBe(1024);
    expect(build("claude-haiku-5-5", 16000).max_tokens).toBe(16000);
    for (const bad of [0, 1023, 16001, 1e9, -1, 1500.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => build("claude-haiku-5-5", bad)).toThrow(SummariserError);
    }
  });

  it("system is at most 8,000 characters and not empty", () => {
    expect(SYSTEM_MAX_CHARS).toBe(8000);
    const ok = buildAnthropicRequest({
      model: "claude-haiku-5-5",
      instructions: "s".repeat(8000),
      input: "x",
    });
    expect(ok.system.length).toBe(8000);
    for (const instructions of ["s".repeat(8001), ""]) {
      expect(() =>
        buildAnthropicRequest({ model: "claude-haiku-5-5", instructions, input: "x" }),
      ).toThrow(SummariserError);
    }
  });

  it("user content is at most 400,000 characters and not empty", () => {
    expect(USER_CONTENT_MAX_CHARS).toBe(400_000);
    const ok = buildAnthropicRequest({
      model: "claude-haiku-5-5",
      instructions: "i",
      input: "u".repeat(400_000),
    });
    expect(ok.messages[0].content.length).toBe(400_000);
    for (const input of ["u".repeat(400_001), ""]) {
      expect(() =>
        buildAnthropicRequest({ model: "claude-haiku-5-5", instructions: "i", input }),
      ).toThrow(SummariserError);
    }
  });

  it("non-string text is refused", () => {
    expect(() =>
      buildAnthropicRequest({
        model: "claude-haiku-5-5",
        instructions: 5 as never,
        input: "x",
      }),
    ).toThrow(SummariserError);
    expect(() =>
      buildAnthropicRequest({
        model: "claude-haiku-5-5",
        instructions: "i",
        input: { toString: () => "x" } as never,
      }),
    ).toThrow(SummariserError);
  });

  it("a refusal carries a run error code and no input text", () => {
    try {
      buildAnthropicRequest({
        model: "claude-haiku-5-5",
        instructions: "i",
        input: `SECRET-INPUT-${"u".repeat(400_001)}`,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SummariserError);
      const failure = error as SummariserError;
      expect(failure.code).toBe("summariser-failed");
      expect(failure.message).not.toContain("SECRET-INPUT");
      expect(JSON.stringify(failure)).not.toContain("SECRET-INPUT");
    }
  });
});

describe("Task 2 Test 1: stop reasons", () => {
  const text = [{ type: "text", text: "hello" }];
  function reply(stopReason: unknown, content: unknown = text): unknown {
    return { id: "m", type: "message", role: "assistant", content, stop_reason: stopReason };
  }
  function codeOf(value: unknown): string {
    try {
      parseAnthropicResponse(value);
    } catch (error) {
      if (error instanceof SummariserError) return error.code;
      throw error;
    }
    return "ok";
  }

  it("end_turn with text is the only success", () => {
    expect(parseAnthropicResponse(reply("end_turn"))).toBe("hello");
  });

  it("max_tokens is summariser-failed and refusal is summariser-refused", () => {
    expect(codeOf(reply("max_tokens"))).toBe("summariser-failed");
    expect(codeOf(reply("refusal", []))).toBe("summariser-refused");
    expect(codeOf(reply("refusal"))).toBe("summariser-refused");
  });

  it("every other reason is summariser-invalid-output", () => {
    for (const reason of [
      "tool_use",
      "pause_turn",
      "stop_sequence",
      "model_context_window_exceeded",
      "something_new",
      "",
      null,
      undefined,
      5,
      {},
      ["end_turn"],
      "END_TURN",
    ]) {
      expect(codeOf(reply(reason)), String(reason)).toBe("summariser-invalid-output");
    }
  });

  it("a reply that is not an object with a content array is invalid", () => {
    for (const value of [null, undefined, "x", 5, [], { stop_reason: "end_turn" }]) {
      expect(codeOf(value)).toBe("summariser-invalid-output");
    }
    expect(codeOf({ stop_reason: "end_turn", content: "text" })).toBe("summariser-invalid-output");
    expect(codeOf({ stop_reason: "end_turn", content: { 0: text[0], length: 1 } })).toBe(
      "summariser-invalid-output",
    );
  });
});

describe("Task 2 Test 2: blocks", () => {
  function codeOf(content: unknown, extra: Record<string, unknown> = {}): string {
    try {
      parseAnthropicResponse({ stop_reason: "end_turn", content, ...extra });
    } catch (error) {
      if (error instanceof SummariserError) return error.code;
      throw error;
    }
    return "ok";
  }

  for (const type of [
    "tool_use",
    "server_tool_use",
    "mcp_tool_use",
    "mcp_tool_result",
    "web_search_tool_result",
    "code_execution_tool_result",
    "thinking",
    "redacted_thinking",
    "fallback",
    "image",
    "Text",
    "text ",
    "",
  ]) {
    it(`a ${JSON.stringify(type)} block makes the reply invalid, alone or beside text`, () => {
      const block = { type, text: "x", name: "web_search", input: {}, thinking: "x" };
      expect(codeOf([block])).toBe("summariser-invalid-output");
      expect(codeOf([{ type: "text", text: "fine" }, block])).toBe("summariser-invalid-output");
      expect(codeOf([block, { type: "text", text: "fine" }])).toBe("summariser-invalid-output");
    });
  }

  it("an empty content array, an empty text, a missing text and a non-string text are invalid", () => {
    expect(codeOf([])).toBe("summariser-invalid-output");
    expect(codeOf([{ type: "text", text: "" }])).toBe("summariser-invalid-output");
    expect(codeOf([{ type: "text", text: "   \n" }])).toBe("summariser-invalid-output");
    expect(codeOf([{ type: "text" }])).toBe("summariser-invalid-output");
    expect(codeOf([{ type: "text", text: 5 }])).toBe("summariser-invalid-output");
    expect(codeOf([null])).toBe("summariser-invalid-output");
    expect(codeOf(["text"])).toBe("summariser-invalid-output");
    expect(codeOf([[{ type: "text", text: "x" }]])).toBe("summariser-invalid-output");
  });

  it("extra keys on the message and on a text block are tolerated (A12)", () => {
    expect(
      parseAnthropicResponse({
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1 },
        container: null,
        content: [{ type: "text", text: "hello", citations: null }],
      }),
    ).toBe("hello");
  });

  it("several text blocks are joined in order", () => {
    expect(
      parseAnthropicResponse({
        stop_reason: "end_turn",
        content: [
          { type: "text", text: '{"items":' },
          { type: "text", text: "[]}" },
        ],
      }),
    ).toBe('{"items":[]}');
  });
});
