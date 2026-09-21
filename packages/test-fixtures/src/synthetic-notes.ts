import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAIM_TYPES,
  type ClaimType,
  CONFIDENCE_STATES,
  type ConfidenceState,
  LIFECYCLE_STAGES,
  type LifecycleStage,
  type NoteFrontmatter,
  type NoteId,
} from "@ccc/domain";
import type { VaultNoteRecord } from "@ccc/operational-store";
import { stringifyNote } from "@ccc/vault-repo";

/**
 * The default seed every synthetic-vault helper uses when a caller does
 * not supply one. Fixed so that "the 10,000-note fixture" means the same
 * 10,000 notes in every run, on every machine.
 */
export const DEFAULT_SYNTHETIC_SEED = 20260921;

/** How many workspaces the generated notes spread across, plus the global scope. */
const WORKSPACE_COUNT = 20;

/** The alphabet `NOTE_SCOPE_PATTERN` permits in a workspace ID. */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Length of a minted WorkspaceId / NoteId (`newWorkspaceId`: 9 timestamp chars + 16 random). */
const ID_LENGTH = 25;

/** Roughly one note in this many is global rather than workspace-scoped. */
const GLOBAL_EVERY = 17;

const BASE_EPOCH_MS = Date.UTC(2026, 0, 1);
const ONE_HOUR_MS = 3_600_000;

/**
 * mulberry32: a 32-bit PRNG small enough to inline and good enough for
 * fixture data. Deliberately not `Math.random()` and deliberately not a
 * new dependency — the fixture's whole value is that the same seed yields
 * the same 10,000 notes, so a perf number is comparable across runs
 * instead of being re-rolled on every invocation.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic opaque ID in the same shape and alphabet a real minted ID uses. */
function syntheticId(rand: () => number): string {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length)];
  }
  return out;
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

/** The markdown body of note `index` — short, but real prose with real structure. */
function syntheticBody(index: number, stage: LifecycleStage): string {
  return [
    `# Synthetic note ${index}`,
    "",
    `This note sits at the **${stage}** stage of the managed-knowledge lifecycle.`,
    "It exists only to give the note-metadata cache and the repair pass a",
    "realistically-shaped vault to work against.",
    "",
    `- fixture index: ${index}`,
    `- lifecycle stage: ${stage}`,
    "",
  ].join("\n");
}

interface SyntheticNote {
  readonly record: VaultNoteRecord;
  readonly frontmatter: NoteFrontmatter;
  readonly body: string;
}

/**
 * Builds `count` synthetic notes from `seed`. Both public helpers below
 * call this, so a record returned by {@link generateSyntheticNotes} and a
 * file written by {@link writeSyntheticVault} describe the same note for
 * the same seed and index — which is what lets plan 02-06's repair test
 * compare a rebuilt cache against the vault it was rebuilt from.
 */
function buildSyntheticNotes(count: number, seed: number): SyntheticNote[] {
  const rand = mulberry32(seed);
  const workspaceIds = Array.from({ length: WORKSPACE_COUNT }, () => syntheticId(rand));
  const notes: SyntheticNote[] = [];

  for (let index = 0; index < count; index++) {
    const noteId = syntheticId(rand) as NoteId;
    // Stage cycles rather than being sampled, so every one of the six
    // stages is present even for a small `count` — a distribution the
    // caller can rely on instead of hoping the sampler covered it.
    const stage = LIFECYCLE_STAGES[index % LIFECYCLE_STAGES.length] as LifecycleStage;
    const isGlobal = index % GLOBAL_EVERY === 0;
    const workspaceId = workspaceIds[Math.floor(rand() * WORKSPACE_COUNT)] as string;
    const scope = isGlobal ? "global" : `workspace:${workspaceId}`;
    const folder = isGlobal ? "global" : `workspaces/${workspaceId}`;
    const path = `${folder}/${stage}/${noteId}.md`;

    const aiGenerated = rand() < 0.6;
    const claimType: ClaimType | null = rand() < 0.85 ? pick(rand, CLAIM_TYPES) : null;
    const confidence = pick(rand, CONFIDENCE_STATES) as ConfidenceState;
    const created = new Date(BASE_EPOCH_MS + index * ONE_HOUR_MS).toISOString();
    const updated = new Date(BASE_EPOCH_MS + index * ONE_HOUR_MS + ONE_HOUR_MS).toISOString();

    const body = syntheticBody(index, stage);
    const contentHash = createHash("sha256").update(body, "utf8").digest("hex");

    const frontmatter: NoteFrontmatter = {
      id: noteId,
      scope,
      stage,
      created,
      updated,
      generatedBy: aiGenerated ? { model: "synthetic-fixture", skill: "generate-synthetic" } : {},
      aiGenerated,
      ...(claimType === null ? {} : { claimType }),
      sources: [],
      confidence,
      lastReviewed: null,
      contentHash,
    };

    notes.push({
      record: {
        noteId,
        path,
        scope,
        stage,
        aiGenerated,
        claimType,
        confidence,
        createdAt: created,
        updatedAt: updated,
        contentHash,
      },
      frontmatter,
      body,
    });
  }

  return notes;
}

/**
 * `count` synthetic {@link VaultNoteRecord}s with a realistic spread:
 * twenty workspaces plus the global scope, and every one of the six
 * lifecycle stages represented.
 *
 * Deterministic by construction — the same `seed` always produces the same
 * records — so a perf number measured against this fixture is comparable
 * across runs rather than being re-rolled each time.
 */
export function generateSyntheticNotes(
  count: number,
  seed: number = DEFAULT_SYNTHETIC_SEED,
): VaultNoteRecord[] {
  return buildSyntheticNotes(count, seed).map((note) => note.record);
}

/**
 * Materializes `count` REAL notes on disk under `vaultRoot` — full
 * provenance frontmatter serialized by `stringifyNote`, so every file
 * parses back through `parseNote`. Returns the absolute paths written.
 *
 * Writes with a plain `writeFileSync` rather than through `writeNote()` on
 * purpose: `writeNote` regenerates a folder index on every call and
 * enforces workspace scope against a real vault tree, neither of which a
 * bulk fixture wants to pay for. What this helper promises is that the
 * FILES are genuine — the same serializer, the same key order, the same
 * schema — not that the write path was exercised.
 *
 * Used by the naive-scan benchmark in `vault-notes-perf.test.ts`, and by
 * the repair-at-scale test in plan 02-06.
 */
export function writeSyntheticVault(
  vaultRoot: string,
  count: number,
  seed: number = DEFAULT_SYNTHETIC_SEED,
): string[] {
  const notes = buildSyntheticNotes(count, seed);
  const written: string[] = [];

  for (const note of notes) {
    const absolute = join(vaultRoot, note.record.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, stringifyNote(note.frontmatter, note.body), "utf8");
    written.push(absolute);
  }

  return written;
}
