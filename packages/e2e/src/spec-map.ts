import type { UatProfile } from "./profile.js";
import type { OwnerWhy, RunClass, ViaToken } from "./uat-tags.js";

/**
 * The single source for which spec file proves which Phase 6 item (D-09, D-13, E2E-10):
 * auto 18, auto+look 4, owner 4. Plans 05.2-06 to 05.2-08 create the spec files; plan 05.2-09
 * verifies that they exist and match this table.
 */

/** The phase number used in the mocha title prefix of the Phase 6 retrofit. */
export const UAT_PHASE_PREFIX = "06";

const SPEC_DIR = "packages/e2e/specs";

function specPath(name: string): string {
  return `${SPEC_DIR}/${name}.e2e.ts`;
}

export const SPEC_FILES = [
  specPath("approvals-core"),
  specPath("approvals-lifecycle"),
  specPath("tasks-core"),
  specPath("tasks-views"),
  specPath("tasks-scale"),
  specPath("cross-cutting"),
  specPath("notification-look"),
  specPath("synthetic-session"),
] as const;
export type SpecFile = (typeof SPEC_FILES)[number];

export interface ItemPlan {
  readonly number: number;
  readonly runClass: RunClass;
  /** The tools the runner uses; empty for owner items. */
  readonly via: readonly ViaToken[];
  readonly ownerWhy: OwnerWhy | null;
  readonly autoPart: string | null;
  /** One of SPEC_FILES, or null for an item with no spec. */
  readonly specFile: SpecFile | null;
  /** `full` items run only in the full profile (D-13). */
  readonly profile: UatProfile;
}

const CORE = specPath("approvals-core") as SpecFile;
const LIFECYCLE = specPath("approvals-lifecycle") as SpecFile;
const TASKS_CORE = specPath("tasks-core") as SpecFile;
const TASKS_VIEWS = specPath("tasks-views") as SpecFile;
const TASKS_SCALE = specPath("tasks-scale") as SpecFile;
const CROSS = specPath("cross-cutting") as SpecFile;
const LOOK = specPath("notification-look") as SpecFile;
const SYNTHETIC = specPath("synthetic-session") as SpecFile;

function automated(
  number: number,
  runClass: "auto" | "auto+look",
  via: readonly ViaToken[],
  specFile: SpecFile,
  profile: UatProfile = "standard",
): ItemPlan {
  return { number, runClass, via, ownerWhy: null, autoPart: null, specFile, profile };
}

function owner(
  number: number,
  ownerWhy: OwnerWhy,
  autoPart: string | null,
  specFile: SpecFile | null,
): ItemPlan {
  return { number, runClass: "owner", via: [], ownerWhy, autoPart, specFile, profile: "standard" };
}

export const UAT_ITEM_PLAN: readonly ItemPlan[] = [
  // The banner's own appearance cannot be captured while bannerAutomation is spy-only (no screen
  // region), so the item is owner-run with the spy checks as its automated partial (Codex review:
  // an auto+look item with no images could never be ratified).
  owner(
    1,
    "banner-appearance",
    "an unfocused window creates exactly one generic notification with a click handler and no request text",
    LOOK,
  ),
  owner(
    2,
    "banner-click",
    "the retained notification handler opens Approvals with the request selected and focus on Deny",
    CORE,
  ),
  owner(
    3,
    "focus",
    "the request is listed and the Agent runs count chip shows whatever a notification does",
    CORE,
  ),
  owner(
    4,
    "multi-window",
    "the mirror note carries the ccc-approval link and the handler selects the request",
    CORE,
  ),
  automated(5, "auto", ["dom", "spy"], CORE),
  automated(6, "auto", ["dom"], CORE),
  automated(7, "auto", ["dom", "store"], CORE),
  automated(8, "auto", ["dom", "store"], CORE),
  // The 15 second expiry walk closed the Obsidian window under the driver in every run (about 12 s
  // after launch, runs 6 to 13, also after a relaunch), so the item is owner-run (D-09 amendment 4).
  owner(9, "session-stability", null, null),
  automated(10, "auto", ["dom", "proc", "store"], LIFECYCLE),
  automated(11, "auto", ["dom", "proc", "store"], SYNTHETIC),
  // The walk reads the settings groups and looks at them, and the dialog never attaches under a
  // programmatic open (D-09 amendment 3, 2026-10-13); the rest of the walk is the automated part.
  owner(
    12,
    "settings-dialog",
    "the approvals pane, the banner text and the mirror note offer no remember, always-allow or skip wording and only Deny and Approve once",
    CROSS,
  ),
  // Obsidian never attaches the settings dialog under a programmatic open (containers=0 in live
  // runs 6 to 9), so the item cannot be driven; the owner walks it (D-09 amendment 2026-10-13).
  owner(13, "settings-dialog", null, null),
  automated(14, "auto", ["dom", "fs"], TASKS_CORE),
  automated(15, "auto", ["dom", "fs"], TASKS_CORE),
  automated(16, "auto", ["dom", "fs"], TASKS_CORE),
  automated(17, "auto", ["dom", "fs"], TASKS_CORE),
  automated(18, "auto", ["dom", "fs"], TASKS_VIEWS),
  automated(19, "auto", ["dom"], TASKS_VIEWS),
  automated(20, "auto+look", ["dom", "fs", "log", "proc", "shot"], CROSS),
  automated(21, "auto", ["dom", "proc"], TASKS_SCALE, "full"),
  automated(22, "auto+look", ["dom", "shot"], CROSS),
  automated(23, "auto", ["dom"], CROSS),
  automated(24, "auto", ["dom", "proc"], LIFECYCLE),
  automated(25, "auto", ["fs", "log"], CROSS),
  owner(26, "decision", null, null),
];

/** The spec files a run executes: the standard profile leaves out the 10,000-task spec (D-13). */
export function specsForProfile(profile: UatProfile): SpecFile[] {
  const wanted = new Set(
    UAT_ITEM_PLAN.filter((item) => profile === "full" || item.profile === "standard")
      .map((item) => item.specFile)
      .filter((file): file is SpecFile => file !== null),
  );
  return SPEC_FILES.filter((file) => wanted.has(file));
}
