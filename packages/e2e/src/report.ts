import type { UatProfile } from "./profile.js";
import type { ItemResolution } from "./results.js";
import type { RunClass } from "./uat-tags.js";

export interface ReportRow {
  readonly number: number;
  readonly title: string;
  readonly runClass: RunClass;
  readonly resolution: ItemResolution;
}

export interface ReportInput {
  readonly runId: string;
  readonly profile: UatProfile;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly appVersion: string;
  readonly installerVersion: string;
  readonly gitHead: string;
  readonly gitClean: boolean;
  /** Exactly twelve hex characters. */
  readonly buildHash: string;
  readonly phasePrefix: string;
  readonly rows: readonly ReportRow[];
}

export function renderReport(_input: ReportInput): string {
  throw new Error("renderReport is not implemented yet (typed skeleton)");
}

export interface ReportPathInput {
  readonly phaseDir?: string | undefined;
  readonly phasePrefix: string;
  readonly out?: string | undefined;
}

/** The report file, an explicit --out path, or null (stdout) when no planning folder exists. */
export function resolveReportPath(_input: ReportPathInput): string | null {
  throw new Error("resolveReportPath is not implemented yet (typed skeleton)");
}
