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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NoteFrontmatterSchema,
  newNoteId,
  newWorkspaceId,
  TaskFrontmatterSchema,
  VALID_HOSTILE_TASK_TITLES,
  workspaceScope,
} from "@ccc/domain";
import { parseTaskContent, serializeTaskFrontmatter, updateTaskNote } from "@ccc/plugin";
import {
  initializeVault,
  parseNote,
  parseTaskNote,
  stringifyTaskNote,
  WorkspaceScopeViolationError,
  writeNote,
  writeTaskNote,
} from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fileSystemTaskVault } from "./task-fixtures.js";
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

// ---------------------------------------------------------------------------
// Plan 06-25 Task 3 (TASK-02, ADR-0020, T-06-19): the two task writers agree on every byte.

const TASK_ID = "a0123456789abcdefghijklmn";
const GOLDEN_TASK_FRONTMATTER = TaskFrontmatterSchema.parse({
  id: TASK_ID,
  scope: "global",
  stage: "capture",
  created: "2026-10-01T09:00:00.000Z",
  updated: "2026-10-05T12:00:00.000Z",
  generatedBy: { automation: "daily-brief", runId: "run-7" },
  aiGenerated: true,
  claimType: "summary",
  sources: ["note:abc"],
  confidence: "inferred",
  lastReviewed: null,
  type: "task",
  title: 'Review: the "Q4" plan # now',
  status: "done",
  priority: "high",
  due: "2026-10-09",
  scheduled: "2026-10-07T15:00:00-04:00",
  completed: "2026-10-05T12:00:00.000Z",
  projectId: "mfz0a1b2c0123456789abcdef",
  assignee: "user",
  sourceType: "manual",
  sourceLink: "https://example.test/a?b=1",
  parent: "b0123456789abcdefghijklmn",
  dependencies: ["c0123456789abcdefghijklmn"],
  tags: ["work", "q4/plan"],
  decision: { outcome: "accepted", at: "2026-10-02T08:00:00.000Z" },
});
const GOLDEN_PASSTHROUGH: readonly (readonly [string, unknown])[] = [
  ["aliases", ["Q4"]],
  ["cssclasses", ["wide"]],
  ["obs-key", "2026-10-04"],
];
const GOLDEN_BODY = "Line one.\n\n---\nnot a delimiter\n";
/** The same bytes the plugin's own golden test pins (06-18); the service writer must reproduce them exactly. */
const GOLDEN_TASK_NOTE = [
  "---",
  `id: ${TASK_ID}`,
  "scope: global",
  "stage: capture",
  "created: '2026-10-01T09:00:00.000Z'",
  "updated: '2026-10-05T12:00:00.000Z'",
  "generatedBy:",
  "  automation: daily-brief",
  "  runId: run-7",
  "aiGenerated: true",
  "claimType: summary",
  "sources:",
  "  - 'note:abc'",
  "confidence: inferred",
  "lastReviewed: null",
  "type: task",
  "title: 'Review: the \"Q4\" plan # now'",
  "status: done",
  "priority: high",
  "due: '2026-10-09'",
  "scheduled: '2026-10-07T15:00:00-04:00'",
  "completed: '2026-10-05T12:00:00.000Z'",
  "projectId: mfz0a1b2c0123456789abcdef",
  "assignee: user",
  "sourceType: manual",
  "sourceLink: 'https://example.test/a?b=1'",
  "parent: b0123456789abcdefghijklmn",
  "dependencies:",
  "  - c0123456789abcdefghijklmn",
  "tags:",
  "  - work",
  "  - q4/plan",
  "decision:",
  "  outcome: accepted",
  "  at: '2026-10-02T08:00:00.000Z'",
  "aliases:",
  "  - Q4",
  "cssclasses:",
  "  - wide",
  "obs-key: '2026-10-04'",
  "---",
  "Line one.",
  "",
  "---",
  "not a delimiter",
  "",
].join("\n");

const pluginBytes = (
  frontmatter: Parameters<typeof serializeTaskFrontmatter>[0],
  body: string,
  passthrough: readonly (readonly [string, unknown])[] = [],
): string => `---\n${serializeTaskFrontmatter(frontmatter, passthrough)}---\n${body}`;

