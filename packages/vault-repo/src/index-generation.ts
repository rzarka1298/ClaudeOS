import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkPathContainment } from "@ccc/domain";
import matter from "gray-matter";
import { atomicWriteFileSync } from "./atomic-write.js";
import { parseNote } from "./frontmatter.js";

/** The one generated file this module owns, in every managed folder. */
const INDEX_FILENAME = "index.md";

/**
 * Fixed key order for the index's OWN frontmatter, for the same reason
 * `NOTE_FRONTMATTER_KEY_ORDER` exists: JavaScript preserves string-key
 * insertion order, so the only thing pinning YAML key order is the order a
 * writer inserts keys — and "byte-identical on re-run" (VAULT-03) is a
 * product requirement, not a style preference.
 *
 * Deliberately timestamp-free. An index carries no `generatedAt`, because
 * a clock value would make every regeneration differ from the last and
 * make the determinism contract unsatisfiable by construction. `index.md`
 * is a derived artifact and is exempt from the full VAULT-07 provenance
 * schema (ADR-0022, plan 02-06).
 */
const INDEX_FRONTMATTER_KEY_ORDER = [
  "type",
  "generated",
  "folder",
  "workspaceId",
  "displayName",
] as const;

/**
 * Thrown when the folder handed to {@link regenerateIndex} is neither the
 * managed vault root nor a descendant of it. Generation writes a file, so
 * it gets the same containment discipline every other write in this
 * package gets — a caller cannot use index regeneration as a way to write
 * outside the vault.
 */
export class IndexOutsideVaultError extends Error {
  readonly folderPath: string;

  constructor(folderPath: string) {
    super("index target folder is outside the managed vault");
    this.name = "IndexOutsideVaultError";
    this.folderPath = folderPath;
  }
}

/**
 * The workspace-root identity keys an index preserves across regeneration.
 * They are the ONLY thing an index ever reads back from its own previous
 * output — the listing itself is always rebuilt from a fresh frontmatter
 * scan, never patched.
 */
export interface IndexIdentity {
  readonly workspaceId: string;
  readonly displayName: string;
}

/** Everything {@link regenerateIndex} needs beyond the folder itself. */
export interface RegenerateIndexOptions {
  /** The managed vault's root; the index's `folder` key is relative to it. */
  readonly vaultRoot: string;
  /** Supply at workspace-root creation; omitted, identity is preserved. */
  readonly identity?: IndexIdentity;
}

/** What one regeneration produced, so callers never re-read the file. */
export interface RegeneratedIndex {
  /** Absolute path of the `index.md` that was written. */
  readonly path: string;
  /** The exact bytes written, as a string. */
  readonly content: string;
  /** How many direct-child notes were listed. */
  readonly noteCount: number;
  /** Filenames of children whose frontmatter failed validation. */
  readonly unreadable: readonly string[];
}

/** One listable note, reduced to exactly the fields a row needs. */
interface IndexRow {
  readonly filename: string;
  readonly basename: string;
  readonly id: string;
  readonly stage: string;
  readonly created: string;
  readonly updated: string;
}

/**
 * Collapses a frontmatter-derived value to a single line before it is
 * interpolated into a Markdown row (threat T-02-04).
 *
 * Without this, a note whose `updated` field contained a newline could
 * emit a second `- [[...]]` line and forge an index entry for a note that
 * does not exist — the index is read by other tools, so a forged row is a
 * tampering primitive, not a cosmetic glitch. Newlines become a space
 * rather than being deleted outright so two words cannot be silently
 * glued into one token.
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Total order over index rows: `created` ascending, `id` as the tiebreak,
 * filename as the final tiebreak.
 *
 * The comparator is explicit — and plain `<`/`>` rather than
 * `localeCompare`, whose result depends on ICU collation — precisely so
 * that filesystem enumeration order can never reach the output. APFS
 * returns directory entries in something close to creation order, which is
 * stable enough to look deterministic in testing and is not.
 *
 * The filename tiebreak matters even though it looks redundant: two notes
 * CAN share an id (a duplicated file is exactly what the repair command in
 * plan 02-06 exists to detect), and without a final discriminator those
 * two rows would be ordered by whatever readdir returned.
 */
function compareRows(a: IndexRow, b: IndexRow): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
  return 0;
}

/** Direct-child `*.md` files, excluding `index.md` and dotfiles. Never
 * recursive: walking the tree is the repair command's job (plan 02-06),
 * and an index describes its own folder only. */
function listCandidateFiles(folderPath: string): string[] {
  return readdirSync(folderPath).filter((name) => {
    if (name.startsWith(".")) return false;
    if (name === INDEX_FILENAME) return false;
    if (!name.endsWith(".md")) return false;
    try {
      return statSync(join(folderPath, name)).isFile();
    } catch {
      // A broken symlink or an entry deleted between readdir and stat is
      // simply not a note; it must not abort the whole regeneration.
      return false;
    }
  });
}

