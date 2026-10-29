import type { ItemPlan } from "./spec-map.js";
import type { OwnerWhy, ViaToken } from "./uat-tags.js";

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

function owner(number: number, ownerWhy: OwnerWhy): ItemPlan {
  return {
    number,
    runClass: "owner",
    via: [],
    ownerWhy,
    autoPart: null,
    specFile: null,
    profile: "standard",
  };
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
  // Owner items (D-17): what needs a person at the Mac, the real helper, the real Keychain items or
  // the real LaunchAgent. No automated run may touch any of them (T-09-46).
  // The real presence prompt: Touch ID or password gives verified, Cancel gives refused (D-01, APPR-11).
  owner(9, "real-session"),
  // The real LaunchAgent re-install three times in a row over a running service (D-10, SVC-12).
  owner(10, "real-session"),
  // Prompt counts at install and uninstall; Cancel keeps the old helper with a WARNING (FIX6B C1, C3).
  owner(11, "real-session"),
  // The live custody check against a throwaway Keychain item (09-15 test-custody.sh).
  owner(12, "real-session"),
  // A helper rebuilt without a re-enrol reads as stale and is recovered by the install (FIX6B M1).
  owner(13, "real-session"),
  // Pin adoption after an install, and the ten-minute marker window (FIX9).
  owner(14, "real-session"),
  // A pin swapped without a reinstall is refused and flagged (09-18, 09-19).
  owner(15, "real-session"),
  // The Security > Approval presence check row in each of its states (09-19).
  owner(16, "real-session"),
  // A real presence-required approval, Cancel leaving it pending (09-01 Task 3, 09-18).
  owner(17, "real-session"),
  // The foreign-delete measurement that decides whether verdict_sc2 may go back to met (FIX6B).
  owner(18, "decision"),
  // A shadow keychain with a decoy item does not win the pin read (FIX6B B2).
  owner(19, "real-session"),
];
