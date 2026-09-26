export { applyMigrations, SchemaAheadOfCodeError } from "./migrate.js";
export type { OperationalStore } from "./open-store.js";
export { openStore } from "./open-store.js";
export type {
  InsertProjectResult,
  InsertScanRootResult,
  LauncherConfigRecord,
  NewProject,
  NewScanRoot,
  ProjectRecord,
  ScanRootRecord,
  StoredLauncherId,
} from "./project-store.js";
export {
  findProjectByPath,
  findScanRootByPath,
  getLauncherConfig,
  getProject,
  getScanRoot,
  insertProject,
  insertScanRoot,
  listLauncherConfigs,
  listProjects,
  listScanRoots,
  markLauncherTested,
  ProjectStoreValidationError,
  removeProject,
  removeScanRoot,
  renameProject,
  STORED_LAUNCHER_IDS,
  saveLauncherConfig,
  setGithubUrlOverride,
  setProjectPinned,
  setScanRootDepth,
  touchLastOpened,
  touchScanned,
} from "./project-store.js";
export type { RunKind, RunRecord } from "./run-store.js";
export {
  getRun,
  InvalidRunStateError,
  insertRun,
  listAllRuns,
  listNonTerminalRuns,
  updateRunState,
} from "./run-store.js";
export type { VaultNoteQuery, VaultNoteRecord } from "./vault-notes-store.js";
export {
  assertValidVaultNoteRecord,
  countVaultNotes,
  getVaultNote,
  InvalidVaultNoteError,
  queryVaultNotes,
  rebuildVaultNotes,
  upsertVaultNote,
} from "./vault-notes-store.js";
