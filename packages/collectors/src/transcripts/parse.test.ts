import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assistantLine,
  CONTENT_SENTINEL,
  generateSyntheticTranscript,
  SYNTHETIC_MODEL,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_VERSION,
  syntheticModelLine,
  userLine,
} from "../test-support/synthetic-transcript.js";
import {
  evaluateRecognition,
  FORMAT_MIN_RATIO,
  FORMAT_MIN_SAMPLE,
  FORMAT_ZERO_SAMPLE,
  MAX_LINE_BYTES,
  parseTranscriptChunk,
  type RecognizedUsageRecord,
  type TranscriptCarry,
} from "./parse.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const carryText = (carry: TranscriptCarry) => new TextDecoder().decode(carry.bytes);

describe("parseTranscriptChunk — one chunk (Test 1)", () => {
  const complete = [
    ...Array.from({ length: 20 }, (_, i) => assistantLine({ messageId: `msg_line${i}` })),
    ...Array.from({ length: 8 }, () => userLine()),
    '{"type":"assistant","message":{"id":"msg_broken"',
  ];
  const partial = assistantLine({ messageId: "msg_partial" }).slice(0, 40);
  const chunk = `${complete.join("\n")}\n${partial}`;

  it("returns the recognized records and carries the trailing partial line", () => {
    const result = parseTranscriptChunk(chunk);
    expect(result.records).toHaveLength(20);
    expect(carryText(result.carry)).toBe(partial);
    expect(result.carry.skipping).toBe(false);
  });

  it("counts only complete lines in bytesConsumed", () => {
    const result = parseTranscriptChunk(chunk);
    expect(result.bytesConsumed).toBe(bytes(chunk) - bytes(partial));
  });

  it("reports the malformed line and per-version counts in stats", () => {
    const { stats } = parseTranscriptChunk(chunk);
    expect(stats).toEqual({
      assistant: 20,
      recognized: 20,
      unparsable: 1,
      oversized: 0,
      byVersion: { [SYNTHETIC_VERSION]: { assistant: 20, recognized: 20 } },
    });
  });

  it("maps the four usage counters and carries ids, version, model and timestamp", () => {
    const line = assistantLine({
      messageId: "msg_mapped",
      usage: { input: 7, output: 11, cacheWrite: 13, cacheRead: 17 },
      timestamp: "2026-09-28T12:34:56.000Z",
    });
    const [record] = parseTranscriptChunk(`${line}\n`).records;
    expect(record).toEqual({
      messageId: "msg_mapped",
      sessionId: SYNTHETIC_SESSION_ID,
      timestamp: "2026-09-28T12:34:56.000Z",
      version: SYNTHETIC_VERSION,
      model: SYNTHETIC_MODEL,
      counters: { input: 7, output: 11, cacheWrite: 13, cacheRead: 17 },
    } satisfies RecognizedUsageRecord);
  });

  it("does not recognize an assistant record whose usage lost a counter", () => {
    const line = JSON.parse(assistantLine({ messageId: "msg_changed" }));
    delete line.message.usage.cache_read_input_tokens;
    const result = parseTranscriptChunk(`${JSON.stringify(line)}\n`);
    expect(result.records).toEqual([]);
    expect(result.stats.byVersion[SYNTHETIC_VERSION]).toEqual({ assistant: 1, recognized: 0 });
  });
});

describe("parseTranscriptChunk — byte-split chunks (Test 2, cursor safety)", () => {
  it("yields the same records from 7 arbitrary byte splits as from one chunk", () => {
    const transcript = generateSyntheticTranscript({ messages: 15 });
    const whole = parseTranscriptChunk(transcript.text);
    expect(whole.carry.bytes.length).toBe(0);
    expect(whole.bytesConsumed).toBe(bytes(transcript.text));

    const encoded = encoder.encode(transcript.text);
    // Seven chunks split at fixed, uneven byte offsets, several landing inside
    // a line and one inside the two-byte `é`, passed as raw bytes as the
    // service's file reader does.
    const cuts = [1, 97, 1_000, 1_001, 2_503, 4_444, encoded.length - 3].sort((a, b) => a - b);
    let carry: TranscriptCarry | undefined;
    let consumed = 0;
    const records: RecognizedUsageRecord[] = [];
    let start = 0;
    for (const end of [...cuts, encoded.length]) {
      const result = parseTranscriptChunk(encoded.subarray(start, end), carry);
      records.push(...result.records);
      carry = result.carry;
      consumed += result.bytesConsumed;
      start = end;
    }
    expect(cuts).toHaveLength(7);
    expect(records).toEqual(whole.records);
    expect(carry?.bytes.length).toBe(0);
    expect(consumed).toBe(encoded.length);
  });
});

