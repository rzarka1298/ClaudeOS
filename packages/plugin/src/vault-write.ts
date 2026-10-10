import {
  NOTE_FRONTMATTER_KEY_ORDER,
  type NoteFrontmatter,
  NoteFrontmatterSchema,
} from "@ccc/domain";
import { parseYaml, type TFile, type Vault } from "obsidian";
import {
  applyConflictSafeUpdate,
  type ConflictSafeUpdateResult,
  type ManagedNoteFile,
  type ProcessableVault,
} from "./conflict-safe.js";
import {
  serializeManagedFrontmatter,
  serializePassthroughFrontmatter,
} from "./frontmatter-serializer.js";

/**
 * The ONLY plugin-side write path for managed notes (VAULT-06).
 *
 * A note that may be open in an editor pane cannot be written by the
 * companion service's raw filesystem path: only this process knows whether
 * a buffer is open and dirty. Obsidian's `Vault.process()` closes the
 * read-modify-write window *inside* the call -- its documentation
 * guarantees "the file doesn't change between reading the current content
 * and writing the updated content" -- but it says nothing about the much
 * wider window between the CALLER's last read and the write it is now
 * proposing. That outer window is where a user's in-editor edit lives, and
 * closing it is this module's whole job: every entry point takes the
 * content the caller believes is on disk and refuses to write when the real
 * content no longer matches.
 *
 * Caller contract: on `"conflict"`, re-fetch the note, rebuild the proposed
 * change against the content you just read, and call again. This module
 * will never resolve a conflict on its own -- silently re-applying a
 * transform on top of someone's edit is precisely the data loss the
 * conflict result exists to prevent, so there is deliberately no retry,
 * no merge, and no force flag anywhere in this file.
 *
 * ## Write-class routing policy (formalised in ADR-0022, plan 02-06)
 *
 * `@ccc/vault-repo`'s `writeNote()` owns service-generated artifacts --
 * everything under `raw/`, `wiki/`, `output/`, `automation-runs/` and every
 * generated `index.md` -- because the service must be able to write
 * knowledge whether or not Obsidian is running. Any note that may be open
 * in an editor is written ONLY through this module. Today the split is a
 * policy plus this module's existence; its enforcing consumer arrives with
 * Phase 6's task store, the first code path that proposes a cross-process
 * write to a note a user may have open.
 *
 * ## Index eventual-consistency bound (also ADR-0022, plan 02-06)
 *
 * This module never regenerates a folder's `index.md`, and structurally
 * cannot: index generation lives in the service-side `@ccc/vault-repo`,
 * which the import-boundary gate (`ci:boundaries`) forbids this package
 * from importing. A provenance update can therefore leave a folder index's
 * displayed `updated` value stale until the next service-side write into
 * that folder or the next repair run. That is the entire staleness
 * surface: `id`, the row's link target and `stage` cannot change through
 * this path, so no index reference can ever break -- only one displayed
 * timestamp can lag.
 *
 * ## No write-backs from change-event handlers
 *
 * Nothing in this module subscribes to Vault or metadata-cache change
 * events, and nothing in it may. A write performed from inside a change
 * handler re-fires the same handler through the write it just made -- the
 * re-entrant index-update loop the roadmap's blocking note forbids. Every
 * export here is a plain function that runs only when a caller explicitly
 * calls it, which makes that loop unreachable rather than merely
 * discouraged (the negative grep in this plan's verification is the
 * machine check). A future event-driven writer must queue the work and
 * debounce it (250-500ms) OUTSIDE the handler's call stack, and must live
 * in its own module rather than re-opening this one.
 */

// The primitive moved to `conflict-safe.ts` (plan 06-18) so the task update path
// can use it without this module's Obsidian runtime import; every name below
// keeps working for existing importers.
export type { ConflictSafeUpdateResult, ManagedNoteFile, ProcessableVault };
export { applyConflictSafeUpdate };

