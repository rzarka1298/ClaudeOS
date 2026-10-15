export {
  FakeProposeForceTerminate,
  FakeSessionLaunchGuard,
  FakeSessionProjectLookup,
  FakeSessionTerminalLauncher,
} from "./fake-ports.js";
export type {
  HostileFetchHost,
  HostileFetchLocation,
  HostileFetchResponse,
  HostileFetchUrl,
  HostileFetchUrlCode,
} from "./hostile-fetch-targets.js";
export {
  HOSTILE_FETCH_ADDRESSES,
  HOSTILE_FETCH_HOSTS,
  HOSTILE_FETCH_LOCATIONS,
  HOSTILE_FETCH_RESPONSES,
  HOSTILE_FETCH_URLS,
  PUBLIC_FETCH_ADDRESSES,
} from "./hostile-fetch-targets.js";
export type { HostileModelAnswer } from "./hostile-model-answers.js";
export {
  HOSTILE_MODEL_ANSWERS,
  MODEL_ANSWER_ID_A,
  MODEL_ANSWER_ID_B,
} from "./hostile-model-answers.js";
export type { HostileReportText } from "./hostile-report-text.js";
export { HOSTILE_REPORT_RAW_SPANS, HOSTILE_REPORT_TEXTS } from "./hostile-report-text.js";
export type {
  HostileResearchCategory,
  HostileResearchEntry,
} from "./hostile-research-corpus.js";
export {
  HOSTILE_RESEARCH_CATEGORIES,
  HOSTILE_RESEARCH_CORPUS,
  HOSTILE_RESEARCH_NONCE,
  HOSTILE_RESEARCH_SOURCE_ID,
} from "./hostile-research-corpus.js";
export type { StartServiceForTestOptions, TestServiceHandle } from "./service-harness.js";
export {
  requestOverSocket,
  startServiceForTest,
} from "./service-harness.js";
export type { TempSocketDir } from "./socket-fixture.js";
export { withTempSocketDir } from "./socket-fixture.js";
export {
  DEFAULT_SYNTHETIC_SEED,
  generateSyntheticNotes,
  writeSyntheticVault,
} from "./synthetic-notes.js";
export type { TempVaultDir } from "./vault-fixture.js";
export { withTempVaultDir } from "./vault-fixture.js";
