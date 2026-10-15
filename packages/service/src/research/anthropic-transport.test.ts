import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ERROR_CODES } from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logging.js";
import { createAnthropicTransport } from "./anthropic-transport.js";
import { RESEARCH_API_KEY_ACCOUNT } from "./research-key.js";
import { SummariserError } from "./summariser-error.js";
import {
  type AnthropicScript,
  createFakeAnthropic,
  messageReply,
  textReply,
} from "./test-support/fake-anthropic.js";

const DUMMY_KEY = "test-key-not-real";
const ALLOWED_HEADERS = [
  "accept",
  "accept-encoding",
  "anthropic-version",
  "content-length",
  "content-type",
  "x-api-key",
];

describe("Test 1 (tracer): one call travels from the port to an injected request and back as text", () => {
  it("posts one tool-free body to api.anthropic.com and returns the text block", async () => {
    const fake = createFakeAnthropic(() => textReply('{"items":[]}'));
    const transport = createAnthropicTransport({
      readApiKey: async () => DUMMY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    const text = await transport.complete({ instructions: "do it", input: "the input" });
    expect(text).toBe('{"items":[]}');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    if (call === undefined) throw new Error("no call");
    expect(call.options.protocol).toBe("https:");
    expect(call.options.hostname).toBe("api.anthropic.com");
    expect(call.options.port).toBe(443);
    expect(call.options.path).toBe("/v1/messages");
    expect(call.options.method).toBe("POST");
    expect(call.options.headers["x-api-key"]).toBe(DUMMY_KEY);
    expect(call.options.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.options.headers["content-type"]).toBe("application/json");
    expect(call.options.headers["accept-encoding"]).toBe("identity");
    expect(Object.keys(call.options.headers).sort()).toEqual(ALLOWED_HEADERS);
    expect(call.options.headers["content-length"]).toBe(
      String(Buffer.byteLength(call.body ?? "", "utf8")),
    );
    const body = JSON.parse(call.body ?? "null") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "system", "thinking"].sort(),
    );
    expect(body.messages).toEqual([{ role: "user", content: "the input" }]);
    expect(body.system).toBe("do it");
  });

  it("the body of each model has exactly the five keys and its own thinking value", async () => {
    for (const [model, thinking] of [
      ["claude-haiku-5-5", { type: "disabled" }],
      ["claude-sonnet-5-5", { type: "between_tools" }],
    ] as const) {
      const fake = createFakeAnthropic(() => textReply("ok"));
      const transport = createAnthropicTransport({
        readApiKey: async () => DUMMY_KEY,
        model,
        request: fake.request,
        log: () => undefined,
      });
      await transport.complete({ instructions: "i", input: "x" });
      const body = JSON.parse(fake.calls[0]?.body ?? "null") as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        ["max_tokens", "messages", "model", "system", "thinking"].sort(),
      );
      expect(body.model).toBe(model);
      expect(body.thinking).toEqual(thinking);
    }
  });

  it("uses an https request with a keep-alive-free agent, a signal and a timeout", async () => {
    const fake = createFakeAnthropic(() => textReply("ok"));
    const transport = createAnthropicTransport({
      readApiKey: async () => DUMMY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await transport.complete({ instructions: "i", input: "x" });
    const options = fake.calls[0]?.options;
    expect(options?.agent.options.keepAlive).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBe(120_000);
  });

  it("an oversized input throws before the key is read or any request is made", async () => {
    const fake = createFakeAnthropic(() => textReply("ok"));
    let keyReads = 0;
    const transport = createAnthropicTransport({
      readApiKey: async () => {
        keyReads += 1;
        return DUMMY_KEY;
      },
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await expect(
      transport.complete({ instructions: "i", input: "u".repeat(400_001) }),
    ).rejects.toBeInstanceOf(SummariserError);
    expect(fake.calls).toHaveLength(0);
    expect(keyReads).toBe(0);
  });
});

describe("the key is read on every call and never kept", () => {
  it("reads the closure once per call", async () => {
    const fake = createFakeAnthropic(() => textReply("ok"));
    const keys = ["first-dummy-key", "second-dummy-key"];
    let reads = 0;
    const transport = createAnthropicTransport({
      readApiKey: async () => keys[reads++] ?? null,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await transport.complete({ instructions: "i", input: "x" });
    await transport.complete({ instructions: "i", input: "x" });
    expect(reads).toBe(2);
    expect(fake.calls.map((c) => c.options.headers["x-api-key"])).toEqual(keys);
  });
});

describe("Test 4: no key", () => {
  it("rejects with summariser-unconfigured and never calls the request", async () => {
    const fake = createFakeAnthropic(() => textReply("ok"));
    const transport = createAnthropicTransport({
      readApiKey: async () => null,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    const error = await transport.complete({ instructions: "i", input: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SummariserError);
    expect((error as SummariserError).code).toBe("summariser-unconfigured");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the account and the codes", () => {
  it("the Keychain account is the fixed research account", () => {
    expect(RESEARCH_API_KEY_ACCOUNT).toBe("anthropic-api-key");
    expect(RESEARCH_API_KEY_ACCOUNT).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("the summariser error codes are run error codes", () => {
    for (const code of [
      "summariser-unconfigured",
      "summariser-failed",
      "summariser-refused",
      "summariser-invalid-output",
    ] as const) {
      expect(RUN_ERROR_CODES).toContain(code);
      expect(new SummariserError(code).code).toBe(code);
    }
  });
});

// ---- Task 2: every abnormal reply is one closed failure code, and the key never leaks ----

const CANARY_KEY = "canary-research-key-0000";

async function codeOfCall(
  script: AnthropicScript,
  options: { readApiKey?: () => Promise<string | null> } = {},
): Promise<{ code: string; calls: number; error: unknown }> {
  const fake = createFakeAnthropic(() => script);
  const transport = createAnthropicTransport({
    readApiKey: options.readApiKey ?? (async () => CANARY_KEY),
    model: "claude-haiku-5-5",
    request: fake.request,
    log: () => undefined,
  });
  try {
    await transport.complete({ instructions: "i", input: "x" });
    return { code: "ok", calls: fake.calls.length, error: null };
  } catch (error) {
    if (error instanceof SummariserError) {
      return { code: error.code, calls: fake.calls.length, error };
    }
    throw error;
  }
}

describe("Task 2 Test 1: stop reasons through the transport", () => {
  const text = [{ type: "text", text: "hello" }];
  const cases: [string | null, string][] = [
    ["max_tokens", "summariser-failed"],
    ["refusal", "summariser-refused"],
    ["tool_use", "summariser-invalid-output"],
    ["pause_turn", "summariser-invalid-output"],
    ["stop_sequence", "summariser-invalid-output"],
    ["model_context_window_exceeded", "summariser-invalid-output"],
    ["brand_new_reason", "summariser-invalid-output"],
    [null, "summariser-invalid-output"],
  ];
  for (const [reason, code] of cases) {
    it(`${String(reason)} gives ${code} after exactly one request`, async () => {
      const result = await codeOfCall(messageReply(text, reason));
      expect(result.code).toBe(code);
      expect(result.calls).toBe(1);
    });
  }

  it("a refusal with an empty content array is still a refusal", async () => {
    expect((await codeOfCall(messageReply([], "refusal"))).code).toBe("summariser-refused");
  });
});

describe("Task 2 Test 2: blocks through the transport", () => {
  for (const type of [
    "tool_use",
    "server_tool_use",
    "mcp_tool_use",
    "web_search_tool_result",
    "thinking",
    "redacted_thinking",
    "fallback",
  ]) {
    it(`a ${type} block in an end_turn reply is summariser-invalid-output`, async () => {
      const result = await codeOfCall(
        messageReply([
          { type: "text", text: "fine" },
          { type, name: "web_search", input: {} },
        ]),
      );
      expect(result.code).toBe("summariser-invalid-output");
      expect(result.calls).toBe(1);
    });
  }

  it("an empty content array and an empty text are invalid; extra keys are tolerated", async () => {
    expect((await codeOfCall(messageReply([]))).code).toBe("summariser-invalid-output");
    expect((await codeOfCall(messageReply([{ type: "text", text: "" }]))).code).toBe(
      "summariser-invalid-output",
    );
    expect(
      (
        await codeOfCall(
          messageReply([{ type: "text", text: "ok", citations: null }], "end_turn", { extra: 1 }),
        )
      ).code,
    ).toBe("ok");
  });
});

describe("Task 2 Test 3: HTTP and transport failures", () => {
  for (const [status, code] of [
    [401, "summariser-unconfigured"],
    [403, "summariser-unconfigured"],
    [400, "summariser-failed"],
    [404, "summariser-failed"],
    [429, "summariser-failed"],
    [500, "summariser-failed"],
    [529, "summariser-failed"],
    [301, "summariser-failed"],
    [204, "summariser-failed"],
  ] as const) {
    it(`HTTP ${status} gives ${code} with one request and no retry`, async () => {
      const fake = createFakeAnthropic(() => ({
        status,
        body: JSON.stringify({ type: "error", error: { type: "x", message: "secret-detail" } }),
      }));
      const transport = createAnthropicTransport({
        readApiKey: async () => CANARY_KEY,
        model: "claude-haiku-5-5",
        request: fake.request,
        log: () => undefined,
      });
      const error = await transport.complete({ instructions: "i", input: "x" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as SummariserError).code).toBe(code);
      expect((error as SummariserError).message).not.toContain("secret-detail");
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.responseDestroyed).toBe(true);
      expect(fake.calls[0]?.bytesDelivered).toBe(0);
    });
  }

  it("a socket error is summariser-failed and carries nothing of the error", async () => {
    const result = await codeOfCall({
      error: Object.assign(new Error(`connect failed for ${CANARY_KEY}`), { code: "ECONNRESET" }),
    });
    expect(result.code).toBe("summariser-failed");
    expect(result.calls).toBe(1);
    expect(JSON.stringify(result.error)).not.toContain(CANARY_KEY);
    expect((result.error as Error).message).not.toContain(CANARY_KEY);
    expect((result.error as Error).cause).toBeUndefined();
  });

  it("a request timeout event is summariser-failed", async () => {
    expect((await codeOfCall({ socketTimeout: true })).code).toBe("summariser-failed");
  });

  it("a body failing part way is summariser-failed", async () => {
    const result = await codeOfCall({
      body: ['{"stop_reason":', '"end_turn"'],
      failAfterChunks: 1,
    });
    expect(result.code).toBe("summariser-failed");
  });

  it("a non-JSON body, an empty body and a JSON null are not a reply", async () => {
    expect((await codeOfCall({ body: "<html>gateway</html>" })).code).toBe("summariser-failed");
    expect((await codeOfCall({ body: "" })).code).toBe("summariser-failed");
    expect((await codeOfCall({ body: "null" })).code).toBe("summariser-invalid-output");
  });

  it("a compressed body is refused before it is read", async () => {
    const fake = createFakeAnthropic(() => ({
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: "{}",
    }));
    const transport = createAnthropicTransport({
      readApiKey: async () => CANARY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await expect(transport.complete({ instructions: "i", input: "x" })).rejects.toMatchObject({
      code: "summariser-failed",
    });
    expect(fake.calls[0]?.bytesDelivered).toBe(0);
  });

  it("a response over 2 MiB is cut off and gives summariser-failed", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(0x20);
    const fake = createFakeAnthropic(() => ({ body: [chunk, chunk, chunk, chunk, chunk, chunk] }));
    const transport = createAnthropicTransport({
      readApiKey: async () => CANARY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await expect(transport.complete({ instructions: "i", input: "x" })).rejects.toMatchObject({
      code: "summariser-failed",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.responseDestroyed).toBe(true);
    expect(fake.calls[0]?.bytesDelivered).toBeLessThanOrEqual(2 * 1024 * 1024 + 512 * 1024);
    expect(fake.calls[0]?.bytesDelivered).toBeLessThan(6 * 512 * 1024);
  });

  it("a declared content-length over 2 MiB is refused before reading", async () => {
    const fake = createFakeAnthropic(() => ({
      headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) },
      body: "{}",
    }));
    const transport = createAnthropicTransport({
      readApiKey: async () => CANARY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
      log: () => undefined,
    });
    await expect(transport.complete({ instructions: "i", input: "x" })).rejects.toMatchObject({
      code: "summariser-failed",
    });
    expect(fake.calls[0]?.bytesDelivered).toBe(0);
  });

  it("the 120 second total deadline ends a stalled reply as summariser-failed", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeAnthropic(() => ({ body: ["{"], stallAfterChunks: 1 }));
      const transport = createAnthropicTransport({
        readApiKey: async () => CANARY_KEY,
        model: "claude-haiku-5-5",
        request: fake.request,
        log: () => undefined,
      });
      const outcome = transport.complete({ instructions: "i", input: "x" }).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(119_000);
      expect(fake.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      const error = await outcome;
      expect((error as SummariserError).code).toBe("summariser-failed");
      expect(fake.calls[0]?.requestDestroyed || fake.calls[0]?.responseDestroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply that never arrives is ended by the deadline too", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeAnthropic(() => ({ hang: true }));
      const transport = createAnthropicTransport({
        readApiKey: async () => CANARY_KEY,
        model: "claude-haiku-5-5",
        request: fake.request,
        timeoutMs: 5_000,
        log: () => undefined,
      });
      const outcome = transport.complete({ instructions: "i", input: "x" }).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect(((await outcome) as SummariserError).code).toBe("summariser-failed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timers are cleared after a normal call", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeAnthropic(() => textReply("ok"));
      const transport = createAnthropicTransport({
        readApiKey: async () => CANARY_KEY,
        model: "claude-haiku-5-5",
        request: fake.request,
        log: () => undefined,
      });
      await transport.complete({ instructions: "i", input: "x" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an environment proxy makes the call fail before the key is read", async () => {
    const fake = createFakeAnthropic(() => textReply("ok"));
    let reads = 0;
    const transport = createAnthropicTransport({
      readApiKey: async () => {
        reads += 1;
        return CANARY_KEY;
      },
      model: "claude-haiku-5-5",
      request: fake.request,
      env: { NODE_USE_ENV_PROXY: "1" },
      execArgv: [],
      log: () => undefined,
    });
    await expect(transport.complete({ instructions: "i", input: "x" })).rejects.toMatchObject({
      code: "summariser-failed",
    });
    expect(fake.calls).toHaveLength(0);
    expect(reads).toBe(0);
  });
});

describe("Task 2: the key", () => {
  it("a key reader that throws is summariser-failed and its message is not carried", async () => {
    const result = await codeOfCall(textReply("ok"), {
      readApiKey: async () => {
        throw new Error(`keychain said ${CANARY_KEY}`);
      },
    });
    expect(result.code).toBe("summariser-failed");
    expect(result.calls).toBe(0);
    expect(JSON.stringify(result.error)).not.toContain(CANARY_KEY);
    expect((result.error as Error).message).not.toContain(CANARY_KEY);
  });

  it("a key that cannot be a header value is summariser-unconfigured and sends nothing", async () => {
    for (const key of ["", "   ", `${CANARY_KEY}\r\nx-evil: 1`, `${CANARY_KEY}\n`, "k y", "kéy"]) {
      const result = await codeOfCall(textReply("ok"), { readApiKey: async () => key });
      expect(result.code).toBe("summariser-unconfigured");
      expect(result.calls).toBe(0);
      expect(JSON.stringify(result.error)).not.toContain("evil");
    }
  });
});

describe("Task 2 Test 4: the canary key reaches no error and no log line", () => {
  it("every error, message and captured log entry is free of the key", async () => {
    const entries: unknown[] = [];
    const scripts: AnthropicScript[] = [
      textReply("fine"),
      { status: 401, body: `{"error":"${CANARY_KEY}"}` },
      { status: 500, body: CANARY_KEY },
      { error: new Error(CANARY_KEY) },
      { socketTimeout: true },
      { body: `not json ${CANARY_KEY}` },
      messageReply([{ type: "tool_use", name: CANARY_KEY, input: {} }]),
      messageReply([{ type: "text", text: "x" }], "max_tokens"),
      messageReply([{ type: "text", text: "x" }], "refusal"),
    ];
    const outputs: string[] = [];
    for (const script of scripts) {
      const fake = createFakeAnthropic(() => script);
      const transport = createAnthropicTransport({
        readApiKey: async () => CANARY_KEY,
        model: "claude-haiku-5-5",
        request: fake.request,
        log: (entry) => entries.push(entry),
      });
      try {
        outputs.push(await transport.complete({ instructions: "i", input: "x" }));
      } catch (error) {
        const failure = error as SummariserError;
        outputs.push(String(failure.stack), failure.message, JSON.stringify(failure));
        expect(Object.keys(failure).sort()).toEqual(["code", "name"]);
      }
    }
    expect(JSON.stringify(entries)).not.toContain(CANARY_KEY);
    expect(outputs.join("\n")).not.toContain(CANARY_KEY);
    for (const entry of entries) {
      expect(Object.keys(entry as object).sort()).toEqual(["code", "event"]);
      expect(RUN_ERROR_CODES as readonly string[]).toContain((entry as { code: string }).code);
    }
    expect(entries.length).toBeGreaterThan(5);
  });

  it("the service logger fed by the transport writes no part of the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-anthropic-log-"));
    try {
      const path = join(dir, "service.log");
      const logger = createLogger(path);
      for (const script of [
        { status: 401, body: CANARY_KEY },
        { error: new Error(CANARY_KEY) },
        messageReply([{ type: "tool_use" }]),
      ] satisfies AnthropicScript[]) {
        const fake = createFakeAnthropic(() => script);
        const transport = createAnthropicTransport({
          readApiKey: async () => CANARY_KEY,
          model: "claude-haiku-5-5",
          request: fake.request,
          log: (entry) => logger.warn(entry),
        });
        await transport.complete({ instructions: "i", input: "x" }).catch(() => undefined);
      }
      const written = readFileSync(path, "utf8");
      expect(written.trim().split("\n").length).toBe(3);
      expect(written).not.toContain(CANARY_KEY);
      expect(written).not.toContain("canary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the default log is the service logger and writes code-only lines", async () => {
    const fake = createFakeAnthropic(() => ({ status: 429, body: CANARY_KEY }));
    const transport = createAnthropicTransport({
      readApiKey: async () => CANARY_KEY,
      model: "claude-haiku-5-5",
      request: fake.request,
    });
    await expect(transport.complete({ instructions: "i", input: "x" })).rejects.toMatchObject({
      code: "summariser-failed",
    });
    const log = await import("../logging.js");
    const runtimeLog = readFileSync(
      join(process.env.CCC_RUNTIME_DIR ?? "", "logs", "service.log"),
      "utf8",
    );
    expect(typeof log.logger.info).toBe("function");
    expect(runtimeLog).not.toContain(CANARY_KEY);
    expect(runtimeLog).toContain("research-summariser");
  });
});

describe("the production files hold no key source and no second way out", () => {
  const files = ["anthropic-request.ts", "anthropic-transport.ts", "summariser-error.ts"];
  const read = (name: string): string =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

  it("never read the key from the environment, a file or module state, and never call fetch", () => {
    for (const name of files) {
      const text = read(name);
      expect(text, name).not.toMatch(/process\.env(\.|\[)/);
      expect(text, name).not.toMatch(/ANTHROPIC_API_KEY|API_KEY\b/);
      expect(text, name).not.toMatch(/\bfetch\(/);
      expect(text, name).not.toMatch(/readFile|writeFile|node:fs/);
      expect(text, name).not.toMatch(/rejectUnauthorized|NODE_TLS/);
    }
  });

  it("declare no tool-shaped request key outside comments and the schema's refusal list", () => {
    const code = read("anthropic-request.ts")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const word of ["tools", "tool_choice", "mcp_servers", "container", "betas", "fallbacks"]) {
      expect(new RegExp(`\\b${word}\\b`).test(code), word).toBe(false);
    }
  });
});
