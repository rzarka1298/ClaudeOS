import { describe, expect, it } from "vitest";
import { checkCreatedNote, parseNoteFrontmatter } from "./tasks-support.js";

const ID = "abcdefghij0123456789klmno";

function note(overrides: Record<string, string | null> = {}, title = "Weekly report draft"): string {
  const base: Record<string, string | null> = {
    id: ID,
    scope: "global",
    stage: "capture",
    created: "2026-10-08T09:00:00.000Z",
    updated: "2026-10-08T09:00:00.000Z",
    type: "task",
    title: `"${title}"`,
    status: "inbox",
    ...overrides,
  };
  const lines = Object.entries(base)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\nbody\n`;
}

describe("parseNoteFrontmatter (Test 2)", () => {
  it("reads scalar lines into a flat map, quotes preserved, in original order", () => {
    const parsed = parseNoteFrontmatter(note({ due: "2026-10-08" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.map["id"]).toBe(ID);
    expect(parsed.map["title"]).toBe('"Weekly report draft"');
    expect(parsed.map["due"]).toBe("2026-10-08");
    expect(parsed.entries.map(([key]) => key)).toEqual([
      "id",
      "scope",
      "stage",
      "created",
      "updated",
      "type",
      "title",
      "status",
      "due",
    ]);
  });

  it("skips indented and list lines and keeps a block key with an empty value", () => {
    const text =
      "---\nid: x\ntags:\n  - a\n  - b\ndecision:\n  outcome: accepted\nstatus: ready\n---\n";
    const parsed = parseNoteFrontmatter(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map(([key]) => key)).toEqual(["id", "tags", "decision", "status"]);
    expect(parsed.map["tags"]).toBe("");
  });

  it("rejects a note without a closing delimiter and one without an opening one", () => {
    expect(parseNoteFrontmatter("---\nid: x\nstatus: ready\n")).toEqual({
      ok: false,
      reason: "unterminated",
    });
    expect(parseNoteFrontmatter("id: x\n---\n")).toEqual({ ok: false, reason: "no-opening" });
    expect(parseNoteFrontmatter("")).toEqual({ ok: false, reason: "no-opening" });
  });

  it("tolerates carriage returns at line ends", () => {
    const parsed = parseNoteFrontmatter("---\r\nid: x\r\nstatus: ready\r\n---\r\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.map["status"]).toBe("ready");
  });
});

describe("checkCreatedNote (Test 3)", () => {
  const fileName = `weekly-report-draft-${ID.slice(-8)}.md`;
  const expected = { status: "inbox", title: "Weekly report draft" } as const;

  it("accepts a well-formed created note", () => {
    expect(checkCreatedNote(note(), fileName, expected)).toEqual({ ok: true });
  });

  it("accepts the ready status when ready is expected", () => {
    expect(
      checkCreatedNote(note({ status: "ready" }), fileName, { ...expected, status: "ready" }),
    ).toEqual({ ok: true });
  });

  it("rejects a 24-character id", () => {
    const result = checkCreatedNote(note({ id: ID.slice(1) }), fileName, expected);
    expect(result).toMatchObject({ ok: false, code: "id-invalid" });
  });

  it("rejects an id with a character outside the alphabet", () => {
    const result = checkCreatedNote(note({ id: `${ID.slice(1)}A` }), fileName, expected);
    expect(result).toMatchObject({ ok: false, code: "id-invalid" });
  });

  it("rejects a wrong status", () => {
    expect(checkCreatedNote(note({ status: "ready" }), fileName, expected)).toMatchObject({
      ok: false,
      code: "status-mismatch",
    });
  });

  it("rejects a missing updated stamp", () => {
    expect(checkCreatedNote(note({ updated: null }), fileName, expected)).toMatchObject({
      ok: false,
      code: "updated-missing",
    });
  });

  it("rejects a missing created stamp and a wrong type with their own codes", () => {
    expect(checkCreatedNote(note({ created: null }), fileName, expected)).toMatchObject({
      code: "created-missing",
    });
    expect(checkCreatedNote(note({ type: "note" }), fileName, expected)).toMatchObject({
      code: "type-not-task",
    });
  });

  it("rejects a file name that does not carry the typed title", () => {
    expect(checkCreatedNote(note(), "something-else-12345678.md", expected)).toMatchObject({
      ok: false,
      code: "title-not-in-file-name",
    });
  });

  it("rejects text that is not a note at all", () => {
    expect(checkCreatedNote("no frontmatter", fileName, expected)).toMatchObject({
      ok: false,
      code: "not-a-note",
    });
  });

  it("uses distinct codes for the four named failures", () => {
    const codes = [
      checkCreatedNote(note({ id: ID.slice(1) }), fileName, expected),
      checkCreatedNote(note({ status: "ready" }), fileName, expected),
      checkCreatedNote(note({ updated: null }), fileName, expected),
      checkCreatedNote(note(), "other-12345678.md", expected),
    ].map((result) => (result.ok ? "ok" : result.code));
    expect(new Set(codes).size).toBe(4);
  });
});
