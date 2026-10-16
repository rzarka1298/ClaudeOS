/**
 * The research pipeline's public surface (plan 07-12). The composition root (plan 07-14) builds
 * the services from here; `@ccc/test-fixtures` imports it as `@ccc/service/research` to drive the
 * real pipeline in-process with a scripted fetcher and a fake or extractive transport.
 */

export type { TextTransport } from "../untrusted/index.js";
export { DEFAULT_RESEARCH_CONFIG } from "./default-sources.js";
export { createExtractiveTransport } from "./extractive-transport.js";
export type {
  FetchSourceInput,
  FetchSourceResult,
  RunBudget,
  SafeFetcher,
} from "./fetch/index.js";
export type { FixtureFetcherOptions, FixtureFs } from "./fixture-fetcher.js";
export {
  createFixtureFetcher,
  FIXTURE_DELAY_MAX_MS,
  FIXTURE_MANIFEST_FILE,
  FIXTURE_MANIFEST_MAX_BYTES,
} from "./fixture-fetcher.js";
export { contentHashFor, newNonce, sourceIdFor } from "./hash.js";
export type { ResearchOverrideCode } from "./override-error.js";
export { ResearchOverrideError } from "./override-error.js";
export type {
  PipelineLog,
  PipelineResult,
  ResearchPipelineDeps,
  RunTrace,
  SummariserChoice,
  Watchdog,
} from "./pipeline.js";
export {
  checkDelimited,
  createRunTrace,
  executeResearchRun,
  runResearchPipeline,
  summariseSources,
  trimToInputCap,
} from "./pipeline.js";
export type { PipelineEffect } from "./pipeline-effects.js";
export { PIPELINE_EFFECTS } from "./pipeline-effects.js";
export { reportContentDigest } from "./report-digest.js";
export type { RunNoteInput, WrittenRunNote } from "./run-note.js";
export { renderRunNote, runNotePathFor, writeRunNote } from "./run-note.js";
export type {
  ConfiguredSources,
  ResearchResult,
  ResearchServices,
  ResearchServicesDeps,
  RunNowValue,
} from "./services.js";
export {
  createResearchServices,
  RESEARCH_WATCHDOG_MS,
  recoverStuckResearchRuns,
} from "./services.js";
export type { LoadSourcesResult, ResearchSourcesFs, SourcesRefusal } from "./sources-config.js";
export {
  loadResearchSources,
  peekResearchSources,
  RESEARCH_SOURCES_FILE,
  RESEARCH_SOURCES_MAX_BYTES,
} from "./sources-config.js";
export type { ResearchRouteResult, ResearchRouteServices } from "./types.js";
