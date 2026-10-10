import { describe, expect, it } from "vitest";
import { EMPTY_CARRY, MAX_LINE_BYTES, splitLines, type TranscriptCarry } from "./split-lines.js";

// Wave 3 audit (plan 05.1-08 truth 7): splitLines was extracted from the Claude parser with no
// behaviour change. It is the byte-exact carry both parsers depend on, and no test exercised it
// directly. These cases pin the contract named in its header.

const enc = new TextEncoder();

function feed(chunks: readonly Uint8Array[]): {
  lines: string[];
  carry: TranscriptCarry;
  oversized: number;
} {
  let carry: TranscriptCarry = EMPTY_CARRY;
  const lines: string[] = [];
  let oversized = 0;
  for (const chunk of chunks) {
    const r = splitLines(chunk, carry);
    lines.push(...r.lines);
    oversized += r.oversized;
    carry = r.carry;
  }
  return { lines, carry, oversized };
}

describe("splitLines (shared Claude and Codex carry)", () => {
  it("returns complete lines only and carries the trailing partial line", () => {
    const r = splitLines(enc.encode('{"a":1}\n{"b":'), EMPTY_CARRY);
    expect(r.lines).toEqual(['{"a":1}']);
    expect(new TextDecoder().decode(r.carry.bytes)).toBe('{"b":');
    expect(r.carry.skipping).toBe(false);
    expect(r.oversized).toBe(0);
  });

  it("is split-point independent, even inside a multi-byte character", () => {
    const text = 'x"é€😀"\nsecond line\n\nlast\n';
    const bytes = enc.encode(text);
    const whole = feed([bytes]).lines;
    expect(whole).toEqual(['x"é€😀"', "second line", "", "last"]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      expect(feed([bytes.subarray(0, cut), bytes.subarray(cut)]).lines, `cut ${cut}`).toEqual(
        whole,
      );
    }
  });

  it("does not mutate the caller's buffer and does not pin it through the carry", () => {
    const big = enc.encode("done\npartial");
    const r = splitLines(big, EMPTY_CARRY);
    expect(r.carry.bytes.buffer).not.toBe(big.buffer);
    expect(new TextDecoder().decode(big)).toBe("done\npartial");
  });

  it("drops an over-long line, counts it once, and resumes at the next line", () => {
    const long = new Uint8Array(MAX_LINE_BYTES + 1).fill(0x61);
    const first = splitLines(long, EMPTY_CARRY);
    expect(first.oversized).toBe(1);
    expect(first.carry).toEqual({ bytes: new Uint8Array(0), skipping: true });
    const second = splitLines(enc.encode("tail of the long line\nnext\n"), first.carry);
    expect(second.lines).toEqual(["next"]);
    expect(second.oversized).toBe(0);
    expect(second.carry.skipping).toBe(false);
  });

  it("keeps a line of exactly the limit", () => {
    const exact = new Uint8Array(MAX_LINE_BYTES).fill(0x62);
    const chunk = new Uint8Array(exact.length + 1);
    chunk.set(exact);
    chunk[exact.length] = 0x0a;
    const r = splitLines(chunk, EMPTY_CARRY);
    expect(r.oversized).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.length).toBe(MAX_LINE_BYTES);
  });

  it("treats a carriage return as part of the line, not a separator", () => {
    expect(splitLines(enc.encode("a\r\nb\n"), EMPTY_CARRY).lines).toEqual(["a\r", "b"]);
  });
});
