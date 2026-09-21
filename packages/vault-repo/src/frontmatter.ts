import type { NoteFrontmatter } from "@ccc/domain";

/**
 * A note as it exists on disk, split into its validated frontmatter and
 * its untouched body. The body is returned verbatim: nothing in this
 * package rewrites note prose.
 */
export interface ParsedNote {
  readonly frontmatter: NoteFrontmatter;
  readonly body: string;
}

/**
 * Thrown by {@link parseNote} when a note's YAML frontmatter does not
 * satisfy `NoteFrontmatterSchema`. On-disk frontmatter is untrusted input
 * — a note may have been hand-edited in Obsidian or synced in by another
 * tool — so a shape violation is a normal, reportable condition rather
 * than an internal error, and carries the zod issues so a repair pass can
 * say which field is wrong.
 */
export class InvalidNoteFrontmatterError extends Error {
  readonly issues: readonly unknown[];

  constructor(issues: readonly unknown[]) {
    super("note frontmatter does not match the provenance schema");
    this.name = "InvalidNoteFrontmatterError";
    this.issues = issues;
  }
}

/**
 * Serializes `frontmatter` + `body` into a Markdown note with the YAML
 * keys in `NOTE_FRONTMATTER_KEY_ORDER` — never insertion order, never a
 * YAML library's own ordering option. See that constant for why the
 * byte-identical contract depends on this being explicit.
 *
 * NOT YET IMPLEMENTED — RED phase (plan 02-01).
 */
export function stringifyNote(frontmatter: NoteFrontmatter, body: string): string {
  void frontmatter;
  void body;
  throw new Error("stringifyNote is not implemented yet");
}

/**
 * Parses a raw note, validating its frontmatter through
 * `NoteFrontmatterSchema` before any field is trusted.
 *
 * NOT YET IMPLEMENTED — RED phase (plan 02-01).
 */
export function parseNote(raw: string): ParsedNote {
  void raw;
  throw new Error("parseNote is not implemented yet");
}
