// The clean half of the untrusted layer-2 fixture pair (plan 07-02, task 2):
// the same project configuration (`types` empty, references the domain
// project), importing a domain type and using only ES2022 values. It must
// compile with no output. That proves two things at once: the run in
// ../../src/ts-boundary.test.ts discriminates instead of always failing, and
// the domain package's emitted declarations do not bring Node's ambient types
// into a types-free project (the D-01 spike, made permanent).
import type { NoteId } from "@ccc/domain";

export function describeNote(id: NoteId | null): string {
  return id === null ? "none" : String(id);
}
