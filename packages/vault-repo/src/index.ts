// The managed Obsidian vault's sole service-side writer. Pure filesystem:
// nothing here imports `obsidian`, so this package stays consumable by a
// future non-Obsidian desktop shell (PRD §9.4) and by the companion
// service running with Obsidian closed.

/** The managed Obsidian vault: `global/` and `workspaces/<id>/` scopes. */
export interface VaultRepository {
  readonly vaultRoot: string;
}

export { AtomicWriteError, atomicWriteFileSync } from "./atomic-write.js";
export type { ParsedNote } from "./frontmatter.js";
export { InvalidNoteFrontmatterError, parseNote, stringifyNote } from "./frontmatter.js";
export type {
  IndexIdentity,
  RegeneratedIndex,
  RegenerateIndexOptions,
} from "./index-generation.js";
export { IndexOutsideVaultError, regenerateIndex } from "./index-generation.js";
export { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";
export type { WriteNoteOptions, WrittenNote } from "./write-note.js";
export { writeNote } from "./write-note.js";
