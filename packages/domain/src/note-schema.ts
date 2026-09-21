import { z } from "zod";
import type { WorkspaceId } from "./ids.js";

/**
 * VAULT-08's five-way claim taxonomy: what KIND of assertion a note makes.
 *
 * This axis is deliberately separate from {@link CONFIDENCE_STATES}. A
 * claim type describes the epistemic shape of the content ("this is an
 * inference I drew" vs. "this is a fact I copied from a source"); a
 * confidence state describes how far that content has been checked. The
 * two are orthogonal: an `inference` can be `verified` (someone confirmed
 * the reasoning holds) and a `source-fact` can be `unverified` (nobody has
 * re-read the source since it was captured). Collapsing them into one
 * field would make both claims unrepresentable, which is exactly why
 * VAULT-07 and VAULT-08 name them as two requirements.
 */
export const CLAIM_TYPES = [
  "source-fact",
  "summary",
  "inference",
  "recommendation",
  "unverified-claim",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * VAULT-07's verification status: how far the note's content has been
 * checked, independent of what kind of claim it makes (see
 * {@link CLAIM_TYPES} for why these are two fields, not one).
 */
export const CONFIDENCE_STATES = ["verified", "inferred", "unverified"] as const;
export type ConfidenceState = (typeof CONFIDENCE_STATES)[number];

/**
 * The managed-knowledge lifecycle a note sits somewhere along, from raw
 * capture through to a published deliverable. The stage is metadata rather
 * than a folder-derived fact so a note's stage survives being moved, and
 * so an index can group by stage without inferring it from a path.
 */
export const LIFECYCLE_STAGES = [
  "capture",
  "raw",
  "synthesis",
  "wiki",
  "deliverable",
  "output",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * The scope grammar: either the single `global` scope, or one workspace
 * addressed by its opaque 25-character ID (nine base-36 timestamp
 * characters plus a sixteen-character random suffix — see `newWorkspaceId`).
 *
 * The pattern is pinned to `[0-9a-z]` rather than left open precisely
 * because this string is decomposed into a filesystem path by the
 * vault-repository's scope guard: a scope that cannot express a separator,
 * a dot, or a NUL byte cannot be used to construct a traversal (VAULT-10,
 * threat T-02-01). Containment is still checked independently — this is
 * the first of two layers, never the only one.
 */
export const NOTE_SCOPE_PATTERN = /^(global|workspace:[0-9a-z]{25})$/;

/** A validated note scope: `"global"` or `` `workspace:${WorkspaceId}` ``. */
export type NoteScope = string;

/** The single global (non-workspace) knowledge scope. */
export function globalScope(): NoteScope {
  return "global";
}

/** The scope string addressing one workspace's knowledge tree. */
export function workspaceScope(id: WorkspaceId): NoteScope {
  return `workspace:${id}`;
}

/**
 * Returns the WorkspaceId a scope addresses, or `null` for the global
 * scope. Returns `null` for any string that is not a well-formed scope, so
 * a caller that tests for a workspace never accidentally treats a
 * malformed scope as one.
 */
export function workspaceIdFromScope(scope: NoteScope): WorkspaceId | null {
  if (!NOTE_SCOPE_PATTERN.test(scope)) return null;
  if (scope === "global") return null;
  return scope.slice("workspace:".length) as WorkspaceId;
}

/**
 * Who or what produced a note. Every subfield is optional because the
 * provenance genuinely may not be known — a user-authored note has no
 * model, a manual capture has no automation — and PRD §7.11 asks for these
 * "when known", not unconditionally. An absent subfield means "unknown",
 * never "none".
 */
export const GeneratedBySchema = z.object({
  model: z.string().optional(),
  skill: z.string().optional(),
  automation: z.string().optional(),
  runId: z.string().optional(),
});
export type GeneratedBy = z.infer<typeof GeneratedBySchema>;

/**
 * The full provenance frontmatter every durable managed note carries
 * (VAULT-07). Validated on write (the object this package constructs) AND
 * on read (arbitrary on-disk YAML, which may have been hand-edited or
 * synced in by an external tool — an untrusted-input boundary, ASVS V5).
 *
 * Field notes worth stating explicitly:
 * - `aiGenerated` is a plain boolean, separate from both `claimType` and
 *   `confidence`, so "this was written by a model" stays answerable even
 *   for a note whose claim type is unknown (VAULT-08).
 * - `claimType` is optional ONLY so user-authored notes can omit it;
 *   anything this repository generates sets it.
 * - `sources` defaults to `[]` — an empty list is a real state (a note
 *   citing nothing), distinct from the field being missing.
 * - `lastReviewed` is nullable rather than optional: `null` positively
 *   records "never reviewed", which a missing key could not distinguish
 *   from "this schema version had no such field".
 */
export const NoteFrontmatterSchema = z.object({
  id: z.string(),
  scope: z.string().regex(NOTE_SCOPE_PATTERN),
  stage: z.enum(LIFECYCLE_STAGES),
  created: z.string(),
  updated: z.string(),
  generatedBy: GeneratedBySchema,
  aiGenerated: z.boolean(),
  claimType: z.enum(CLAIM_TYPES).optional(),
  sources: z.array(z.string()).default([]),
  confidence: z.enum(CONFIDENCE_STATES),
  lastReviewed: z.string().nullable(),
  contentHash: z.string().optional(),
});
export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

/**
 * The single source of on-disk frontmatter key order, for every writer in
 * the system (service today, plugin from Phase 3 on).
 *
 * Determinism here is a product requirement, not a style preference:
 * VAULT-03/VAULT-04 define "deterministic" as "re-running with no content
 * change produces a byte-identical file", and JavaScript preserves
 * string-key insertion order, so the ONLY thing that fixes YAML key order
 * is the order a writer inserts keys. Do not delegate this to a YAML
 * library option — serialize by walking this array.
 */
export const NOTE_FRONTMATTER_KEY_ORDER = [
  "id",
  "scope",
  "stage",
  "created",
  "updated",
  "generatedBy",
  "aiGenerated",
  "claimType",
  "sources",
  "confidence",
  "lastReviewed",
  "contentHash",
] as const satisfies readonly (keyof NoteFrontmatter)[];

/**
 * The same fixed-order guarantee for the nested `generatedBy` map. Without
 * it the outer order would be pinned while the inner one still followed
 * construction order, which is enough on its own to break the
 * byte-identical contract above.
 */
export const GENERATED_BY_KEY_ORDER = [
  "model",
  "skill",
  "automation",
  "runId",
] as const satisfies readonly (keyof GeneratedBy)[];
