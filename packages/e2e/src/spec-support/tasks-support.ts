export type FrontmatterParse =
  | { ok: true; entries: Array<[string, string]>; map: Record<string, string> }
  | { ok: false; reason: "no-opening" | "unterminated" };

export type CreatedNoteCode =
  | "not-a-note"
  | "id-invalid"
  | "type-not-task"
  | "status-mismatch"
  | "created-missing"
  | "updated-missing"
  | "title-not-in-file-name";

export type CreatedNoteVerdict = { ok: true } | { ok: false; code: CreatedNoteCode };

export function parseNoteFrontmatter(_text: string): FrontmatterParse {
  throw new Error("not implemented");
}

export function checkCreatedNote(
  _text: string,
  _fileName: string,
  _expected: { status: "inbox" | "ready"; title: string },
): CreatedNoteVerdict {
  throw new Error("not implemented");
}
