import type { UatProfile } from "./profile.js";
import type { OwnerWhy, RunClass, ViaToken } from "./uat-tags.js";

/** The phase number used in the mocha title prefix of the Phase 6 retrofit. */
export const UAT_PHASE_PREFIX = "06";

export const SPEC_FILES: readonly string[] = [];

export interface ItemPlan {
  readonly number: number;
  readonly runClass: RunClass;
  readonly via: readonly ViaToken[];
  readonly ownerWhy: OwnerWhy | null;
  readonly autoPart: string | null;
  /** One of SPEC_FILES, or null for an item with no spec. */
  readonly specFile: string | null;
  /** `full` items run only in the full profile (D-13). */
  readonly profile: UatProfile;
}

export const UAT_ITEM_PLAN: readonly ItemPlan[] = [];

export function specsForProfile(_profile: UatProfile): string[] {
  throw new Error("specsForProfile is not implemented yet (typed skeleton)");
}
