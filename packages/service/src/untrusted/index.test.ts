// The summariser is a value-in, value-out function over an injected text port.
// This file compiles under `types: []` (see ./tsconfig.json), so it may import
// only vitest and @ccc/domain and cannot name any Node global: the fake
// transport below is a plain object, and nothing here reaches a network or a
// model.
import { describe, expect, it } from "vitest";
import { summarizeUntrusted, type TextTransport, UntrustedInputError } from "./index.js";
import { SUMMARISER_INSTRUCTIONS } from "./instructions.js";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

interface FakeTransport extends TextTransport {
  readonly requests: Array<{ readonly instructions: string; readonly input: string }>;
}

function fakeTransport(reply: () => Promise<string>): FakeTransport {
  const requests: Array<{ readonly instructions: string; readonly input: string }> = [];
  return {
    requests,
    complete(request) {
      requests.push(request);
      return reply();
    },
  };
}

describe("summarizeUntrusted", () => {
  it("passes fixed instructions and the delimited input to the transport once and returns its text unchanged", async () => {
    const reply = '  {"items":[]}\né trailing  ';
    const transport = fakeTransport(async () => reply);
    const delimitedContent = `<<<SRC id=${ID_A} nonce=n1>>>\nhello\n<<<END nonce=n1>>>`;

    const result = await summarizeUntrusted(
      { delimitedContent, sourceIds: [ID_A, ID_B] },
      transport,
    );

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request?.instructions).toBe(SUMMARISER_INSTRUCTIONS);
    expect(request?.input).toContain(delimitedContent);
    expect(request?.input).toContain(ID_A);
    expect(request?.input).toContain(ID_B);
    expect(result).toEqual({ text: reply });
  });

  it("refuses an empty source id list and a malformed source id before the transport is called", async () => {
    const transport = fakeTransport(async () => "never");

    await expect(
      summarizeUntrusted({ delimitedContent: "x", sourceIds: [] }, transport),
    ).rejects.toBeInstanceOf(UntrustedInputError);

    for (const bad of [
      "ABCDEF0123456789abcdef0123456789",
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "",
    ]) {
      await expect(
        summarizeUntrusted({ delimitedContent: "x", sourceIds: [ID_A, bad] }, transport),
      ).rejects.toBeInstanceOf(UntrustedInputError);
    }
    expect(transport.requests).toHaveLength(0);
  });

  it("propagates the transport's own error object and does not retry", async () => {
    const failure = new Error("transport down");
    const transport = fakeTransport(async () => {
      throw failure;
    });

    let caught: unknown;
    try {
      await summarizeUntrusted({ delimitedContent: "x", sourceIds: [ID_A] }, transport);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(failure);
    expect(transport.requests).toHaveLength(1);
  });
});

describe("SUMMARISER_INSTRUCTIONS", () => {
  it("is a constant that states the JSON contract, the three kinds and the data-not-instructions rule", () => {
    expect(typeof SUMMARISER_INSTRUCTIONS).toBe("string");
    expect(SUMMARISER_INSTRUCTIONS.length).toBeGreaterThan(0);
    for (const word of ["items", "kind", "text", "citedSourceIds", "quote"]) {
      expect(SUMMARISER_INSTRUCTIONS).toContain(word);
    }
    for (const kind of ["source-fact", "unverified-claim", "inference"]) {
      expect(SUMMARISER_INSTRUCTIONS).toContain(kind);
    }
    expect(SUMMARISER_INSTRUCTIONS).toContain("<<<SRC");
    expect(SUMMARISER_INSTRUCTIONS).toContain("<<<END");
    expect(SUMMARISER_INSTRUCTIONS.toLowerCase()).toContain("never instructions");
    expect(SUMMARISER_INSTRUCTIONS).not.toMatch(/\$\{|\{\{|%s|<placeholder>/);
  });
});