/** A ready task as a hand edit or the Properties editor might leave it, one variant per entry. */
function ownedLines(overrides: Record<string, string> = {}): string[] {
  const lines: Record<string, string> = {
    id: `id: ${TASK_ID}`,
    scope: "scope: global",
    stage: "stage: capture",
    created: "created: '2026-10-01T09:00:00.000Z'",
    updated: "updated: '2026-10-01T09:00:00.000Z'",
    generatedBy: "generatedBy: {}",
    aiGenerated: "aiGenerated: false",
    sources: "sources: []",
    confidence: "confidence: unverified",
    lastReviewed: "lastReviewed: null",
    type: "type: task",
    title: "title: Draft the weekly review",
    status: "status: ready",
    due: "due: 2026-10-09",
    sourceType: "sourceType: manual",
    dependencies: "dependencies: []",
    tags: "tags: [work]",
    ...overrides,
  };
  return Object.values(lines);
}

const OBSIDIAN_VARIANTS: readonly { name: string; raw: string }[] = [
  {
    name: "unquoted date, flow tags and the owner's own keys",
    raw: ["---", ...ownedLines(), "aliases: [Weekly]", "cssclasses: wide", "---", "Body.\n"].join(
      "\n",
    ),
  },
  {
    name: "block tags and a double-quoted title with a colon",
    raw: [
      "---",
      ...ownedLines({ title: 'title: "Draft: the review"', tags: "tags:\n  - work\n  - home" }),
      "---",
      "Body.\n",
    ].join("\n"),
  },
  {
    name: "an unquoted instant for the due value",
    raw: ["---", ...ownedLines({ due: "due: 2026-10-09T15:00:00-04:00" }), "---", "Body.\n"].join(
      "\n",
    ),
  },
  {
    name: "an anchor and an alias in an owner key",
    raw: ["---", ...ownedLines(), "first: &x [1, 2]", "second: *x", "---", "Body.\n"].join("\n"),
  },
  {
    name: "a folded multi-line owner value",
    raw: ["---", ...ownedLines(), "notes: >", "  line one", "  line two", "---", "Body.\n"].join(
      "\n",
    ),
  },
  {
    name: "non-ASCII and typed owner values",
    raw: [
      "---",
      ...ownedLines(),
      'cafe: "café — résumé"',
      "count: 3",
      "flag: true",
      "nothing: null",
      "---",
      "Body.\n",
    ].join("\n"),
  },
  {
    name: "an empty body",
    raw: ["---", ...ownedLines(), "---", ""].join("\n"),
  },
  {
    name: "a body that holds a delimiter line",
    raw: ["---", ...ownedLines(), "---", "One.\n\n---\nTwo.\n"].join("\n"),
  },
];

describe("task writer parity: service and plugin (plan 06-25 Task 3, Test 1)", () => {
  test("the service writer reproduces the plugin's golden bytes exactly", () => {
    expect(
      stringifyTaskNote(
        GOLDEN_TASK_FRONTMATTER,
        GOLDEN_BODY,
        Object.fromEntries(GOLDEN_PASSTHROUGH),
      ),
    ).toBe(GOLDEN_TASK_NOTE);
    expect(pluginBytes(GOLDEN_TASK_FRONTMATTER, GOLDEN_BODY, GOLDEN_PASSTHROUGH)).toBe(
      GOLDEN_TASK_NOTE,
    );
  });

  test("both writers give identical bytes for every valid hostile title", () => {
    expect(VALID_HOSTILE_TASK_TITLES.length).toBeGreaterThan(100);
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const frontmatter = { ...GOLDEN_TASK_FRONTMATTER, title };
      const service = stringifyTaskNote(
        frontmatter,
        GOLDEN_BODY,
        Object.fromEntries(GOLDEN_PASSTHROUGH),
      );
      expect(pluginBytes(frontmatter, GOLDEN_BODY, GOLDEN_PASSTHROUGH), title).toBe(service);
      // And the title survives the readers on both sides, byte for byte.
      expect(parseTaskNote(service).frontmatter.title, title).toBe(title);
      const read = parseTaskContent(service);
      expect(read.kind === "ok" ? read.task.frontmatter.title : null, title).toBe(title);
    }
  });

  for (const variant of OBSIDIAN_VARIANTS) {
    test(`both readers and writers agree on a note with ${variant.name}`, () => {
      const service = parseTaskNote(variant.raw);
      const plugin = parseTaskContent(variant.raw);
      expect(plugin.kind).toBe("ok");
      if (plugin.kind !== "ok") return;
      expect(plugin.task.frontmatter).toEqual(service.frontmatter);
      expect(plugin.task.body).toBe(service.body);
      expect(plugin.task.passthrough.map(([key]) => key)).toEqual(Object.keys(service.passthrough));

      const fromService = stringifyTaskNote(service.frontmatter, service.body, service.passthrough);
      const fromPlugin = pluginBytes(
        plugin.task.frontmatter,
        plugin.task.body,
        plugin.task.passthrough,
      );
      expect(fromPlugin).toBe(fromService);
      // Rewriting what was written changes nothing, on either side.
      const again = parseTaskNote(fromService);
      expect(stringifyTaskNote(again.frontmatter, again.body, again.passthrough)).toBe(fromService);
      // An unquoted date is an all-day date, and stays a date string on rewrite.
      expect(fromService).not.toMatch(/^due: 2026-10-09$/m);
    });
  }
});

