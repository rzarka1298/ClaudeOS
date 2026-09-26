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
