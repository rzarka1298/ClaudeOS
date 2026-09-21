// The provenance contract's own edges (VAULT-07/VAULT-08). The point of
// most interest is the last test: `aiGenerated`, `claimType` and
// `confidence` must be able to hold three independent values at once. If
// any two of them were ever collapsed into one field, that test is the one
// that fails.
import { describe, expect, test } from "vitest";
import { newWorkspaceId } from "./ids.js";
import {
  CLAIM_TYPES,
  CONFIDENCE_STATES,
  GENERATED_BY_KEY_ORDER,
  globalScope,
  LIFECYCLE_STAGES,
  NOTE_FRONTMATTER_KEY_ORDER,
  NOTE_SCOPE_PATTERN,
  NoteFrontmatterSchema,
  workspaceIdFromScope,
  workspaceScope,
} from "./note-schema.js";

/** The minimum a caller must supply; every other key is derived or defaulted. */
function base() {
  return {
    id: "0000000001234567890abcdef",
    scope: "global",
    stage: "wiki" as const,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    generatedBy: {},
    aiGenerated: false,
    confidence: "unverified" as const,
    lastReviewed: null,
  };
}

describe("NoteFrontmatterSchema", () => {
  test("a claimType outside the five-value union is rejected", () => {
    const result = NoteFrontmatterSchema.safeParse({ ...base(), claimType: "editorial-opinion" });

    expect(result.success).toBe(false);
    expect(CLAIM_TYPES).toHaveLength(5);
    expect(CLAIM_TYPES).not.toContain("editorial-opinion");
  });

  test("created === updated is accepted — a note written once was never edited", () => {
    const stamp = "2026-01-01T00:00:00.000Z";

    const parsed = NoteFrontmatterSchema.parse({ ...base(), created: stamp, updated: stamp });

    expect(parsed.created).toBe(parsed.updated);
  });

  test("sources defaults to an empty array when the key is absent", () => {
    const parsed = NoteFrontmatterSchema.parse(base());

    // The empty list is a real state — "this note cites nothing" — and is
    // deliberately distinct from the key being missing.
    expect(parsed.sources).toEqual([]);
  });

  test("lastReviewed: null is accepted and preserved as null", () => {
    const parsed = NoteFrontmatterSchema.parse(base());

    expect(parsed.lastReviewed).toBeNull();
  });

  test("lastReviewed is nullable but NOT optional — omitting the key is rejected", () => {
    const { lastReviewed: _omitted, ...withoutKey } = base();

    expect(NoteFrontmatterSchema.safeParse(withoutKey).success).toBe(false);
  });

  test("aiGenerated, claimType and confidence are three independent axes on one note", () => {
    const parsed = NoteFrontmatterSchema.parse({
      ...base(),
      aiGenerated: true,
      claimType: "inference",
      confidence: "unverified",
    });

    expect(parsed.aiGenerated).toBe(true);
    expect(parsed.claimType).toBe("inference");
    expect(parsed.confidence).toBe("unverified");
  });

  test("every lifecycle stage and confidence state in the exported unions validates", () => {
    for (const stage of LIFECYCLE_STAGES) {
      expect(NoteFrontmatterSchema.safeParse({ ...base(), stage }).success).toBe(true);
    }
    for (const confidence of CONFIDENCE_STATES) {
      expect(NoteFrontmatterSchema.safeParse({ ...base(), confidence }).success).toBe(true);
    }
  });

  test("a scope outside the grammar is rejected by the schema, not only by the write guard", () => {
    for (const scope of ["workspace:TOO-SHORT", "workspace:../../etc", "workspaces", ""]) {
      expect(NoteFrontmatterSchema.safeParse({ ...base(), scope }).success, scope).toBe(false);
    }
  });
});

describe("the scope grammar", () => {
  test("a minted workspace scope matches the pattern and round-trips to its ID", () => {
    const id = newWorkspaceId();
    const scope = workspaceScope(id);

    expect(NOTE_SCOPE_PATTERN.test(scope)).toBe(true);
    expect(workspaceIdFromScope(scope)).toBe(id);
  });

  test("the global scope carries no workspace ID", () => {
    expect(workspaceIdFromScope(globalScope())).toBeNull();
  });

  test("a malformed scope yields null rather than a plausible-looking ID", () => {
    expect(workspaceIdFromScope("workspace:../../etc")).toBeNull();
  });
});

describe("the key-order contract", () => {
  test("NOTE_FRONTMATTER_KEY_ORDER lists every schema key exactly once", () => {
    const schemaKeys = Object.keys(NoteFrontmatterSchema.shape).sort();

    expect([...NOTE_FRONTMATTER_KEY_ORDER]).toHaveLength(12);
    expect([...new Set(NOTE_FRONTMATTER_KEY_ORDER)]).toHaveLength(12);
    expect([...NOTE_FRONTMATTER_KEY_ORDER].sort()).toEqual(schemaKeys);
  });

  test("GENERATED_BY_KEY_ORDER lists every generatedBy subfield exactly once", () => {
    expect([...GENERATED_BY_KEY_ORDER]).toEqual(["model", "skill", "automation", "runId"]);
    expect([...new Set(GENERATED_BY_KEY_ORDER)]).toHaveLength(4);
  });
});
