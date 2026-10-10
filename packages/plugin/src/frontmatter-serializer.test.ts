// Byte-parity proofs for the plugin's canonical frontmatter serializer.
//
// Phase 2's live-Obsidian UAT (2026-09-22) probed Obsidian's bundled
// `stringifyYaml` against the service's js-yaml `safeDump` and found them
// DIFFERENT in three value classes:
//
//   (a) a string that needs quoting  — Obsidian emits double quotes,
//       js-yaml emits single quotes;
//   (b) an astral-plane string       — Obsidian emits it plain/unescaped,
//       js-yaml emits a double-quoted `\U########` escape;
//   (c) a number-like string         — Obsidian quotes it, js-yaml leaves
//       it bare.
//
// That made byte-parity through Obsidian's API unachievable, so the plugin
// stopped serializing through it: `frontmatter-serializer.ts` bundles the
// same js-yaml the service reaches through gray-matter's default engine, and
// parity is now a property of shared code rather than of two libraries
// happening to agree. The three classes above are pinned below as
// regressions so a future "just use Obsidian's helper, it's right there"
// change fails here instead of in a user's vault.
//
// Every expectation is a GOLDEN FIXTURE captured verbatim from
// `@ccc/vault-repo`'s `stringifyNote()` — the service-side writer — not a
// hand-written guess at what YAML "should" look like. It is a fixture rather
// than a live import because the import-boundary map forbids `@ccc/plugin`
// from importing `@ccc/vault-repo`: these two writers must agree on bytes
// precisely BECAUSE they can never share code.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NoteFrontmatter,
  TASK_FRONTMATTER_KEY_ORDER,
  VALID_HOSTILE_TASK_TITLES,
} from "@ccc/domain";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  serializeManagedFrontmatter,
  serializePassthroughFrontmatter,
  serializeTaskFrontmatter,
} from "./frontmatter-serializer.js";
import {
  GOLDEN_BODY,
  GOLDEN_PASSTHROUGH,
  GOLDEN_TASK_FRONTMATTER,
  GOLDEN_TASK_NOTE,
} from "./test-support/task-note-fixtures.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const BODY = "# Heading\n\nBody line one.\n\n- bullet\n";

/** Wraps a managed block the way a note on disk carries it. */
function note(block: string, body = BODY): string {
  return `---\n${block}---\n${body}`;
}

const FULL_FRONTMATTER: NoteFrontmatter = {
  id: "mfz0a1b2c3d4e5f6g7h8i9j0k",
  scope: "workspace:mfz0a1b2c3d4e5f6g7h8i9j0k",
  stage: "wiki",
  created: "2026-01-02T03:04:05.000Z",
  updated: "2026-01-02T03:04:05.000Z",
  generatedBy: {
    model: "claude-opus-5",
    skill: "research",
    automation: "daily-brief",
    runId: "run-123",
  },
  aiGenerated: true,
  claimType: "summary",
  sources: ["note:abc", "https://example.com/a"],
  confidence: "inferred",
  lastReviewed: null,
  contentHash: "9f2c",
};

/** `stringifyNote(FULL_FRONTMATTER, BODY)`, captured verbatim. */
const SERVICE_FULL_BLOCK = [
  "id: mfz0a1b2c3d4e5f6g7h8i9j0k",
  "scope: 'workspace:mfz0a1b2c3d4e5f6g7h8i9j0k'",
  "stage: wiki",
  "created: '2026-01-02T03:04:05.000Z'",
  "updated: '2026-01-02T03:04:05.000Z'",
  "generatedBy:",
  "  model: claude-opus-5",
  "  skill: research",
  "  automation: daily-brief",
  "  runId: run-123",
  "aiGenerated: true",
  "claimType: summary",
  "sources:",
  "  - 'note:abc'",
  "  - 'https://example.com/a'",
  "confidence: inferred",
  "lastReviewed: null",
  "contentHash: 9f2c",
  "",
].join("\n");

/**
 * The same note carrying one value from each divergence class: a
 * quote-requiring string in `skill`, an astral-plane string in `automation`,
 * and a number-like string in `contentHash` (and in `sources`, to prove the
 * class survives being nested inside a sequence too).
 */
