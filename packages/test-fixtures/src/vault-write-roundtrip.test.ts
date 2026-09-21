// End-to-end tracer for the managed-vault write path (plan 02-01): one
// provenance-carrying note travelling through every layer at once — ID
// minting, schema validation, scope + containment enforcement,
// fixed-key-order serialization, atomic replace — and read back off real
// disk inside an ephemeral fixture vault.
//
// It lives in @ccc/test-fixtures rather than inside @ccc/vault-repo
// because it deliberately exercises the PUBLIC surface of two packages
// together (`@ccc/domain` + `@ccc/vault-repo`) as a consumer would, and
// test-fixtures is the one element permitted to import every other.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NoteFrontmatterSchema, newNoteId, newWorkspaceId, workspaceScope } from "@ccc/domain";
import { parseNote, WorkspaceScopeViolationError, writeNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withTempVaultDir } from "./vault-fixture.js";

/** Creates `workspaces/<id>/{raw,wiki,output}` inside a fixture vault. */
function seedWorkspaceTree(vaultRoot: string, workspaceId: string): void {
  for (const stage of ["raw", "wiki", "output"]) {
    mkdirSync(join(vaultRoot, "workspaces", workspaceId, stage), { recursive: true });
  }
}

const BODY = "# Tracer note\n\nOne provenance note, written end to end.\n";

describe("managed vault note write round-trip", () => {
  beforeEach(() => {
    // Pins `new Date()` so two writes of the same logical note cannot
    // differ merely because a millisecond elapsed between them — the
    // byte-identical assertion below must fail for key-order reasons or
    // not at all.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a written note parses back with full provenance frontmatter", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      const workspaceId = newWorkspaceId();
      seedWorkspaceTree(vaultRoot, workspaceId);

      const relativePath = join("workspaces", workspaceId, "wiki", "tracer.md");
      const written = writeNote({
        vaultRoot,
        relativePath,
        body: BODY,
        scope: workspaceScope(workspaceId),
        stage: "wiki",
        generatedBy: { model: "test-model" },
        aiGenerated: true,
        claimType: "summary",
        confidence: "inferred",
      });

      const onDisk = readFileSync(join(vaultRoot, relativePath), "utf8");
      const parsed = parseNote(onDisk);
      const validated = NoteFrontmatterSchema.parse(parsed.frontmatter);

      expect(validated.id).toBe(written.noteId);
      expect(validated.id).toHaveLength(25);
      expect(validated.scope).toBe(`workspace:${workspaceId}`);
      expect(validated.stage).toBe("wiki");
      // A brand-new note has never been updated since creation, and the
      // schema must accept that equality rather than demand a later stamp.
      expect(validated.created).toBe(validated.updated);
      // aiGenerated, claimType and confidence are three independent axes:
      // a model-written summary can still be unverified.
      expect(validated.aiGenerated).toBe(true);
      expect(validated.claimType).toBe("summary");
      expect(validated.confidence).toBe("inferred");
      expect(validated.generatedBy).toEqual({ model: "test-model" });
      // The empty states are real states, not missing fields.
      expect(validated.sources).toEqual([]);
      expect(validated.lastReviewed).toBeNull();
      expect(validated.contentHash).toBe(createHash("sha256").update(BODY, "utf8").digest("hex"));
      expect(validated.contentHash).toHaveLength(64);
      // The body survives verbatim — this package never rewrites prose.
      expect(parsed.body.trim()).toBe(BODY.trim());
    });
  });

  test("a write scoped to another workspace is refused and leaves no file", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      const workspaceA = newWorkspaceId();
      const workspaceB = newWorkspaceId();
      seedWorkspaceTree(vaultRoot, workspaceA);
      seedWorkspaceTree(vaultRoot, workspaceB);

      const intruderPath = join("workspaces", workspaceA, "wiki", "intruder.md");

      expect(() =>
        writeNote({
          vaultRoot,
          relativePath: intruderPath,
          body: BODY,
          // Declares workspace B while targeting workspace A's tree.
          scope: workspaceScope(workspaceB),
          stage: "wiki",
          generatedBy: { automation: "rogue-processor" },
          aiGenerated: true,
          claimType: "inference",
          confidence: "unverified",
        }),
      ).toThrow(WorkspaceScopeViolationError);

      expect(existsSync(join(vaultRoot, intruderPath))).toBe(false);
    });
  });

  test("construction order at the call site does not change the bytes on disk", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      const workspaceId = newWorkspaceId();
      seedWorkspaceTree(vaultRoot, workspaceId);
      const noteId = newNoteId();
      const scope = workspaceScope(workspaceId);

      const firstPath = join("workspaces", workspaceId, "wiki", "order-a.md");
      writeNote({
        vaultRoot,
        relativePath: firstPath,
        body: BODY,
        scope,
        stage: "wiki",
        generatedBy: { model: "test-model", skill: "tracer" },
        aiGenerated: true,
        claimType: "summary",
        confidence: "inferred",
        id: noteId,
      });

      const secondPath = join("workspaces", workspaceId, "wiki", "order-b.md");
      writeNote({
        // Same logical note, every field supplied in a different order —
        // including the nested generatedBy map.
        id: noteId,
        confidence: "inferred",
        claimType: "summary",
        aiGenerated: true,
        generatedBy: { skill: "tracer", model: "test-model" },
        stage: "wiki",
        scope,
        body: BODY,
        relativePath: secondPath,
        vaultRoot,
      });

      const first = readFileSync(join(vaultRoot, firstPath));
      const second = readFileSync(join(vaultRoot, secondPath));
      expect(Buffer.compare(first, second)).toBe(0);
    });
  });
});
