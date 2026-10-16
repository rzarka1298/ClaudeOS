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
export type {
  HostileAnthropicReply,
  HostileItemTextAnswer,
} from "./hostile-summariser-replies.js";
export {
  HOSTILE_ANTHROPIC_REPLIES,
  HOSTILE_ITEM_TEXT_ANSWERS,
  ITEM_TEXT_ID_A,
  ITEM_TEXT_ID_B,
} from "./hostile-summariser-replies.js";
export type {
  FixtureManifestEntry,
  ResearchFixtureDir,
  ResearchFixtureDirOptions,
} from "./research-fixture-dir.js";
export {
  buildResearchFixtureDir,
  defaultManifestEntries,
  FIXTURE_ATOM,
  FIXTURE_ATOM_LABEL,
  FIXTURE_ATOM_URL,
  FIXTURE_PAGE,
  FIXTURE_PAGE_LABEL,
  FIXTURE_PAGE_URL,
  FIXTURE_RSS,
  FIXTURE_RSS_LABEL,
  FIXTURE_RSS_URL,
  FIXTURE_SOURCES,
  writeResearchSourcesFile,
} from "./research-fixture-dir.js";
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
