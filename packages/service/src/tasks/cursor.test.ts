import { TASK_CURSOR_MAX_LENGTH, TASK_FILTERS, TaskCursorSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  decodeOffsetCursor,
  decodeTaskCursor,
  encodeOffsetCursor,
  encodeTaskCursor,
} from "./cursor.js";

const ID = "0mfk1a2b3c4d5e6f7a8b9c001";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("Test 1 (cursor)", () => {
  it("round-trips a cursor for every filter in a URL-safe string within the length bound", () => {
    for (const filter of TASK_FILTERS) {
      const cursor = { filter, keys: ["2026-10-07T10:00:00.000Z", 2], id: ID };
      const text = encodeTaskCursor(cursor);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(TASK_CURSOR_MAX_LENGTH);
      expect(TaskCursorSchema.safeParse(text).success).toBe(true);
      expect(decodeTaskCursor(text, filter)).toEqual(cursor);
    }
  });

  it("keeps the longest legal keys within the bound", () => {
    const long = "x".repeat(64);
    const text = encodeTaskCursor({ filter: "project", keys: [long, long], id: ID });
    expect(text.length).toBeLessThanOrEqual(TASK_CURSOR_MAX_LENGTH);
    expect(decodeTaskCursor(text, "project")?.keys).toEqual([long, long]);
  });

  it("refuses a cursor from another filter", () => {
    const text = encodeTaskCursor({ filter: "today", keys: ["~", 1], id: ID });
    expect(decodeTaskCursor(text, "upcoming")).toBeNull();
  });

  it("refuses a truncated cursor, non-base64 text and characters outside the URL-safe set", () => {
    const text = encodeTaskCursor({ filter: "all", keys: ["2026-10-07T10:00:00.000Z"], id: ID });
    expect(decodeTaskCursor(text.slice(0, text.length - 7), "all")).toBeNull();
    expect(decodeTaskCursor("not a cursor!", "all")).toBeNull();
    expect(decodeTaskCursor(`${text}=`, "all")).toBeNull();
    expect(decodeTaskCursor(`${text}+/`, "all")).toBeNull();
    expect(decodeTaskCursor("", "all")).toBeNull();
  });

  it("refuses a well-formed encoding of the wrong shape", () => {
    const bad = [
      "[]",
      "{}",
      '["all",["a"],"short"]',
      `["all","a","${ID}"]`,
      `["all",[{"x":1}],"${ID}"]`,
      `["all",[1.5],"${ID}"]`,
      `["all",["${"y".repeat(65)}"],"${ID}"]`,
      `["nonsense",["a"],"${ID}"]`,
      `["all",["a","b","c","d","e"],"${ID}"]`,
      `["all",["a"],"${ID}"],1]`,
    ];
    for (const raw of bad) expect(decodeTaskCursor(b64(raw), "all")).toBeNull();
  });
});

describe("offset cursor", () => {
  it("round-trips and refuses garbage and negative offsets", () => {
    for (const offset of [0, 1, 25, 9999]) {
      expect(decodeOffsetCursor(encodeOffsetCursor(offset))).toBe(offset);
    }
    expect(decodeOffsetCursor("garbage!")).toBeNull();
    expect(decodeOffsetCursor(b64('["attention",-1]'))).toBeNull();
    expect(decodeOffsetCursor(b64('["attention",1.5]'))).toBeNull();
    expect(decodeOffsetCursor(b64('["other",3]'))).toBeNull();
    expect(decodeOffsetCursor(encodeTaskCursor({ filter: "all", keys: ["a"], id: ID }))).toBeNull();
  });
});
