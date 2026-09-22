import type { NoteFrontmatter } from "@ccc/domain";

/**
 * RED-phase placeholder. The real implementation arrives in this plan's
 * GREEN commit; both entry points return the empty string so the byte-parity
 * tests in `frontmatter-serializer.test.ts` fail on a value comparison
 * against the service's own bytes rather than on a module-resolution error.
 */

/** Serializes the managed provenance block (no delimiters). */
export function serializeManagedFrontmatter(_frontmatter: NoteFrontmatter): string {
  return "";
}

/** Serializes the note's non-managed ("user") keys, in the order given. */
export function serializePassthroughFrontmatter(
  _entries: readonly (readonly [string, unknown])[],
): string {
  return "";
}
