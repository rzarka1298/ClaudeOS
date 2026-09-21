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
export {
  InvalidNoteFrontmatterError,
  parseNote,
  parseUntrustedFrontmatter,
  stringifyNote,
} from "./frontmatter.js";
export type {
  IndexIdentity,
  RegeneratedIndex,
  RegenerateIndexOptions,
} from "./index-generation.js";
export {
  IndexOutsideVaultError,
  regenerateIndex,
  WorkspaceIdentityUnreadableError,
} from "./index-generation.js";
export type {
  RepairedNote,
  RepairReport,
  RepairWarning,
  RepairWarningKind,
} from "./repair.js";
export { repairVault } from "./repair.js";
export type {
  CreatedWorkspace,
  VaultSetupEntry,
  VaultSetupEntryKind,
  VaultSetupPlan,
  VaultSetupResult,
} from "./setup.js";
export {
  computeSetupEntries,
  createWorkspace,
  initializeVault,
  planVaultSetup,
  VaultRootMissingError,
} from "./setup.js";
export { VAULT_CLAUDE_MD } from "./vault-claude-md.js";
export { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";
export type { WriteNoteOptions, WrittenNote } from "./write-note.js";
export { writeNote } from "./write-note.js";