/**
 * Narrows a real Obsidian `Vault` to {@link ProcessableVault}. The body is
 * an identity, but the signature is a compile-time proof that Obsidian's
 * `Vault.process` still satisfies the surface this module depends on: if
 * that signature ever changes, this function stops compiling instead of
 * this module silently drifting from the API it claims to wrap.
 */
export function processableVault(vault: Vault): ProcessableVault {
  return vault;
}

/**
 * Narrows a real Obsidian `TFile` to {@link ManagedNoteFile} -- the same
 * compile-checked adapter as {@link processableVault}, and the reason no
 * `as TFile` cast appears anywhere in this module or its tests.
 */
export function processableFile(file: TFile): ManagedNoteFile {
  return file;
}

/**
 * Thrown when the note this module was asked to update does not hold a
 * well-formed managed-note frontmatter block -- no delimiters, unparseable
 * YAML, or a shape that fails `NoteFrontmatterSchema`.
 *
 * On-disk frontmatter is untrusted input: a note may have been hand-edited
 * in the editor or synced in by another tool. Refusing is the safe
 * direction. Writing a "repaired" block over content this module could not
 * understand would destroy whatever the user actually typed, which is the
 * same loss the conflict result exists to prevent -- so a malformed note is
 * reported, never rewritten.
 */
export class InvalidManagedNoteError extends Error {
  readonly notePath: string;
  readonly issues: readonly unknown[];

  constructor(notePath: string, detail: string, issues: readonly unknown[] = []) {
    super(`cannot update provenance for ${notePath}: ${detail}`);
    this.name = "InvalidManagedNoteError";
    this.notePath = notePath;
    this.issues = issues;
  }
}

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "---\n";
/** The newline that ends the YAML block, plus the closing delimiter line. */
const FRONTMATTER_TERMINATOR = "\n---\n";

/**
 * Splits a managed note into its raw YAML frontmatter text (including the
 * newline that terminates it) and its body, or `null` when the content has
 * no frontmatter block at all.
 *
 * Deliberately a literal split rather than a YAML-library "load document"
 * call: the body must come back as the exact bytes that were on disk, and
 * a round-trip through any document model is a chance for it not to.
 */
function splitNote(raw: string): { frontmatter: string; body: string } | null {
  if (!raw.startsWith(FRONTMATTER_OPEN)) return null;
  // Search from the opening delimiter's own newline so an empty
  // frontmatter block (`---\n---\n`) is still found.
  const terminator = raw.indexOf(FRONTMATTER_TERMINATOR, FRONTMATTER_OPEN.length - 1);
  if (terminator === -1) return null;
  return {
    frontmatter: raw.slice(FRONTMATTER_OPEN.length, terminator + 1),
    body: raw.slice(terminator + FRONTMATTER_TERMINATOR.length),
  };
}

/**
 * The frontmatter keys this module does NOT own, emitted verbatim after the
 * managed block.
 *
 * `NoteFrontmatterSchema` is a plain `z.object`, and zod strips unknown keys
 * by default -- so `validated.data` holds only the twelve provenance keys.
 * Rebuilding the whole block from it would DELETE everything else, and in an
 * Obsidian vault "everything else" is not exotic: `tags`, `aliases`,
 * `cssclasses`, `publish`, Dataview inline fields and Templater metadata all
 * live in note frontmatter and are load-bearing for search, graph and
 * theming. Losing them would be exactly the silent destruction this module's
 * contract says it never performs.
 *
 * Original key order is preserved (`Object.entries` walks insertion order,
 * and the YAML parse inserts in document order), so a provenance update is
 * byte-stable for the user's own keys too.
 */
function passthroughKeys(parsed: unknown): [string, unknown][] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const owned = new Set<string>(NOTE_FRONTMATTER_KEY_ORDER);
  return Object.entries(parsed as Record<string, unknown>).filter(([key]) => !owned.has(key));
}

/** `"refused"` -- the note is a task note, which only the task update path may rewrite. */
export type ProvenanceUpdateResult = ConflictSafeUpdateResult | "refused";