describe("a task written by one writer and edited by the other (plan 06-25 Task 3, Test 2)", () => {
  const THEN = "2026-10-06T10:30:00.000Z";
  const LATER = "2026-10-07T08:00:00.000Z";

  test("service write, plugin edit, service read: id and every field survive", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      initializeVault(vaultRoot);
      const written = writeTaskNote({
        vaultRoot,
        scope: "global",
        title: 'Parity: the "hostile" # title',
        body: "Body line\n\n---\nstill body\n",
        intent: "ready",
        due: "2026-10-09",
        tags: ["work", "q4/plan"],
        priority: "high",
        now: new Date(THEN),
      });
      const raw = readFileSync(join(vaultRoot, written.path), "utf8");
      const vault = fileSystemTaskVault(vaultRoot);
      const result = await updateTaskNote(vault, { path: written.path }, raw, {
        now: LATER,
        changes: { status: "done", completed: LATER },
      });
      expect(result.kind).toBe("applied");

      const after = parseTaskNote(readFileSync(join(vaultRoot, written.path), "utf8"));
      expect(after.frontmatter.id).toBe(written.id);
      expect(after.frontmatter).toEqual({
        ...written.frontmatter,
        status: "done",
        completed: LATER,
        updated: LATER,
      });
      expect(after.body).toBe("Body line\n\n---\nstill body\n");
    });
  });

  test("plugin write, service rewrite, plugin read: id and every field survive, and a no-op rewrite changes no byte", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      initializeVault(vaultRoot);
      const id = newNoteId();
      const frontmatter = TaskFrontmatterSchema.parse({
        ...GOLDEN_TASK_FRONTMATTER,
        id,
        status: "ready",
        completed: undefined,
      });
      const relativePath = `global/tasks/plugin-written-${id.slice(-8)}.md`;
      const text = pluginBytes(frontmatter, "Plugin body.\n", GOLDEN_PASSTHROUGH);
      writeFileSync(join(vaultRoot, relativePath), text);

      const parsed = parseTaskNote(text);
      expect(stringifyTaskNote(parsed.frontmatter, parsed.body, parsed.passthrough)).toBe(text);

      const edited = stringifyTaskNote(
        { ...parsed.frontmatter, status: "in-progress", updated: LATER },
        parsed.body,
        parsed.passthrough,
      );
      writeFileSync(join(vaultRoot, relativePath), edited);
      const read = parseTaskContent(readFileSync(join(vaultRoot, relativePath), "utf8"));
      expect(read.kind).toBe("ok");
      if (read.kind !== "ok") return;
      expect(read.task.frontmatter.id).toBe(id);
      expect(read.task.frontmatter).toEqual({
        ...frontmatter,
        status: "in-progress",
        updated: LATER,
      });
      expect(read.task.passthrough).toEqual(GOLDEN_PASSTHROUGH);
    });
  });

  test("two identical edits from the same prior content give identical bytes", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      initializeVault(vaultRoot);
      const raw = pluginBytes(GOLDEN_TASK_FRONTMATTER, GOLDEN_BODY, GOLDEN_PASSTHROUGH);
      const vault = fileSystemTaskVault(vaultRoot);
      const outcomes: string[] = [];
      for (const name of ["first", "second"]) {
        const path = `global/tasks/${name}-12345678.md`;
        writeFileSync(join(vaultRoot, path), raw);
        const result = await updateTaskNote(vault, { path }, raw, {
          now: LATER,
          changes: { status: "ready", completed: null },
        });
        expect(result.kind).toBe("applied");
        outcomes.push(readFileSync(join(vaultRoot, path), "utf8"));
      }
      expect(outcomes[1]).toBe(outcomes[0]);
    });
  });
});
