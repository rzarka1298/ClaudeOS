// The managed Obsidian vault's sole service-side writer. Pure filesystem:
// nothing here imports `obsidian`, so this package stays consumable by a
// future non-Obsidian desktop shell (PRD §9.4) and by the companion
// service running with Obsidian closed.

/** The managed Obsidian vault: `global/` and `workspaces/<id>/` scopes. */
export interface VaultRepository {
  readonly vaultRoot: string;
}

export { AtomicWriteError, atomicWriteFileSync } from "./atomic-write.js";
export type { ExtendedNoteReason } from "./extended-note.js";
export { ExtendedNoteError } from "./extended-note.js";
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
export type { TaskStatusCounts } from "./managed-folders.js";
export { emptyTaskCounts, MANAGED_FOLDERS, WORKSPACE_LEAF_FOLDERS } from "./managed-folders.js";
export {
  escapeMarkdownText,
  fenceUntrustedBlock,
  inlineCode,
  UNTRUSTED_FENCE_INFO,
} from "./markdown-escape.js";
export type {
  RepairedNote,
  RepairReport,
  RepairWarning,
  RepairWarningKind,
} from "./repair.js";
export { repairVault } from "./repair.js";
export type {
  FinaliseReportNoteOptions,
  ParsedReportNote,
  ReadReportResult,
  ReportNoteReason,
  WriteReportNoteOptions,
  WrittenReportNote,
} from "./report-note.js";
export {
  finaliseReportNote,
  parseReportNote,
  REPORT_NOTE_PATH_PATTERN,
  ReportNoteError,
  readReportNote,
  renderReportBody,
  reportNotePathFor,
  writeReportNote,
} from "./report-note.js";
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
export type {
  ParsedRawSourceNote,
  ParsedWikiSourceNote,
  ReadRawSourceResult,
  ReadWikiSourceResult,
  SourceNoteReason,
  WikiCitingItem,
  WriteRawSourceNoteOptions,
  WriteWikiSourceNoteOptions,
  WrittenRawSourceNote,
  WrittenWikiSourceNote,
} from "./source-note.js";
export {
  extractRawSnapshotText,
  parseRawSourceNote,
  parseWikiSourceNote,
  RAW_SOURCE_BANNER,
  readRawSourceNote,
  readWikiSourceNote,
  SourceNoteError,
  writeRawSourceNote,
  writeWikiSourceNote,
} from "./source-note.js";
export type {
  ParsedTaskNote,
  TaskNoteReason,
  WriteTaskNoteOptions,
  WrittenTaskNote,
} from "./task-note.js";
export {
  ensureTasksFolder,
  hashTaskNoteBytes,
  parseTaskNote,
  stringifyTaskNote,
  TaskNoteError,
  TaskNoteInvalidError,
  TaskNoteRefusedDelimiterError,
  TaskNoteTooLargeError,
  tasksFolderFor,
  writeTaskNote,
} from "./task-note.js";
export type {
  ScannedTask,
  TaskAttention,
  TaskAttentionReason,
  TaskScanResult,
} from "./task-scan.js";
export { scanTaskNotes } from "./task-scan.js";
export { VAULT_CLAUDE_MD } from "./vault-claude-md.js";
export { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";
export type { WriteNoteOptions, WrittenNote } from "./write-note.js";
export {
  ExtendedNoteWriteRefusedError,
  TasksFolderWriteRefusedError,
  writeNote,
} from "./write-note.js";