/**
 * A top-level `type: task` line. A text test rather than a second YAML parse, so
 * this module keeps exactly one untrusted parse (below, validated by zod); a
 * false positive refuses a note, which is the safe direction, and a nested key
 * is indented so it never matches.
 */
const TASK_TYPE_LINE = /^["']?type["']?[ \t]*:[ \t]*["']?task["']?[ \t]*(?:#.*)?$/m;

/** True when the note's frontmatter declares itself a task. Never throws. */
function declaresTaskType(content: string): boolean {
  const note = splitNote(content);
  return note !== null && TASK_TYPE_LINE.test(note.frontmatter);
}

/**
 * A pure transformation of a note's validated provenance frontmatter --
 * bump `updated`, set `lastReviewed`, and so on. Receives a value that has
 * already passed `NoteFrontmatterSchema`, and must return one too.
 */
export type ProvenanceMutation = (current: NoteFrontmatter) => NoteFrontmatter;

/**
 * Applies `mutate` to a managed note's provenance frontmatter and writes
 * the result through {@link applyConflictSafeUpdate}, leaving the note body
 * byte-for-byte untouched.
 *
 * The rebuilt block is serialized ENTIRELY through
 * {@link ./frontmatter-serializer.js}, which walks
 * `NOTE_FRONTMATTER_KEY_ORDER` (and `GENERATED_BY_KEY_ORDER` for the nested
 * map) emitting one key at a time on the same js-yaml the service reaches --
 * never through Obsidian's `stringifyYaml`, which the live UAT proved is a
 * DIFFERENT serializer that quotes, escapes and bares values differently
 * (GAP-1; see that module's header for the three classes and the table).
 * That shared engine plus the shared key arrays is what makes a plugin-side
 * update and a service-side `writeNote()` of the same note produce the same
 * bytes: the output is a function of the note's content alone.
 *
 * Writes exactly one file -- the note itself. See the module's
 * eventual-consistency note above for what that means for folder indexes.
 *
 * Returns `"refused"` for a task note (see above).
 *
 * @throws {InvalidManagedNoteError} when the current content is not a
 *   well-formed managed note. Nothing is written in that case.
 */
export async function updateNoteProvenance(
  vault: ProcessableVault,
  file: ManagedNoteFile,
  expectedPriorContent: string,
  mutate: ProvenanceMutation,
): Promise<ProvenanceUpdateResult> {
  // A task note carries keys this module does not own and a fixed order it
  // does not know: rewriting it here could reorder or strip them (D-30,
  // T-06-26). Refuse before any write; `tasks/task-update.ts` is the only
  // writer of task notes.
  if (declaresTaskType(expectedPriorContent)) return "refused";
  return applyConflictSafeUpdate(vault, file, expectedPriorContent, (current) => {
    const note = splitNote(current);
    if (!note) {
      throw new InvalidManagedNoteError(file.path, "no YAML frontmatter block found");
    }

    // Obsidian types `parseYaml` as returning `any`. Pinning it to
    // `unknown` here is the point at which hand-edited YAML stops being
    // trusted: nothing downstream can read a field off it until zod has
    // said what shape it is (threat T-02-08).
    const parsed: unknown = parseYaml(note.frontmatter);
    const validated = NoteFrontmatterSchema.safeParse(parsed);
    if (!validated.success) {
      throw new InvalidManagedNoteError(
        file.path,
        "frontmatter does not match the provenance schema",
        validated.error.issues,
      );
    }

    // The body is carried across verbatim -- this module rewrites the
    // frontmatter block and nothing else, so no prose byte can move. Keys
    // outside the provenance schema belong to the USER and are re-emitted
    // after the managed block rather than dropped (see
    // {@link passthroughKeys}).
    const managed = serializeManagedFrontmatter(mutate(validated.data));
    const extra = serializePassthroughFrontmatter(passthroughKeys(parsed));
    return `${FRONTMATTER_OPEN}${managed}${extra}${FRONTMATTER_CLOSE}${note.body}`;
  });
}
