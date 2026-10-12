import type { SpikeDecisions } from "./spike-decisions.js";

export interface VersionRecord {
  app: string;
  installer: string;
  mismatches: string[];
}

export interface ObservedVersions {
  app: string;
  installer: string;
}

type Decided = Pick<SpikeDecisions, "appVersion" | "installerVersion">;

export function reconcileVersions(
  _existing: VersionRecord | undefined,
  _observed: ObservedVersions,
  _decisions: Decided,
): VersionRecord {
  throw new Error("reconcileVersions is not implemented yet (typed skeleton)");
}

export function finalMismatches(_record: VersionRecord | undefined, _ranSpecs: boolean): string[] {
  throw new Error("finalMismatches is not implemented yet (typed skeleton)");
}

export function formatVersions(_record: VersionRecord): string {
  throw new Error("formatVersions is not implemented yet (typed skeleton)");
}

export function parseVersions(_text: string): VersionRecord | undefined {
  throw new Error("parseVersions is not implemented yet (typed skeleton)");
}