const DIVERGENT_FRONTMATTER: NoteFrontmatter = {
  ...FULL_FRONTMATTER,
  generatedBy: {
    model: "claude-opus-5",
    skill: "colon: and #hash",
    automation: "Repair 🛠 ワークスペース",
    runId: "run-123",
  },
  sources: ["note:abc", "0123456789012345678901234"],
  contentHash: "0123456789012345678901234",
};

/** `stringifyNote(DIVERGENT_FRONTMATTER, BODY)`, captured verbatim. */
const SERVICE_DIVERGENT_BLOCK = [
  "id: mfz0a1b2c3d4e5f6g7h8i9j0k",
  "scope: 'workspace:mfz0a1b2c3d4e5f6g7h8i9j0k'",
  "stage: wiki",
  "created: '2026-01-02T03:04:05.000Z'",
  "updated: '2026-01-02T03:04:05.000Z'",
  "generatedBy:",
  "  model: claude-opus-5",
  "  skill: 'colon: and #hash'",
  '  automation: "Repair \\U0001F6E0 ワークスペース"',
  "  runId: run-123",
  "aiGenerated: true",
  "claimType: summary",
  "sources:",
  "  - 'note:abc'",
  "  - 0123456789012345678901234",
  "confidence: inferred",
  "lastReviewed: null",
  "contentHash: 0123456789012345678901234",
  "",
].join("\n");

/** The sparsest note the schema allows: no claimType, no contentHash, an
 * empty `generatedBy` map and an empty `sources` list. */
const MINIMAL_FRONTMATTER: NoteFrontmatter = {
  id: "mfz0a1b2c3d4e5f6g7h8i9j0k",
  scope: "global",
  stage: "capture",
  created: "2026-01-02T03:04:05.000Z",
  updated: "2026-01-02T03:04:05.000Z",
  generatedBy: {},
  aiGenerated: false,
  sources: [],
  confidence: "unverified",
  lastReviewed: null,
};

/** `stringifyNote(MINIMAL_FRONTMATTER, "body\n")`, captured verbatim. */
const SERVICE_MINIMAL_BLOCK = [
  "id: mfz0a1b2c3d4e5f6g7h8i9j0k",
  "scope: global",
  "stage: capture",
  "created: '2026-01-02T03:04:05.000Z'",
  "updated: '2026-01-02T03:04:05.000Z'",
  "generatedBy: {}",
  "aiGenerated: false",
  "sources: []",
  "confidence: unverified",
  "lastReviewed: null",
  "",
].join("\n");

/** The user's own keys, as the third argument the service writer takes. */
const PASSTHROUGH_ENTRIES: readonly (readonly [string, unknown])[] = [
  ["title", "colon: and #hash"],
  ["name", "Repair 🛠 ワークスペース"],
  ["num", "0123456789012345678901234"],
  ["tags", ["research", "obsidian"]],
  ["dataviewField", 42],
];

/** The tail of `stringifyNote(FULL_FRONTMATTER, BODY, {...})`, captured
 * verbatim — the lines the service emits after the managed block. */
const SERVICE_PASSTHROUGH_BLOCK = [
  "title: 'colon: and #hash'",
  'name: "Repair \\U0001F6E0 ワークスペース"',
  "num: 0123456789012345678901234",
  "tags:",
  "  - research",
  "  - obsidian",
  "dataviewField: 42",
  "",
].join("\n");

/** Byte-level equality, reported as a byte comparison rather than a string
 * diff so an invisible difference (a stray BOM, CRLF, trailing space) cannot
 * read as equal. */
