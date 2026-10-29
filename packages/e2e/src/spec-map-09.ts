import type { ItemPlan } from "./spec-map.js";
import type { ViaToken } from "./uat-tags.js";

/**
 * The Phase 9 item plan (plan 09-21, D-17): which spec file proves which item of 09-UAT.md. The
 * table equals the tags of the script (spec-map-09.test.ts reads the script and compares), and the
 * runner selects it when the script's front matter names phase 09. The type-only import keeps
 * spec-map.ts (which registers this table) free of an import cycle.
 */

/** The phase number used in the mocha title prefix of the Phase 9 specs. */
export const UAT_PHASE_PREFIX_09 = "09";

const SPEC_DIR = "packages/e2e/specs";

function specPath(name: string): string {
  return `${SPEC_DIR}/${name}.e2e.ts`;
}

const HARDENING = specPath("hardening");

export const SPEC_FILES_09: readonly string[] = [HARDENING];

function automated(
  number: number,
  runClass: "auto" | "auto+look",
  via: readonly ViaToken[],
  specFile: string,
): ItemPlan {
  return { number, runClass, via, ownerWhy: null, autoPart: null, specFile, profile: "standard" };
}

export const UAT_ITEM_PLAN_09: readonly ItemPlan[] = [
  // A quiet idle session reads Idle, is not counted as running, and a new event restores Running.
  automated(1, "auto", ["dom"], HARDENING),
  // A quiet working session reads "No events for", not Running (R-04).
  automated(2, "auto", ["dom"], HARDENING),
  // Copy bundle's outcome sits in the bundle's own line, inside the viewport of its button (D-09).
  automated(3, "auto", ["dom", "spy"], HARDENING),
  // The disconnected banner shows a display path, never /Users/ (D-11).
  automated(4, "auto", ["dom", "proc"], HARDENING),
  // Settings > Security reads the presence check Unavailable in the sandbox (D-04).
  automated(5, "auto", ["dom", "fs"], HARDENING),
  // A test approval is approved with no prompt and reads decided through the command center (D-02).
  automated(6, "auto", ["dom", "fs"], HARDENING),
  // The Launchers and Today headings (folded polish).
  automated(7, "auto", ["dom"], HARDENING),
  // The Phase 7 research run still publishes one report after the pipeline split (D-12).
  automated(8, "auto", ["dom"], HARDENING),
];