describe("parseTranscriptChunk — byte accounting and the line cap (wave 2 review)", () => {
  it("counts bytesConsumed on the raw bytes, so invalid UTF-8 never drifts the cursor", () => {
    const valid = assistantLine({ messageId: "msg_after_invalid" });
    const chunk = new Uint8Array([
      ...encoder.encode('{"type":"user","note":"'),
      0xff,
      0xfe,
      0xc3, // a lone lead byte
      ...encoder.encode('"}\n'),
      ...encoder.encode(`${valid}\n`),
      0xe2,
      0x82, // a partial line ending in a split multi-byte sequence
    ]);
    const result = parseTranscriptChunk(chunk);
    expect(result.records.map((record) => record.messageId)).toEqual(["msg_after_invalid"]);
    expect(result.bytesConsumed).toBe(chunk.length - 2);
    expect(Array.from(result.carry.bytes)).toEqual([0xe2, 0x82]);
  });

  it("drops a line longer than MAX_LINE_BYTES, skips to the next newline and keeps the carry bounded", () => {
    const piece = new Uint8Array(MAX_LINE_BYTES / 2).fill(0x61);
    let carry: TranscriptCarry | undefined;
    let consumed = 0;
    let total = 0;
    const records: RecognizedUsageRecord[] = [];
    let oversized = 0;
    const tail = encoder.encode(`aaa\n${assistantLine({ messageId: "msg_after_long" })}\n`);
    for (const chunk of [piece, piece, piece, tail]) {
      const result = parseTranscriptChunk(chunk, carry);
      carry = result.carry;
      consumed += result.bytesConsumed;
      total += chunk.length;
      records.push(...result.records);
      oversized += result.stats.oversized;
      expect(carry.bytes.length).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }
    expect(oversized).toBe(1);
    expect(records.map((record) => record.messageId)).toEqual(["msg_after_long"]);
    expect(consumed).toBe(total);
    expect(carry?.skipping).toBe(false);
  });

  it("a complete line longer than MAX_LINE_BYTES inside one chunk is counted oversized, not parsed", () => {
    const long = `{"type":"assistant","pad":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    const text = `${long}\n${assistantLine({ messageId: "msg_short" })}\n`;
    const result = parseTranscriptChunk(text);
    expect(result.stats).toMatchObject({ oversized: 1, assistant: 1, recognized: 1 });
    expect(result.bytesConsumed).toBe(bytes(text));
  });
});

describe("parseTranscriptChunk — one message over many lines (Test 3)", () => {
  it("returns a message id repeated across 19 lines 19 times; dedup by message.id is the store's job (05-05)", () => {
    const text = Array.from(
      { length: 19 },
      () => `${assistantLine({ messageId: "msg_repeated" })}\n`,
    ).join("");
    const { records } = parseTranscriptChunk(text);
    expect(records).toHaveLength(19);
    expect(new Set(records.map((record) => record.messageId))).toEqual(new Set(["msg_repeated"]));
  });
});

describe("parseTranscriptChunk — <synthetic> records (Test 4, PR-11)", () => {
  it("recognizes a <synthetic> record with zero usage and no requestId", () => {
    const { records, stats } = parseTranscriptChunk(`${syntheticModelLine("msg_synth")}\n`);
    expect(records).toEqual([
      expect.objectContaining({
        messageId: "msg_synth",
        model: "<synthetic>",
        counters: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      }),
    ]);
    expect(stats.recognized).toBe(1);
  });
});

describe("evaluateRecognition — format-change detection (Test 5, D-41, PR-11)", () => {
  it("names the PR-11 thresholds", () => {
    expect([FORMAT_MIN_SAMPLE, FORMAT_MIN_RATIO, FORMAT_ZERO_SAMPLE]).toEqual([20, 0.9, 5]);
  });

  it("is ok for 2.1.283 at 100 of 100", () => {
    expect(evaluateRecognition({ "2.1.283": { assistant: 100, recognized: 100 } })).toEqual({
      kind: "ok",
    });
  });

  it("is unavailable, naming 2.1.290, at 20 of 25 recognized (0.8)", () => {
    expect(evaluateRecognition({ "2.1.290": { assistant: 25, recognized: 20 } })).toEqual({
      kind: "unavailable",
      version: "2.1.290",
    });
  });

  it("is unavailable, naming 2.1.291, at 0 of 5 recognized", () => {
    expect(evaluateRecognition({ "2.1.291": { assistant: 5, recognized: 0 } })).toEqual({
      kind: "unavailable",
      version: "2.1.291",
    });
  });

  it("is ok at 0 of 3 recognized, below the minimum sample", () => {
    expect(evaluateRecognition({ "2.1.292": { assistant: 3, recognized: 0 } })).toEqual({
      kind: "ok",
    });
  });

  it("names the newest failing version when several fail", () => {
    expect(
      evaluateRecognition({
        "2.1.283": { assistant: 100, recognized: 100 },
        "2.1.290": { assistant: 25, recognized: 20 },
        "2.1.300": { assistant: 6, recognized: 0 },
      }),
    ).toEqual({ kind: "unavailable", version: "2.1.300" });
  });
});

describe("parseTranscriptChunk — never lets content out (Test 6, D-49, T-05-14)", () => {
  it("serialized records exclude every planted content sentinel, path and branch", () => {
    const transcript = generateSyntheticTranscript({ messages: 20, subagent: true });
    const { records } = parseTranscriptChunk(transcript.text);
    expect(records.length).toBe(transcript.assistantLines);
    const serialized = JSON.stringify(records);
    expect(transcript.text).toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("gitBranch");
  });
});

describe("collectors barrel", () => {
  it("imports no module under the hook or status-line directories, so importing it never runs a hook entry", () => {
    const barrel = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const specifiers = [...barrel.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)(hook|statusline)\//);
    }
  });

  it("exports the pure collector functions the service composes", async () => {
    const barrel = await import("../index.js");
    for (const name of [
      "reduce",
      "normalizeSessionEndReason",
      "capabilitiesFor",
      "supportStatus",
      "parseClaudeVersionOutput",
      "MIN_SUPPORTED_CLAUDE_VERSION",
      "parseTranscriptChunk",
      "evaluateRecognition",
      "estimateCostUsd",
      "PRICING_TABLE_VERSION",
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });
});
