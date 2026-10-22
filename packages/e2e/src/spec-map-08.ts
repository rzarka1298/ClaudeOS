import type { ItemPlan } from "./spec-map.js";
import type { OwnerWhy, ViaToken } from "./uat-tags.js";

/**
 * The Phase 8 item plan (plan 08-05, D-27): which spec file proves which item of 08-UAT.md. 39
 * items: 32 auto, 1 auto+look and 6 owner. The table equals the tags of the script
 * (spec-map-08.test.ts reads the script and compares), and the runner selects it when the
 * script's front matter names phase 08. The type-only import keeps spec-map.ts (which registers
 * this table) free of an import cycle.
 */

/** The phase number used in the mocha title prefix of the Phase 8 specs. */
export const UAT_PHASE_PREFIX_08 = "08";

const SPEC_DIR = "packages/e2e/specs";

function specPath(name: string): string {
  return `${SPEC_DIR}/${name}.e2e.ts`;
}

const OVERVIEW = specPath("overview-slice");
const SETTINGS_CORE = specPath("settings-core");
const SETTINGS_INTEGRATIONS = specPath("settings-integrations");
const HEALTH = specPath("health-drills");
const BUNDLE = specPath("bundle-export");

export const SPEC_FILES_08: readonly string[] = [
  OVERVIEW,
  SETTINGS_CORE,
  SETTINGS_INTEGRATIONS,
  HEALTH,
  BUNDLE,
];

function automated(
  number: number,
  runClass: "auto" | "auto+look",
  via: readonly ViaToken[],
  specFile: string,
): ItemPlan {
  return { number, runClass, via, ownerWhy: null, autoPart: null, specFile, profile: "standard" };
}

function owner(
  number: number,
  ownerWhy: OwnerWhy,
  autoPart: string | null,
  specFile: string | null,
): ItemPlan {
  return { number, runClass: "owner", via: [], ownerWhy, autoPart, specFile, profile: "standard" };
}

export const UAT_ITEM_PLAN_08: readonly ItemPlan[] = [
  // Overview slice (items 1 to 8)
  automated(1, "auto", ["dom", "store"], OVERVIEW),
  automated(2, "auto", ["dom"], OVERVIEW),
  automated(3, "auto", ["dom", "store"], OVERVIEW),
  automated(4, "auto", ["dom", "store"], OVERVIEW),
  automated(5, "auto", ["dom", "store"], OVERVIEW),
  automated(6, "auto", ["dom", "spy"], OVERVIEW),
  automated(7, "auto", ["dom", "proc"], OVERVIEW),
  automated(8, "auto", ["fs"], OVERVIEW),
  // Settings core (items 9 to 18)
  automated(9, "auto", ["dom"], SETTINGS_CORE),
  automated(10, "auto", ["dom", "store"], SETTINGS_CORE),
  automated(11, "auto", ["dom", "store"], SETTINGS_CORE),
  automated(12, "auto", ["dom"], SETTINGS_CORE),
  automated(13, "auto", ["dom", "fs"], SETTINGS_CORE),
  automated(14, "auto", ["dom"], SETTINGS_CORE),
  automated(15, "auto", ["dom", "proc"], SETTINGS_CORE),
  automated(16, "auto", ["dom"], SETTINGS_CORE),
  automated(17, "auto+look", ["dom", "shot"], SETTINGS_CORE),
  automated(18, "auto", ["fs", "log"], SETTINGS_CORE),
  // Settings integrations (items 19 to 21)
  automated(19, "auto", ["dom", "spy", "fs"], SETTINGS_INTEGRATIONS),
  automated(20, "auto", ["dom", "store", "fs"], SETTINGS_INTEGRATIONS),
  automated(21, "auto", ["dom", "store"], SETTINGS_INTEGRATIONS),
  // Health drills (items 22 to 30)
  automated(22, "auto", ["dom"], HEALTH),
  automated(23, "auto", ["dom", "proc"], HEALTH),
  automated(24, "auto", ["dom", "fs"], HEALTH),
  automated(25, "auto", ["dom", "fs"], HEALTH),
  automated(26, "auto", ["dom", "fs"], HEALTH),
  automated(27, "auto", ["dom", "store", "proc"], HEALTH),
  automated(28, "auto", ["dom", "store"], HEALTH),
  automated(29, "auto", ["dom", "spy"], HEALTH),
  automated(30, "auto", ["dom"], HEALTH),
  // Bundle export (items 31 to 33)
  automated(31, "auto", ["dom", "spy"], BUNDLE),
  automated(32, "auto", ["dom", "store"], BUNDLE),
  automated(33, "auto", ["dom", "spy", "fs"], BUNDLE),
  // Obsidian never attaches the settings dialog under a programmatic open (05.2 D-09), so the
  // owner walks the native tab; the Visual section's write is the automated part.
  owner(
    34,
    "settings-dialog",
    "the Visual section writes the same reducedMotion value the native tab reads",
    SETTINGS_CORE,
  ),
  // The native save sheet is outside the webdriver DOM; the stubbed dialog is the automated part.
  owner(
    35,
    "settings-dialog",
    "the stubbed dialog receives a bare default file name and the written bytes equal the preview",
    BUNDLE,
  ),
  // The no-prompt claim needs the real keychain (D-38); the sandbox stub proves presence only.
  owner(
    36,
    "real-session",
    "the presence check reports a ledgered sandbox account present and then absent without reading its value",
    HEALTH,
  ),
  owner(37, "real-session", null, null),
  owner(38, "real-session", null, null),
  owner(39, "decision", null, null),
];
