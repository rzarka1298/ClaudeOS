import type { ItemPlan } from "./spec-map.js";
import type { OwnerWhy, ViaToken } from "./uat-tags.js";

/**
 * The Phase 7 item plan (plan 07-17, D-28, research Pitfall 13): which spec file proves which item
 * of 07-UAT.md. 24 items: 19 auto, 2 auto+look and 3 owner. The table equals the tags of the
 * script (spec-map-07.test.ts reads the script and compares), and the runner selects it when the
 * script's front matter names phase 07. The type-only import keeps spec-map.ts (which registers
 * this table) free of an import cycle.
 */

/** The phase number used in the mocha title prefix of the Phase 7 specs. */
export const UAT_PHASE_PREFIX_07 = "07";

const SPEC_DIR = "packages/e2e/specs";

function specPath(name: string): string {
  return `${SPEC_DIR}/${name}.e2e.ts`;
}

const CORE = specPath("research-core");
const HOSTILE = specPath("research-hostile");
const LIFECYCLE = specPath("research-lifecycle");
const VIEWS = specPath("research-views");

export const SPEC_FILES_07: readonly string[] = [CORE, HOSTILE, LIFECYCLE, VIEWS];

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

export const UAT_ITEM_PLAN_07: readonly ItemPlan[] = [
  automated(1, "auto", ["dom"], CORE),
  automated(2, "auto", ["dom", "store", "fs"], CORE),
  automated(3, "auto", ["fs", "store"], CORE),
  automated(4, "auto", ["dom", "fs"], CORE),
  automated(5, "auto", ["dom", "fs"], CORE),
  automated(6, "auto", ["dom", "fs", "store"], CORE),
  automated(7, "auto", ["dom", "fs", "store"], CORE),
  automated(8, "auto", ["dom", "store", "log"], CORE),
  automated(9, "auto", ["dom", "fs", "proc", "log"], HOSTILE),
  automated(10, "auto", ["dom"], HOSTILE),
  automated(11, "auto", ["dom", "store"], LIFECYCLE),
  automated(12, "auto", ["dom", "store", "proc"], LIFECYCLE),
  automated(13, "auto", ["fs", "store"], LIFECYCLE),
  automated(14, "auto", ["dom", "proc"], LIFECYCLE),
  automated(15, "auto+look", ["dom", "shot"], VIEWS),
  automated(16, "auto+look", ["dom", "shot"], VIEWS),
  automated(17, "auto", ["dom"], VIEWS),
  automated(18, "auto", ["dom"], VIEWS),
  automated(19, "auto", ["dom", "spy"], VIEWS),
  automated(20, "auto", ["dom"], VIEWS),
  automated(21, "auto", ["log", "fs"], LIFECYCLE),
  // The live run needs the owner's Anthropic key and live sources; the empty-key refusal is the
  // part a sandbox can prove (D-46, OD-3).
  owner(
    22,
    "real-session",
    "with an empty key account the run fails as summariser-unconfigured before any network call",
    CORE,
  ),
  // Whether it reads as an article is the owner's judgement; the container's computed styles
  // against the UI-SPEC article table are the automated part.
  owner(
    23,
    "perception",
    "the reading container's computed measure, leading and spacing match the UI-SPEC article table",
    VIEWS,
  ),
  owner(24, "decision", null, null),
];
