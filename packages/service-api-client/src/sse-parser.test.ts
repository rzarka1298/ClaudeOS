import { describe, expect, it } from "vitest";
import { createEventStreamParser } from "./sse-parser.js";

describe("createEventStreamParser", () => {
  it("a single complete record in one chunk yields one event with its identifier and parsed data", () => {
    const parser = createEventStreamParser();
    const results = parser.feed('id: 1\ndata: {"ok":true}\n\n');
    expect(results).toEqual([{ kind: "event", id: 1, data: { ok: true } }]);
  });

  it("a record split across three chunks (mid-id, mid-data, before the blank line) yields nothing until the final chunk, then exactly one event", () => {
    const parser = createEventStreamParser();
    expect(parser.feed("id: 4")).toEqual([]);
    expect(parser.feed('2\ndata: {"a":')).toEqual([]);
    expect(parser.feed("1}\n")).toEqual([]);
    const results = parser.feed("\n");
    expect(results).toEqual([{ kind: "event", id: 42, data: { a: 1 } }]);
  });

  it("two records in one chunk yield two events in order", () => {
    const parser = createEventStreamParser();
    const results = parser.feed('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\n');
    expect(results).toEqual([
      { kind: "event", id: 1, data: { n: 1 } },
      { kind: "event", id: 2, data: { n: 2 } },
    ]);
  });

  it("a trailing fragment with no terminating blank line yields nothing and is retained for the next chunk", () => {
    const parser = createEventStreamParser();
    expect(parser.feed('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}')).toEqual([
      { kind: "event", id: 1, data: { n: 1 } },
    ]);
    // The fragment completes once its own blank line arrives.
    expect(parser.feed("\n\n")).toEqual([{ kind: "event", id: 2, data: { n: 2 } }]);
  });

  it("a record whose data is not valid JSON yields a parse-failure result, and the parser continues with the next record", () => {
    const parser = createEventStreamParser();
    const results = parser.feed('id: 1\ndata: {not valid json}\n\nid: 2\ndata: {"n":2}\n\n');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ kind: "parse-error" });
    expect(results[1]).toEqual({ kind: "event", id: 2, data: { n: 2 } });
  });

  it("a record with a data line but no identifier line yields the event with the previous identifier retained", () => {
    const parser = createEventStreamParser();
    parser.feed('id: 7\ndata: {"n":1}\n\n');
    const results = parser.feed('data: {"n":2}\n\n');
    expect(results).toEqual([{ kind: "event", id: 7, data: { n: 2 } }]);
  });

  it("carriage-return line endings are handled identically to bare newlines", () => {
    const parser = createEventStreamParser();
    const results = parser.feed('id: 1\r\ndata: {"ok":true}\r\n\r\n');
    expect(results).toEqual([{ kind: "event", id: 1, data: { ok: true } }]);
  });
});
