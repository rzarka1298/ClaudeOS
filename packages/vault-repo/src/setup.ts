import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newWorkspaceId, type WorkspaceId } from "@ccc/domain";
import { atomicWriteFileSync } from "./atomic-write.js";
import { regenerateIndex } from "./index-generation.js";
import {
  emptyTaskCounts,
  isTasksFolderPath,
  MANAGED_FOLDERS,
  WORKSPACE_LEAF_FOLDERS,
} from "./managed-folders.js";
import { scanTaskNotes, type TaskScanResult } from "./task-scan.js";
import { VAULT_CLAUDE_MD } from "./vault-claude-md.js";

/** The generated listing every managed folder carries. */
const INDEX_FILENAME = "index.md";

/** The vault-level navigation file (VAULT-11), at the vault root. */
const CLAUDE_MD_FILENAME = "CLAUDE.md";

/** What one planned entry is: a directory, a generated index, or the
 * vault-level navigation file. */
export type VaultSetupEntryKind = "folder" | "index" | "claude-md";

/** One path setup would touch, and whether it is already there. */
export interface VaultSetupEntry {
  /** Vault-relative, POSIX-separated, e.g. `global/raw` or `inbox/index.md`. */
  readonly relativePath: string;
  readonly kind: VaultSetupEntryKind;
  /** Snapshot taken when the plan was computed. */
  readonly exists: boolean;
}

/** The show-paths-first contract (VAULT-01): exactly what setup would do. */
export interface VaultSetupPlan {
  readonly vaultRoot: string;
  readonly entries: readonly VaultSetupEntry[];
}

/** What one {@link initializeVault} run actually found and made. */
export interface VaultSetupResult {
  /** Vault-relative paths that did not exist before this run. */
  readonly created: readonly string[];
  /** Vault-relative paths that were already present. */
  readonly existing: readonly string[];
}

/** A newly minted workspace tree. */
export interface CreatedWorkspace {
  readonly workspaceId: WorkspaceId;
  /** Absolute path of `workspaces/<id>/`. */
  readonly path: string;
}

/**
 * Thrown when the vault root handed to setup does not exist, or exists but
 * is not a directory.
 *
 * Setup deliberately refuses to create the root itself. Every other missing
 * path in the tree is something setup is FOR; the root is the one path that
 * is an input rather than an output, and a mistyped one must not silently
 * become a second, empty vault the user then cannot find (VAULT-01).
 */
export class VaultRootMissingError extends Error {
  readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    super("vault root does not exist");
    this.name = "VaultRootMissingError";
    this.vaultRoot = vaultRoot;
  }
}

/** Refuses a root that is absent or is not a directory. Both public
 * entry points assert this, so a plan can never describe a vault that the
 * corresponding apply would refuse. */
function assertVaultRoot(vaultRoot: string): void {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(vaultRoot).isDirectory();
  } catch {
    throw new VaultRootMissingError(vaultRoot);
  }
  if (!isDirectory) {
    throw new VaultRootMissingError(vaultRoot);
  }
}

/** Absolute path of a vault-relative, POSIX-separated entry path. */
function absolutePathOf(vaultRoot: string, relativePath: string): string {
  return join(vaultRoot, ...relativePath.split("/"));
}

/**
 * The single entry list both planning and applying walk — this shared
 * function is HOW "setup writes only what it displayed" holds by
 * construction rather than by two lists being kept in sync by hand
 * (prohibition 1, threat T-02-13).
 *
 * Fixed order, documented once here because it is the display contract:
 * every managed folder depth-first in PRD order, then every folder's
 * `index.md` in the same order, then the vault-level `CLAUDE.md`. Folders
 * precede their indexes because that is also the only order the apply can
 * execute in — an index cannot be written into a directory that does not
 * exist yet.
 *
 * Read-only. The `exists` flags are a snapshot taken at call time; nothing
 * here writes.
 */
export function computeSetupEntries(vaultRoot: string): readonly VaultSetupEntry[] {
  const entries: VaultSetupEntry[] = [];

  for (const folder of MANAGED_FOLDERS) {
    entries.push({
      relativePath: folder,
      kind: "folder",
      exists: existsSync(absolutePathOf(vaultRoot, folder)),
    });
  }
  for (const folder of MANAGED_FOLDERS) {
    const relativePath = `${folder}/${INDEX_FILENAME}`;
    entries.push({
      relativePath,
      kind: "index",
      exists: existsSync(absolutePathOf(vaultRoot, relativePath)),
    });
  }
  entries.push({
    relativePath: CLAUDE_MD_FILENAME,
    kind: "claude-md",
    exists: existsSync(absolutePathOf(vaultRoot, CLAUDE_MD_FILENAME)),
  });

  return entries;
}

