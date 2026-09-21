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
 *
 * The body is handed over as `{ content }` rather than as a bare string,
 * and that distinction is load-bearing rather than stylistic: given a
 * string, `matter.stringify` runs it back through `matter()` first, so the
 * body is PARSED as if it carried front matter of its own. A body whose
 * first line is `---` then loses its content and leaks its characters into
 * the frontmatter as forged keys, and a body whose first line is `---js`
 * is handed to gray-matter's eval-based JavaScript engine and executed at
 * write time. Bodies on this path come from research capture, imported
 * Markdown and email — ADR-0014's untrusted content — so neither outcome
 * is acceptable. Passing a file-shaped object skips that re-parse; the
 * bytes are identical for every body that does not start with a delimiter.
 */
export function stringifyNote(frontmatter: NoteFrontmatter, body: string): string {
  const source = frontmatter as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of NOTE_FRONTMATTER_KEY_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    ordered[key] = key === "generatedBy" ? orderedGeneratedBy(value as GeneratedBy) : value;
  }
  return matter.stringify({ content: body }, ordered);
}

/**
 * An engine that refuses to run. Registered below under the names
 * gray-matter would otherwise resolve to its `eval`-based JavaScript
 * engine, so the delimiter check has a second, independent layer beneath
 * it rather than being the only thing standing between an untrusted note
 * and `eval`.
 */
const REFUSED_ENGINE = {
  parse(): never {
    throw new InvalidNoteFrontmatterError([
      {
        code: "custom",
        path: [],
        message: "executable frontmatter engines are not available to managed notes",
      },
    ]);
  },
  stringify(): never {
    throw new InvalidNoteFrontmatterError([
      {
        code: "custom",
        path: [],
        message: "executable frontmatter engines are not available to managed notes",
      },
    ]);
  },
};

/**
 * Refuses a note whose opening delimiter carries a LANGUAGE TAG.
 *
 * gray-matter reads the text after the opening `---` as the name of the
 * engine to parse the block with, and one of the engines it ships —
 * reachable as `js`, `JS` or `javascript` — is a literal `eval`. A note
 * beginning `---js` is therefore arbitrary code, executed inside the
 * companion-service process that holds the Keychain secrets and can
 * launch other processes. This is threat T-02-03's real shape: the risk
 * was never a `!!js/function` YAML tag (js-yaml's safe load already
 * refuses those, which this package's tests now assert), it was the
 * language selector one layer above YAML.
 *
 * Managed notes are plain-YAML-fronted by definition, so the fix is a
 * refusal rather than an allow-list of safe engines: only a bare `---`
 * (or the equivalent explicit `---yaml`) is accepted, and the check runs
 * BEFORE gray-matter sees the string, which is what makes every spelling
 * — BOM-prefixed, space- or tab-separated, capitalised, CRLF — moot.
 */
function assertPlainYamlDelimiter(raw: string): void {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith("---")) return;

  const lineEnd = text.indexOf("\n");
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const language = firstLine.slice(3).trim().toLowerCase();
  if (language === "" || language === "yaml") return;

  throw new InvalidNoteFrontmatterError([
    {
      code: "custom",
      path: [],
      message: `frontmatter delimiter carries a language tag (${language}); managed notes are plain YAML`,
    },
  ]);
}

/**
 * Parses a raw note, validating its frontmatter through
 * `NoteFrontmatterSchema` before any field is trusted.
 *
 * Two deserialization defences, in order, because on-disk notes are
 * untrusted input (hand-edited in Obsidian, synced in by another tool,
 * captured from the web):
 *
 * 1. {@link assertPlainYamlDelimiter} refuses a language-tagged opening
 *    delimiter outright — see there for why that, not the YAML tag, is
 *    the executable surface.
 * 2. The YAML block itself is parsed by gray-matter's default engine,
 *    which is js-yaml's SAFE load: it does not instantiate arbitrary JS
 *    types from YAML tags such as `!!js/function`. Do not replace it with
 *    a custom engine or a fuller schema — that reopens exactly the
 *    surface this comment exists to keep closed.
 */
export function parseNote(raw: string): ParsedNote {
  assertPlainYamlDelimiter(raw);

  const parsed = matter(raw, {
    engines: { javascript: REFUSED_ENGINE, js: REFUSED_ENGINE, coffee: REFUSED_ENGINE },
  });
  const result = NoteFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    throw new InvalidNoteFrontmatterError(result.error.issues);
  }
  return { frontmatter: result.data, body: parsed.content };
}
