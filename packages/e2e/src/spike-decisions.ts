/**
 * The launch decision and the spike-derived switches the rest of the live-UAT
 * phase reads (05.2-01 Task 4). The parent orchestrator edits this file after it
 * runs spikes S0 to S6, and edits the 'Spike decisions' block in
 * 05.2-RESEARCH.md to match; spike-decisions.test.ts pins the two together so the
 * code cannot drift from the record.
 */

/** binaryPath launches the installed app (L-3); installer downloads the pinned installer. */
export type LaunchMode = "binaryPath" | "installer";
export type BannerAutomation = "spy-and-region" | "spy-only";
export type ProtocolDispatch = "in-process" | "onclick-only";
export type ReducedMotion = "emulated" | "setting-only";
export type FocusActivation = "activate-window" | "none";
export type SpecLoading = "bundled" | "compiled";
export type Coexistence = "verified" | "unverified";
export type DecisionStatus = "provisional" | "recorded";

export interface SpikeDecisions {
  launch: LaunchMode;
  /** The Obsidian app version the runner aims at (D-08). */
  appVersion: string;
  /** The Obsidian installer version used when launch is installer, or recorded for the report. */
  installerVersion: string;
  bannerAutomation: BannerAutomation;
  protocolDispatch: ProtocolDispatch;
  reducedMotion: ReducedMotion;
  focusActivation: FocusActivation;
  specLoading: SpecLoading;
  coexistence: Coexistence;
  /** SHA-256 of the downloaded app archive in the cache (Q2: pinned, checksummed, fail loud). */
  obsidianCacheSha256: string | null;
  status: DecisionStatus;
}

/** The CONTEXT defaults (L-3, D-08) in force before any spike has run. Never edited. */
export const PROVISIONAL_SPIKE_DECISIONS: Readonly<SpikeDecisions> = Object.freeze({
  launch: "binaryPath",
  appVersion: "1.14.4",
  installerVersion: "1.13.7",
  bannerAutomation: "spy-and-region",
  protocolDispatch: "in-process",
  reducedMotion: "emulated",
  focusActivation: "activate-window",
  specLoading: "bundled",
  coexistence: "unverified",
  obsidianCacheSha256: null,
  status: "provisional",
});

/** The decisions in force. The orchestrator replaces these values when it records the spikes. */
export const SPIKE_DECISIONS: Readonly<SpikeDecisions> = Object.freeze({
  ...PROVISIONAL_SPIKE_DECISIONS,
});