/**
 * Recovers `workspaceId`/`displayName` from an existing index.
 *
 * This is the SOLE read-back of a previous index anywhere in this module.
 * Everything else is recomputed from the folder, which is what keeps the
 * full-recompute contract intact: there is no "read the old index, patch
 * it" step for a concurrent writer to race against (research Pitfall 3).
 */
function readIdentity(indexPath: string): IndexIdentity | undefined {
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const data = matter(raw).data as Record<string, unknown>;
    const workspaceId = data.workspaceId;
    const displayName = data.displayName;
    if (typeof workspaceId !== "string" || typeof displayName !== "string") return undefined;
    return { workspaceId, displayName };
  } catch {
    // A corrupt index has no identity to preserve. Regeneration still
    // replaces it — that is the whole point of a derived artifact.
    return undefined;
  }
}

/** The folder's path relative to the vault root, in POSIX separators so
 * the generated file reads the same on any platform. */
function folderKey(resolvedRoot: string, resolvedFolder: string): string {
  const rel = relative(resolvedRoot, resolvedFolder);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/** Resolves and validates the target folder, returning the real paths the
 * rest of generation works from. */
function resolveFolder(folderPath: string, vaultRoot: string): [string, string] {
  const containment = checkPathContainment(folderPath, vaultRoot);
  if (containment.contained) {
    return [realpathSync.native(vaultRoot), containment.resolved];
  }
  // `is-root` means the candidate resolved to the vault root itself. The
  // root is a managed folder like any other and gets an index; every other
  // rejection reason is a genuine escape.
  if (containment.reason === "is-root") {
    const resolvedRoot = realpathSync.native(vaultRoot);
    return [resolvedRoot, resolvedRoot];
  }
  throw new IndexOutsideVaultError(folderPath);
}

/** Assembles the Markdown body. Split out so the ordering of sections is
 * readable in one place — it is part of the byte-level contract. */
function buildBody(rows: readonly IndexRow[], unreadable: readonly string[]): string {
  const lines: string[] = ["# Index", "", "## Notes", ""];

  if (rows.length === 0) {
    lines.push("_No notes yet._", "");
  } else {
    for (const row of rows) {
      lines.push(
        `- [[${singleLine(row.basename)}]] — id \`${singleLine(row.id)}\` · stage \`${singleLine(
          row.stage,
        )}\` · updated ${singleLine(row.updated)}`,
      );
    }
    lines.push("");
  }

  if (unreadable.length > 0) {
    lines.push("## Unreadable", "");
    for (const filename of unreadable) {
      // Filename only: a note whose frontmatter failed validation has no
      // trustworthy metadata to quote, and omitting it entirely would hide
      // a real file from anyone reading the index.
      lines.push(`- \`${singleLine(filename)}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Regenerates one managed folder's `index.md` from scratch (VAULT-03).
 *
 * Full recompute, never an incremental patch: every direct-child note's
 * frontmatter is re-read, the listing is rebuilt in one fixed sort order,
 * and the result replaces `index.md` atomically. Re-running over an
 * unchanged folder produces a BYTE-identical file — that property is what
 * makes idempotent setup (VAULT-02) and index repair (VAULT-04) provable
 * rather than merely claimed.
 *
 * Note bodies are never consulted, only frontmatter, so generation is
 * read-only with respect to note prose on the ordinary write path just as
 * it is on the repair path.
 */
export function regenerateIndex(
  folderPath: string,
  options: RegenerateIndexOptions,
): RegeneratedIndex {
  const [resolvedRoot, resolvedFolder] = resolveFolder(folderPath, options.vaultRoot);
  const indexPath = join(resolvedFolder, INDEX_FILENAME);
  const identity = options.identity ?? readIdentity(indexPath);

  const rows: IndexRow[] = [];
  const unreadable: string[] = [];

  for (const filename of listCandidateFiles(resolvedFolder)) {
    try {
      const { frontmatter } = parseNote(readFileSync(join(resolvedFolder, filename), "utf8"));
      rows.push({
        filename,
        basename: filename.slice(0, -".md".length),
        id: frontmatter.id,
        stage: frontmatter.stage,
        created: frontmatter.created,
        updated: frontmatter.updated,
      });
    } catch {
      // Unreadable, not absent: a note that fails validation is surfaced
      // by name rather than crashing generation (which would leave the
      // whole folder without an index) or being silently dropped (which
      // would make the index lie about what is on disk).
      unreadable.push(filename);
    }
  }

  rows.sort(compareRows);
  unreadable.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));

  const values: Record<string, string> = {
    type: "index",
    generated: "claude-command-center",
    folder: folderKey(resolvedRoot, resolvedFolder),
    ...(identity === undefined
      ? {}
      : { workspaceId: identity.workspaceId, displayName: identity.displayName }),
  };
  const frontmatter: Record<string, string> = {};
  for (const key of INDEX_FRONTMATTER_KEY_ORDER) {
    const value = values[key];
    if (value !== undefined) frontmatter[key] = value;
  }

  const content = matter.stringify(buildBody(rows, unreadable), frontmatter);
  atomicWriteFileSync(indexPath, content);

  return { path: indexPath, content, noteCount: rows.length, unreadable };
}
