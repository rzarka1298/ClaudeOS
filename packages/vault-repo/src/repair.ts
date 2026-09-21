import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkPathContainment, type NoteFrontmatter } from "@ccc/domain";
import {
  InvalidNoteFrontmatterError,
  parseNote,
  parseUntrustedFrontmatter,
} from "./frontmatter.js";
import { regenerateIndex, WorkspaceIdentityUnreadableError } from "./index-generation.js";
import { computeSetupEntries, VaultRootMissingError } from "./setup.js";

/** The one generated file repair rewrites, and the one it never reads as a note. */
const INDEX_FILENAME = "index.md";

/** The managed root beneath which every workspace tree lives. */
const WORKSPACES_FOLDER = "workspaces";

/**
 * Pulls the note id out of one generated index row.
 *
 * The shape is the one `index-generation.ts` writes
 * (``- [[basename]] — id `<id>` · stage `<stage>` · updated <updated>``),
 * matched loosely enough that a HAND-EDITED row still parses — which is the
 * only kind of row an orphan check ever finds something in, since a
 * generated index by construction lists only notes that were on disk when
 * it was written.
 */
const INDEX_ROW_ID = /^-\s+\[\[.*?\]\].*?\bid\s+`([^`]+)`/;

/**
 * The four conditions repair FLAGS rather than resolves.
 *
 * Every one of them is a state where the vault's ground truth is ambiguous,
 * and repair's contract is to surface the ambiguity with enough detail for a
 * human to settle it — never to pick a winner. This mirrors the operational
 * store's `SchemaAheadOfCodeError` discipline: a tool that silently guesses
 * on an ambiguous input is worse than one that refuses, because the guess is
 * invisible.
 *
 * `index-not-regenerated` is the newest and the least obvious: an index
 * this pass could not rebuild. The case that motivated it is a
 * workspace-root `index.md` whose YAML no longer parses — `displayName`
 * lives ONLY there, is not recoverable from anywhere else, and regenerating
 * over it would erase the workspace's name during the very command a user
 * runs to recover from damage.
 */
export type RepairWarningKind =
  | "duplicate-id"
  | "orphaned-index-entry"
  | "invalid-frontmatter"
  | "index-not-regenerated";

/** One flagged condition, carrying every path involved in it. */
export interface RepairWarning {
  readonly kind: RepairWarningKind;
  /** Vault-relative, POSIX-separated paths, sorted. */
  readonly paths: readonly string[];
  /** Human-readable specifics; deterministic for a given vault state. */
  readonly detail: string;
}

/** One valid note the walk found, reduced to what a cache rebuild needs. */
export interface RepairedNote {
  /** Vault-relative, POSIX-separated path of the note file. */
  readonly path: string;
  readonly frontmatter: NoteFrontmatter;
}

/** What one {@link repairVault} run found and regenerated. */
export interface RepairReport {
  /** Valid, unambiguous notes, sorted by `created`, then `id`, then path. */
  readonly notes: readonly RepairedNote[];
  /** Flagged conditions, sorted by kind, then path, then detail. */
  readonly warnings: readonly RepairWarning[];
}

/** Total order over plain strings. Deliberately not `localeCompare`, whose
 * result depends on ICU collation — the same reason `index-generation.ts`
 * spells its comparator out. */
function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Vault-relative and POSIX-separated: the single path vocabulary the
 * report speaks, so a caller can compare a warning against a note record
 * without re-deriving anything. */
function toVaultRelative(vaultRoot: string, absolute: string): string {
  const rel = relative(vaultRoot, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/**
 * Sorted subdirectory names, dot-directories excluded (`.obsidian/` and
 * friends are Obsidian's, not ours) and anything whose REAL path leaves the
 * vault excluded too.
 *
 * The containment filter is the read-side half of VAULT-10 / threat
 * T-02-01, and it is not optional: `statSync` follows symbolic links, so
 * without it a symlinked directory dropped into a managed folder is walked
 * as though it were vault content. The consequences are both real — files
 * outside the approved root get reported as vault notes (and land in the
 * operational store under a vault-relative path that misrepresents where
 * they actually live), and an escaping folder under `workspaces/` makes
 * `regenerateIndex` refuse a target it was never allowed to write.
 *
 * Every WRITE in this package already resolves through
 * `checkPathContainment`; this is the same discipline applied to the walk.
 */
function listSubdirectories(dir: string, vaultRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (name.startsWith(".")) return false;
      const child = join(dir, name);
      if (!isDirectory(child)) return false;
      return checkPathContainment(child, vaultRoot).contained;
    })
    .sort(compareStrings);
}

/**
 * Depth-first descent from each root, explicitly sorted at every level and
 * deduplicated by REAL path.
 *
 * The dedup matters because the managed folder list is genuinely nested
 * (`global` and `global/raw` are both entries), so a naive walk would visit
 * — and therefore COUNT — the same note twice, turning every note under a
 * nested managed folder into a phantom duplicate-id warning.
 *
 * Keying it on the real path rather than the joined string is what makes a
 * directory-symlink CYCLE terminate here rather than at whatever depth the
 * kernel happens to give up at (macOS returns `ELOOP` after ~32
 * resolutions, which is an accident of the platform, not a guarantee this
 * code may lean on). The ORDERED list still carries the joined path, so
 * every vault-relative path in the report stays expressed in the caller's
 * vocabulary.
 */
function descend(roots: readonly string[], vaultRoot: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync.native(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    ordered.push(dir);
    for (const name of listSubdirectories(dir, vaultRoot)) visit(join(dir, name));
  };
  for (const root of roots) {
    if (isDirectory(root)) visit(root);
  }
  return ordered;
}

/**
 * Sorted direct-child `*.md` files, excluding `index.md`, dotfiles, and any
 * entry whose real path is outside the vault.
 *
 * Same reasoning as {@link listSubdirectories}: a symlinked `.md` file is
 * not vault content, and reporting one would put a path that lies about
 * where the file lives into the cache every consumer reads.
 */
function listNoteFiles(dir: string, vaultRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (name.startsWith(".")) return false;
      if (name === INDEX_FILENAME) return false;
      if (!name.endsWith(".md")) return false;
      const child = join(dir, name);
      try {
        if (!statSync(child).isFile()) return false;
      } catch {
        // A broken symlink, or an entry deleted between readdir and stat,
        // is simply not a note; it must not abort the repair.
        return false;
      }
      return checkPathContainment(child, vaultRoot).contained;
    })
    .sort(compareStrings);
}

/** Every note id an existing index CLAIMS to list, in file order. */
function readIndexNoteIds(indexPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = INDEX_ROW_ID.exec(line);
    const id = match?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** The specifics of one parse refusal, including the underlying issue where
 * there is one — "this note is invalid" is not actionable; naming the field
 * is. */
function describeParseFailure(error: unknown): string {
  if (error instanceof InvalidNoteFrontmatterError) {
    const issue = error.issues[0] as { message?: unknown } | undefined;
    const detail = typeof issue?.message === "string" ? `: ${issue.message}` : "";
    return `${error.message}${detail}`;
  }
  return "note could not be read";
}

/**
 * Best-effort recovery of the `id` a note CLAIMS, from frontmatter that
 * failed `NoteFrontmatterSchema`.
 *
 * Used for one purpose only: to keep a note that exists but did not
 * validate out of the orphan pass. The value is never written anywhere,
 * never used as a key in the returned records, and never treated as
 * ground truth — an unvalidated frontmatter has not earned that, which is
 * exactly why it is not in `pathsById` in the first place.
 *
 * The parse goes through the hardened reader, so recovering an id cannot
 * be the thing that reintroduces an eval on untrusted content.
 */
function recoverNoteId(raw: string): string | undefined {
  try {
    const id = parseUntrustedFrontmatter(raw).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The specifics of one index-regeneration refusal.
 *
 * Deterministic for a given vault state, like every other `detail` in this
 * report: two runs over the same damage must produce deep-equal reports, so
 * nothing here may quote a path, a clock value, or a stack.
 */
function describeIndexFailure(error: unknown): string {
  if (error instanceof WorkspaceIdentityUnreadableError) {
    return `${error.message}; displayName is stored nowhere else, so this index was left untouched — fix its YAML by hand${describeCause(error.cause)}`;
  }
  return error instanceof Error ? error.message : "index could not be regenerated";
}

/** The underlying parse issue, where the refusal carries one. */
function describeCause(cause: unknown): string {
  if (cause instanceof InvalidNoteFrontmatterError) {
    const issue = cause.issues[0] as { message?: unknown } | undefined;
    if (typeof issue?.message === "string") return ` (${issue.message})`;
  }
  return "";
}

/**
 * Rebuilds every derived artifact in the managed vault from note
 * frontmatter (VAULT-04).
 *
 * The walk covers the same managed folder list {@link computeSetupEntries}
 * drives setup from, plus every existing `workspaces/<id>` subtree,
 * descending recursively — so a note stashed in a subfolder is still seen
 * by the duplicate check even though no index lists it.
 *
 * Read-only with respect to note bodies: the only file this function ever
 * writes is an `index.md`, and it writes those through the same
 * `regenerateIndex` the ordinary write path uses, so there is exactly one
 * index generator and no possibility of a repaired index differing from a
 * freshly-written one. Note frontmatter is READ; note files are never
 * rewritten, moved, or deleted — not even the invalid ones, which are
 * reported and left exactly as found.
 *
 * Ambiguity is flagged, never resolved (research Pitfall 4): a note id at
 * two paths yields one warning naming both and excludes BOTH from the
 * returned records, because a repair that quietly picked a winner would be
 * a data-loss mechanism wearing a maintenance command's name.
 *
 * The returned records are the second derived artifact: feeding
 * `report.notes` to `rebuildVaultNotes` repopulates the operational store's
 * `vault_notes` cache from the same single pass that rebuilt the indexes.
 * That composition deliberately happens in the SERVICE layer — this package
 * never imports `@ccc/operational-store` (ADR-0022, ADR-0019).
 */
export function repairVault(vaultRoot: string): RepairReport {
  if (!isDirectory(vaultRoot)) {
    throw new VaultRootMissingError(vaultRoot);
  }

  const managedRoots = computeSetupEntries(vaultRoot)
    .filter((entry) => entry.kind === "folder")
    .map((entry) => join(vaultRoot, ...entry.relativePath.split("/")));
  const managedRootSet = new Set(managedRoots);

  // Everything reachable in the managed tree gets SCANNED for notes; only
  // the fixed skeleton and the workspace trees get an index REGENERATED.
  // Repair rebuilds derived artifacts — it does not invent a managed folder
  // (and an index.md) inside a subfolder the user made for their own reasons.
  const workspacesPrefix = join(vaultRoot, WORKSPACES_FOLDER) + sep;
  const scanFolders = descend(managedRoots, vaultRoot);
  const indexFolders = scanFolders.filter(
    (folder) => managedRootSet.has(folder) || folder.startsWith(workspacesPrefix),
  );

  // Every pre-existing index is read BEFORE any regeneration: an orphaned
  // entry is a claim the OLD index made, and regeneration is precisely what
  // silences it.
  const listedIds = new Map<string, readonly string[]>();
  for (const folder of indexFolders) {
    const indexPath = join(folder, INDEX_FILENAME);
    const ids = readIndexNoteIds(indexPath);
    if (ids.length > 0) {
      listedIds.set(toVaultRelative(vaultRoot, indexPath), ids);
    }
  }

  const warnings: RepairWarning[] = [];
  const pathsById = new Map<string, string[]>();
  const frontmatterByPath = new Map<string, NoteFrontmatter>();
  // Ids belonging to notes that ARE on disk but did not validate. They are
  // deliberately kept out of `pathsById` (nothing may treat an unvalidated
  // frontmatter as ground truth), but the orphan pass must still know they
  // exist — see the loop below for why.
  const unparsedIds = new Set<string>();

  for (const folder of scanFolders) {
    for (const filename of listNoteFiles(folder, vaultRoot)) {
      const absolute = join(folder, filename);
      const notePath = toVaultRelative(vaultRoot, absolute);
      let raw: string;
      try {
        raw = readFileSync(absolute, "utf8");
      } catch {
        // Deleted between the listing and the read; not a note.
        continue;
      }
      try {
        const { frontmatter } = parseNote(raw);
        frontmatterByPath.set(notePath, frontmatter);
        const existing = pathsById.get(frontmatter.id);
        if (existing === undefined) {
          pathsById.set(frontmatter.id, [notePath]);
        } else {
          existing.push(notePath);
        }
      } catch (error) {
        warnings.push({
          kind: "invalid-frontmatter",
          paths: [notePath],
          detail: describeParseFailure(error),
        });
        const recovered = recoverNoteId(raw);
        if (recovered !== undefined) unparsedIds.add(recovered);
      }
    }
  }

  const notes: RepairedNote[] = [];
  for (const [id, paths] of pathsById) {
    if (paths.length > 1) {
      const collided = [...paths].sort(compareStrings);
      warnings.push({
        kind: "duplicate-id",
        paths: collided,
        detail: `note id ${id} appears at ${collided.length} paths; repair flags the collision and returns neither copy`,
      });
      continue;
    }
    const path = paths[0];
    if (path === undefined) continue;
    const frontmatter = frontmatterByPath.get(path);
    if (frontmatter === undefined) continue;
    notes.push({ path, frontmatter });
  }

  for (const [indexPath, ids] of listedIds) {
    for (const id of [...new Set(ids)].sort(compareStrings)) {
      if (pathsById.has(id)) continue;
      // A note whose frontmatter failed validation is NOT an orphan. The
      // file is right there; it just did not parse, and it already has an
      // `invalid-frontmatter` warning naming it. Reporting it a second
      // time as "not present anywhere in the vault" is a false statement,
      // and it sends the user looking for a deleted note that exists —
      // repair's entire value is the accuracy of this report.
      if (unparsedIds.has(id)) continue;
      warnings.push({
        kind: "orphaned-index-entry",
        paths: [indexPath],
        // "no readable note" rather than "not present anywhere": an id
        // whose file is so damaged that even its `id` could not be
        // recovered still lands here, and the report must not overstate
        // what was actually checked.
        detail: `index lists note id ${id}, which no readable note in the vault claims`,
      });
    }
  }

  for (const folder of indexFolders) {
    try {
      regenerateIndex(folder, { vaultRoot });
    } catch (error) {
      // Non-fatal BY DESIGN. This loop has already rewritten some indexes
      // by the time any one folder fails, so letting the failure propagate
      // would leave the vault half-repaired and the command permanently
      // failing until a human found the cause unaided. Flagging it keeps
      // every other derived artifact rebuilt and hands the user the one
      // folder that needs a decision.
      warnings.push({
        kind: "index-not-regenerated",
        paths: [toVaultRelative(vaultRoot, folder)],
        detail: describeIndexFailure(error),
      });
    }
  }

  notes.sort((a, b) => {
    if (a.frontmatter.created !== b.frontmatter.created) {
      return compareStrings(a.frontmatter.created, b.frontmatter.created);
    }
    if (a.frontmatter.id !== b.frontmatter.id) {
      return compareStrings(a.frontmatter.id, b.frontmatter.id);
    }
    // Path is a third tiebreak for the same reason index rows carry one:
    // without a final discriminator, two otherwise-identical records would
    // fall back to filesystem enumeration order.
    return compareStrings(a.path, b.path);
  });
  warnings.sort((a, b) => {
    if (a.kind !== b.kind) return compareStrings(a.kind, b.kind);
    const left = a.paths[0] ?? "";
    const right = b.paths[0] ?? "";
    if (left !== right) return compareStrings(left, right);
    return compareStrings(a.detail, b.detail);
  });

  return { notes, warnings };
}