/**
 * The show-paths-first contract (VAULT-01): returns every path
 * {@link initializeVault} would touch, each flagged with whether it is
 * already there, so a user can be shown the consequences before agreeing
 * to them.
 *
 * PURE — a plan call writes nothing, creates nothing, and is safe to call
 * on a vault the user has not decided about yet. It refuses a missing root
 * for the same reason the apply does: a plan that could not be executed
 * would be describing a vault that will never exist.
 */
export function planVaultSetup(vaultRoot: string): VaultSetupPlan {
  assertVaultRoot(vaultRoot);
  return { vaultRoot, entries: computeSetupEntries(vaultRoot) };
}

/**
 * Creates the managed folder tree, regenerates every managed folder's
 * `index.md`, and seeds the vault-level `CLAUDE.md` (VAULT-01, VAULT-11).
 *
 * Safe to re-run forever (VAULT-02). Three separate properties add up to
 * that guarantee, and each is asserted in `setup.test.ts` rather than
 * argued for here:
 *
 * - `mkdirSync(..., { recursive: true })` does not error on an existing
 *   directory, so the tree converges rather than colliding.
 * - `index.md` is a derived artifact that is always the service's to
 *   rewrite, and `regenerateIndex` is byte-deterministic, so regenerating
 *   an unchanged folder produces the identical file.
 * - `CLAUDE.md` is CREATE-ONLY. Once it exists it is user-authored content,
 *   and setup's whole contract is that it never overwrites that.
 *
 * Every other path in the vault is untouched BY CONSTRUCTION — the loop
 * below iterates the same entry list {@link planVaultSetup} displays, so
 * there is no path setup can write that the plan did not name.
 */
export function initializeVault(vaultRoot: string): VaultSetupResult {
  assertVaultRoot(vaultRoot);

  // One snapshot, taken before anything is written: the created/existing
  // split must describe the vault as the caller found it, not as each
  // successive write leaves it.
  const entries = computeSetupEntries(vaultRoot);
  const created: string[] = [];
  const existing: string[] = [];
  for (const entry of entries) {
    (entry.exists ? existing : created).push(entry.relativePath);
  }

  // Walked at most once, and only if a tasks folder is among the entries: the
  // summary index of a tasks folder carries counts that only a full walk of
  // the tasks can give (setup, repair and rebuild are the only walkers).
  let taskScan: TaskScanResult | undefined;

  for (const entry of entries) {
    const target = absolutePathOf(vaultRoot, entry.relativePath);
    switch (entry.kind) {
      case "folder":
        mkdirSync(target, { recursive: true });
        break;
      case "index":
        // `regenerateIndex` takes the FOLDER, and derives the index path
        // itself; handing it the entry's parent keeps the one containment
        // check this package has in the path of every index write.
        {
          const folderKey = dirname(entry.relativePath);
          if (isTasksFolderPath(folderKey)) {
            taskScan ??= scanTaskNotes(vaultRoot);
            regenerateIndex(dirname(target), {
              vaultRoot,
              taskCounts: taskScan.folderCounts[folderKey] ?? emptyTaskCounts(),
            });
          } else {
            regenerateIndex(dirname(target), { vaultRoot });
          }
        }
        break;
      case "claude-md":
        if (!entry.exists) {
          atomicWriteFileSync(target, VAULT_CLAUDE_MD);
        }
        break;
    }
  }

  return { created, existing };
}

/**
 * Mints an opaque workspace ID and creates that workspace's knowledge tree:
 * `workspaces/<id>/{raw,wiki,output,tasks}`, each folder with a generated index,
 * and a workspace-root index carrying `workspaceId` and `displayName` in
 * its frontmatter.
 *
 * `displayName` reaches the frontmatter and NOTHING else (VAULT-09). The
 * ID comes from `newWorkspaceId()`, which takes no arguments precisely so
 * that no name can influence it — so a later rename is a single-field edit
 * to the workspace-root index, and regeneration carries that field forward
 * while recomputing every other byte. No path moves, no note is rewritten.
 *
 * Workspace creation is deliberately NOT part of {@link initializeVault}:
 * setup owns the fixed skeleton, and a setup run must never invent or
 * modify a workspace.
 */
export function createWorkspace(vaultRoot: string, displayName: string): CreatedWorkspace {
  assertVaultRoot(vaultRoot);

  const workspaceId = newWorkspaceId();
  const workspacePath = join(vaultRoot, "workspaces", workspaceId);

  mkdirSync(workspacePath, { recursive: true });
  for (const leaf of WORKSPACE_LEAF_FOLDERS) {
    mkdirSync(join(workspacePath, leaf), { recursive: true });
  }
  for (const leaf of WORKSPACE_LEAF_FOLDERS) {
    regenerateIndex(join(workspacePath, leaf), { vaultRoot });
  }
  // Identity is supplied only at creation. Every later regeneration reads
  // these two keys back off the index it is replacing (02-02's identity
  // mechanism), which is what lets the user edit `displayName` in place.
  regenerateIndex(workspacePath, { vaultRoot, identity: { workspaceId, displayName } });

  return { workspaceId, path: workspacePath };
}
