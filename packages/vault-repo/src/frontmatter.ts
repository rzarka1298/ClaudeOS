import {
  GENERATED_BY_KEY_ORDER,
  type GeneratedBy,
  NOTE_FRONTMATTER_KEY_ORDER,
  type NoteFrontmatter,
  NoteFrontmatterSchema,
} from "@ccc/domain";
import matter from "gray-matter";

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
 * Rebuilds the nested `generatedBy` map with its keys inserted in
 * `GENERATED_BY_KEY_ORDER`, dropping absent subfields.
 *
 * Dropping them is not cosmetic: js-yaml refuses to dump `undefined`, so
 * an unknown subfield left on the object would throw rather than serialize
 * — and an explicit `model: null` would claim "no model", which is a
 * different assertion from "model unknown".
 */
function orderedGeneratedBy(value: GeneratedBy): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of GENERATED_BY_KEY_ORDER) {
    const sub = value[key];
    if (sub !== undefined) ordered[key] = sub;
  }
  return ordered;
}

/**
 * Serializes `frontmatter` + `body` into a Markdown note with the YAML
 * keys in `NOTE_FRONTMATTER_KEY_ORDER` — never insertion order, never a
 * YAML library's own ordering option.
 *
 * The loop below IS the determinism guarantee VAULT-03/VAULT-04 depend on:
 * a fresh object is built by walking the canonical key array, so the bytes
 * a caller gets are a function of the note's content alone and not of the
 * order that caller happened to write its object literal in.
 */
export function stringifyNote(frontmatter: NoteFrontmatter, body: string): string {
  const source = frontmatter as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of NOTE_FRONTMATTER_KEY_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    ordered[key] = key === "generatedBy" ? orderedGeneratedBy(value as GeneratedBy) : value;
  }
  return matter.stringify(body, ordered);
}

/**
 * Parses a raw note, validating its frontmatter through
 * `NoteFrontmatterSchema` before any field is trusted.
 *
 * `matter()` is called with no engine options on purpose: gray-matter's
 * default js-yaml engine loads with the schema that does NOT instantiate
 * arbitrary JS types from YAML tags. Passing a custom engine or schema
 * here would reopen that deserialization surface against notes this
 * process did not write (threat T-02-03) — so don't.
 */
export function parseNote(raw: string): ParsedNote {
  const parsed = matter(raw);
  const result = NoteFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    throw new InvalidNoteFrontmatterError(result.error.issues);
  }
  return { frontmatter: result.data, body: parsed.content };
}
