import { RUN_ERROR_CODES } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createAnthropicTransport } from "./anthropic-transport.js";
import { RESEARCH_API_KEY_ACCOUNT } from "./research-key.js";
import { SummariserError } from "./summariser-error.js";
import { createFakeAnthropic, textReply } from "./test-support/fake-anthropic.js";

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
