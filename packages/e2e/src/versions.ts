import type { SpikeDecisions } from "./spike-decisions.js";

/**
 * The app and installer versions the sessions actually reported (05.2-09, D-08). Each spec's
 * wdio before hook reconciles what its session reports with what the run recorded so far and
 * with the decided versions; the CLI reads the final record, prints it in the report and fails
 * the run on any mismatch. The record holds version strings and fixed mismatch codes only.
 */

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

function add(codes: readonly string[], code: string): string[] {
  return codes.includes(code) ? [...codes] : [...codes, code];
}

/** The first observation is recorded; later ones are compared with it and with the decision. */
export function reconcileVersions(
  existing: VersionRecord | undefined,
  observed: ObservedVersions,
  decisions: Decided,
): VersionRecord {
  const record: VersionRecord = existing ?? {
    app: observed.app,
    installer: observed.installer,
    mismatches: [],
  };
  let mismatches = [...record.mismatches];
  if (existing !== undefined) {
    if (observed.app !== existing.app) mismatches = add(mismatches, "app-changed-between-specs");
    if (observed.installer !== existing.installer) {
      mismatches = add(mismatches, "installer-changed-between-specs");
    }
  }
  if (observed.app !== decisions.appVersion)
    mismatches = add(mismatches, "app-differs-from-decision");
  if (observed.installer !== decisions.installerVersion) {
    mismatches = add(mismatches, "installer-differs-from-decision");
  }
  return { app: record.app, installer: record.installer, mismatches };
}

/** A run that executed specs but recorded no versions has a mismatch of its own. */
export function finalMismatches(record: VersionRecord | undefined, ranSpecs: boolean): string[] {
  if (record === undefined) return ranSpecs ? ["not-observed"] : [];
  return [...record.mismatches];
}

export function formatVersions(record: VersionRecord): string {
  return `${JSON.stringify({ app: record.app, installer: record.installer, mismatches: record.mismatches })}\n`;
}

/** The record from a versions file, or undefined when the text is not one. */
export function parseVersions(text: string): VersionRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { app, installer, mismatches } = value as Record<string, unknown>;
  if (
    typeof app !== "string" ||
    typeof installer !== "string" ||
    !Array.isArray(mismatches) ||
    !mismatches.every((code) => typeof code === "string")
  ) {
    return undefined;
  }
  return { app, installer, mismatches: mismatches as string[] };
}