function expectSameBytes(actual: string, expected: string): void {
  expect(actual).toBe(expected);
  expect(Buffer.compare(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"))).toBe(0);
}

describe("serializeManagedFrontmatter", () => {
  it("reproduces the service's bytes for a full twelve-field note", () => {
    expectSameBytes(note(serializeManagedFrontmatter(FULL_FRONTMATTER)), note(SERVICE_FULL_BLOCK));
  });

  it("reproduces the service's bytes for the sparsest note the schema allows", () => {
    expectSameBytes(
      note(serializeManagedFrontmatter(MINIMAL_FRONTMATTER), "body\n"),
      note(SERVICE_MINIMAL_BLOCK, "body\n"),
    );
  });

  it("reproduces the service's bytes for a note carrying all three live-Obsidian divergence classes", () => {
    expectSameBytes(
      note(serializeManagedFrontmatter(DIVERGENT_FRONTMATTER)),
      note(SERVICE_DIVERGENT_BLOCK),
    );
  });

  // The three probes below are the live-UAT findings pinned one class at a
  // time, so a regression names WHICH class broke instead of only reporting
  // that a 19-line block differs somewhere.

  it("pins divergence class (a): a quote-requiring string takes js-yaml's single quotes, not Obsidian's double quotes", () => {
    const line = serializeManagedFrontmatter(DIVERGENT_FRONTMATTER)
      .split("\n")
      .find((l) => l.startsWith("  skill:"));

    expect(line).toBe("  skill: 'colon: and #hash'");
  });

  it("pins divergence class (b): an astral-plane string takes js-yaml's escaped double-quoted form, not Obsidian's plain form", () => {
    const line = serializeManagedFrontmatter(DIVERGENT_FRONTMATTER)
      .split("\n")
      .find((l) => l.startsWith("  automation:"));

    expect(line).toBe('  automation: "Repair \\U0001F6E0 ワークスペース"');
  });

  it("pins divergence class (c): a number-like string stays bare, not quoted the way Obsidian quotes it", () => {
    const line = serializeManagedFrontmatter(DIVERGENT_FRONTMATTER)
      .split("\n")
      .find((l) => l.startsWith("contentHash:"));

    expect(line).toBe("contentHash: 0123456789012345678901234");
  });

  it("emits keys in canonical order even when the caller's object is built backwards, nested map included", () => {
    // Insertion order here must not survive to disk: the emitted bytes are a
    // function of the note's CONTENT, never of the order a caller happened to
    // write its object literal in.
    const permuted: NoteFrontmatter = {
      contentHash: FULL_FRONTMATTER.contentHash,
      lastReviewed: FULL_FRONTMATTER.lastReviewed,
      confidence: FULL_FRONTMATTER.confidence,
      sources: FULL_FRONTMATTER.sources,
      claimType: FULL_FRONTMATTER.claimType,
      aiGenerated: FULL_FRONTMATTER.aiGenerated,
      generatedBy: {
        runId: "run-123",
        automation: "daily-brief",
        skill: "research",
        model: "claude-opus-5",
      },
      updated: FULL_FRONTMATTER.updated,
      created: FULL_FRONTMATTER.created,
      stage: FULL_FRONTMATTER.stage,
      scope: FULL_FRONTMATTER.scope,
      id: FULL_FRONTMATTER.id,
    };

    expectSameBytes(serializeManagedFrontmatter(permuted), SERVICE_FULL_BLOCK);
  });
});

describe("serializePassthroughFrontmatter", () => {
  it("reproduces the service's bytes for the user's own keys, including all three divergence classes", () => {
    expectSameBytes(
      serializePassthroughFrontmatter(PASSTHROUGH_ENTRIES),
      SERVICE_PASSTHROUGH_BLOCK,
    );
  });

  it("drops an entry whose value is undefined rather than throwing, since js-yaml cannot dump it", () => {
    expectSameBytes(
      serializePassthroughFrontmatter([
        ["kept", "keep-me"],
        ["dropped", undefined],
      ]),
      "kept: keep-me\n",
    );
  });

  it("emits nothing for an empty entry list", () => {
    expectSameBytes(serializePassthroughFrontmatter([]), "");
  });
});

describe("serializer independence from the Obsidian API", () => {
  it("never imports the obsidian module", () => {
    // The whole point of this module: Obsidian's bundled stringifyYaml is
    // NOT the service's js-yaml, so reaching for it here would silently
    // reintroduce GAP-1. A source scan rather than a behavioural assertion,
    // because under Vitest `obsidian` resolves to a js-yaml-backed stub that
    // would make the reintroduced defect invisible.
    const source = readFileSync(join(SRC_DIR, "frontmatter-serializer.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""));

    expect(code.filter((line) => /["']obsidian["']/.test(line))).toEqual([]);
  });

  it("ships js-yaml as a runtime dependency, not a devDependency", () => {
    // A devDependency would satisfy the test runner and then be absent from
    // the published/sideloaded plugin folder — the serializer would resolve
    // nothing at load time. js-yaml is now production code.
    const pkg = JSON.parse(readFileSync(join(SRC_DIR, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.["js-yaml"]).toBeDefined();
    expect(pkg.devDependencies?.["js-yaml"]).toBeUndefined();
  });

  it("does not externalise js-yaml from the esbuild bundle", () => {
    // Obsidian externalises `obsidian`, `electron` and the CodeMirror
    // packages because the application PROVIDES them at runtime. It provides
    // no js-yaml to a plugin, so adding js-yaml to that list would turn a
    // bundled module into an unresolvable `require` at load time. This is the
    // machine check for the one esbuild setting GAP-1's fix depends on.
    const config = readFileSync(join(SRC_DIR, "..", "esbuild.config.mjs"), "utf8");
    const externalBlock = /external:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? "";

    expect(externalBlock).not.toBe("");
    expect(externalBlock).toContain('"obsidian"');
    expect(externalBlock).not.toContain("js-yaml");
  });
});

// ---------------------------------------------------------------------------
// Plan 06-18, Task 1: the task frontmatter serializer.

describe("serializeTaskFrontmatter (plan 06-18)", () => {
  const wrap = (block: string, body: string): string => `---\n${block}---\n${body}`;

  it("Test 1a: matches the service writer's bytes for a fully populated task with passthrough keys", () => {
    const block = serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER, GOLDEN_PASSTHROUGH);
    expect(wrap(block, GOLDEN_BODY)).toBe(GOLDEN_TASK_NOTE);
  });

  it("noRefs: a passthrough value that shares a node is written without anchors or aliases, like the service writer", () => {
    const shared = ["x", "y"];
    const block = serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER, [
      ["zz-shared", { first: shared, second: shared }],
    ]);
    expect(block).not.toMatch(/&|\*[a-z]/);
    expect(block).toContain("second:");
  });

  it("Test 1b: walks the provenance keys first and the task keys in the domain order", () => {
    const block = serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER);
    const topLevel = block
      .split("\n")
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(":")[0]);
    const expected = TASK_FRONTMATTER_KEY_ORDER.filter(
      (key) => (GOLDEN_TASK_FRONTMATTER as Record<string, unknown>)[key] !== undefined,
    );
    expect(topLevel).toEqual(expected);
    expect(topLevel.slice(0, 5)).toEqual(["id", "scope", "stage", "created", "updated"]);
  });

  it("Test 1c: omits absent optional keys and emits nested maps in their own fixed order", () => {
    const {
      priority: _priority,
      due: _due,
      decision: _decision,
      ...rest
    } = GOLDEN_TASK_FRONTMATTER;
    const block = serializeTaskFrontmatter({
      ...rest,
      generatedBy: { runId: "run-7", automation: "daily-brief" },
    });
    expect(block).not.toMatch(/^priority:/m);
    expect(block).not.toMatch(/^due:/m);
    expect(block).not.toMatch(/^decision:/m);
    expect(block).toContain("generatedBy:\n  automation: daily-brief\n  runId: run-7\n");
  });

  it("Test 1d: is deterministic, and passthrough keys can never override an owned key", () => {
    const once = serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER, GOLDEN_PASSTHROUGH);
    expect(serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER, GOLDEN_PASSTHROUGH)).toBe(once);
    const hostile = serializeTaskFrontmatter(GOLDEN_TASK_FRONTMATTER, [
      ["status", "cancelled"],
      ["extra", "kept"],
    ]);
    expect(hostile).not.toContain("cancelled");
    expect(hostile.endsWith("extra: kept\n")).toBe(true);
  });

  it("Test 1e: round-trips every valid hostile title through the CORE_SCHEMA load", () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const block = serializeTaskFrontmatter({ ...GOLDEN_TASK_FRONTMATTER, title });
      const loaded = yaml.safeLoad(block, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
      expect(loaded.title).toBe(title);
      expect(loaded.status).toBe("done");
    }
  });
});
