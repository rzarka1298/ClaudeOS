// Plan 06-15, task 1: a task note round-trips through parse and stringify and
// is written to disk with a fixed filename (D-29, D-30, T-06-19, T-06-20,
// T-06-26). Test numbers below match the plan's behaviour list.
//
// Hostile data comes from the shared domain corpus, never a local copy.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_BY_KEY_ORDER,
  HOSTILE_TASK_TITLES,
  NOTE_FRONTMATTER_KEY_ORDER,
  TASK_DECISION_KEY_ORDER,
  TASK_FILE_MAX_BYTES,
  TASK_FRONTMATTER_KEY_ORDER,
  TASK_FRONTMATTER_MAX_BYTES,
  type TaskFrontmatter,
  TaskFrontmatterSchema,
  taskFileName,
  VALID_HOSTILE_TASK_TITLES,
  workspaceScope,
  YAML_NOTE_VARIANTS,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorkspace, initializeVault } from "./setup.js";
import {
  parseTaskNote,
  stringifyTaskNote,
  type TaskNoteError,
  TaskNoteInvalidError,
  TaskNoteRefusedDelimiterError,
  TaskNoteTooLargeError,
  writeTaskNote,
} from "./task-note.js";
import { WorkspaceScopeViolationError } from "./workspace-scope.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ID = "a0123456789abcdefghijklmn";

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vtask-"));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function frontmatterFor(title: string, extra: Record<string, unknown> = {}): TaskFrontmatter {
  return TaskFrontmatterSchema.parse({
    id: ID,
    scope: "global",
    stage: "capture",
    created: "2026-10-05T12:00:00.000Z",
    updated: "2026-10-05T12:00:00.000Z",
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
    type: "task",
    title,
    status: "inbox",
    ...extra,
  });
}

function frontmatterBlock(text: string): string[] {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  return lines.slice(1, end);
}

function topLevelKeys(text: string): string[] {
  return frontmatterBlock(text)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

function treeNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("Test 1: round trip over the shared hostile corpus", () => {
  test("the corpus is large enough to mean something", () => {
    expect(VALID_HOSTILE_TASK_TITLES.length).toBeGreaterThanOrEqual(60);
  });

  test("every valid hostile title parses back to the identical task and serialises to the same bytes", () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const fm = frontmatterFor(title);
      const text = stringifyTaskNote(fm, "Body line\n");
      const parsed = parseTaskNote(text);
      expect(parsed.frontmatter.title).toBe(title);
      expect(parsed.frontmatter).toEqual(fm);
      expect(parsed.body).toBe("Body line\n");
      expect(stringifyTaskNote(parsed.frontmatter, parsed.body, parsed.passthrough)).toBe(text);
    }
  });

  test("hostile titles never add a top-level key or a second document", () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const text = stringifyTaskNote(frontmatterFor(title), "");
      const expected = TASK_FRONTMATTER_KEY_ORDER.filter(
        (key) => key !== "priority" && key !== "due" && key !== "scheduled",
      ).filter((key) => frontmatterFor(title)[key as keyof TaskFrontmatter] !== undefined);
      expect(topLevelKeys(text)).toEqual(expected);
    }
  });
});

describe("Test 2: key order", () => {
  const full = frontmatterFor("Plan the quarter", {
    claimType: "recommendation",
    generatedBy: { runId: "run-1", model: "m", automation: "a", skill: "s" },
    contentHash: "abc",
    priority: "high",
    due: "2026-10-09",
    scheduled: "2026-10-08T09:00:00-04:00",
    completed: "2026-10-10T09:00:00Z",
    assignee: "automation",
    sourceType: "research",
    sourceLink: "https://example.test/a",
    parent: "b0123456789abcdefghijklmn",
    dependencies: ["c0123456789abcdefghijklmn"],
    tags: ["work", "review"],
    decision: { at: "2026-10-06T10:00:00.000Z", outcome: "accepted" },
  });

  test("the provenance keys come first, then the task keys, in the domain order", () => {
    const text = stringifyTaskNote(full, "");
    const keys = topLevelKeys(text);
    const expected = TASK_FRONTMATTER_KEY_ORDER.filter(
      (key) => (full as unknown as Record<string, unknown>)[key] !== undefined,
    );
    expect(keys).toEqual(expected);
    expect(keys.slice(0, 12)).toEqual(
      NOTE_FRONTMATTER_KEY_ORDER.filter(
        (key) => (full as unknown as Record<string, unknown>)[key] !== undefined,
      ),
    );
  });

  test("the nested generatedBy and decision maps use their own fixed orders", () => {
    const lines = frontmatterBlock(stringifyTaskNote(full, ""));
    const nested = (key: string): string[] => {
      const start = lines.indexOf(`${key}:`);
      const out: string[] = [];
      for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i] ?? ""); i++) {
        out.push((lines[i] ?? "").trim().split(":")[0] ?? "");
      }
      return out;
    };
    expect(nested("generatedBy")).toEqual([...GENERATED_BY_KEY_ORDER]);
    expect(nested("decision")).toEqual([...TASK_DECISION_KEY_ORDER]);
  });

  test("absent optional keys are omitted", () => {
    const keys = topLevelKeys(stringifyTaskNote(frontmatterFor("Plain"), ""));
    for (const absent of ["claimType", "contentHash", "priority", "due", "decision", "parent"]) {
      expect(keys).not.toContain(absent);
    }
  });

  test("passthrough keys follow in read order and never override an owned key", () => {
    const text = stringifyTaskNote(frontmatterFor("Plain"), "", {
      zeta: 1,
      title: "forged",
      status: "done",
      alpha: ["x"],
    });
    const keys = topLevelKeys(text);
    expect(keys.slice(-2)).toEqual(["zeta", "alpha"]);
    expect(keys.filter((key) => key === "title")).toHaveLength(1);
    expect(parseTaskNote(text).frontmatter.title).toBe("Plain");
    expect(parseTaskNote(text).frontmatter.status).toBe("inbox");
  });

  test("the keys another tool added survive a read and rewrite in order", () => {
    const variant = YAML_NOTE_VARIANTS.find((entry) => entry.name === "unknown-keys");
    if (variant === undefined) throw new Error("corpus variant missing");
    const parsed = parseTaskNote(variant.text);
    expect(Object.keys(parsed.passthrough)).toEqual(["cssclasses", "aliases", "rating"]);
    const again = stringifyTaskNote(parsed.frontmatter, parsed.body, parsed.passthrough);
    expect(topLevelKeys(again).slice(-3)).toEqual(["cssclasses", "aliases", "rating"]);
    expect(parseTaskNote(again).passthrough).toEqual(parsed.passthrough);
  });
});

describe("Test 3: dates stay strings", () => {
  const withDue = (due: string, quote = ""): string =>
    [
      "---",
      `id: ${ID}`,
      "scope: global",
      "stage: capture",
      "created: 2026-10-05T12:00:00.000Z",
      "updated: 2026-10-05T12:00:00.000Z",
      "generatedBy: {}",
      "aiGenerated: false",
      "sources: []",
      "confidence: unverified",
      "lastReviewed: null",
      "type: task",
      "title: A task",
      "status: inbox",
      `due: ${quote}${due}${quote}`,
      "sourceType: manual",
      "dependencies: []",
      "tags: []",
      "---",
      "",
    ].join("\n");

  test("an unquoted calendar date is the string, not a Date", () => {
    const parsed = parseTaskNote(withDue("2026-10-04"));
    expect(parsed.frontmatter.due).toBe("2026-10-04");
    expect(typeof parsed.frontmatter.due).toBe("string");
    expect(parsed.frontmatter.created).toBe("2026-10-05T12:00:00.000Z");
  });

  test("quoted dates, an offset instant and a double-quoted string parse", () => {
    expect(parseTaskNote(withDue("2026-10-04", "'")).frontmatter.due).toBe("2026-10-04");
    expect(parseTaskNote(withDue("2026-10-04", '"')).frontmatter.due).toBe("2026-10-04");
    expect(parseTaskNote(withDue("2026-10-09T15:00:00-04:00")).frontmatter.due).toBe(
      "2026-10-09T15:00:00-04:00",
    );
    expect(parseTaskNote(withDue("2026-10-09T15:00:00Z", '"')).frontmatter.due).toBe(
      "2026-10-09T15:00:00Z",
    );
  });

  test("the serializer re-emits a date-like string quoted so it is not reinterpreted", () => {
    const text = stringifyTaskNote(frontmatterFor("Dated", { due: "2026-10-04" }), "");
    expect(text).toMatch(/^due: ['"]2026-10-04['"]$/m);
    const parsed = parseTaskNote(text);
    expect(parsed.frontmatter.due).toBe("2026-10-04");
  });
});

describe("Test 4: Obsidian-style YAML variants", () => {
  test("every shared variant gives the outcome the corpus names", () => {
    for (const variant of YAML_NOTE_VARIANTS) {
      if (variant.outcome === "valid") {
        const parsed = parseTaskNote(variant.text);
        expect(parsed.frontmatter.id).toBe(variant.id);
        continue;
      }
      let caught: unknown;
      try {
        parseTaskNote(variant.text);
      } catch (error) {
        caught = error;
      }
      expect(caught, variant.name).toBeInstanceOf(TaskNoteInvalidError);
      expect((caught as TaskNoteInvalidError).reason).toBe(
        variant.outcome === "missing-id" ? "missing-id" : "invalid-frontmatter",
      );
    }
  });

  test("flow-style and block-style tags parse to the same task", () => {
    const find = (name: string) => {
      const found = YAML_NOTE_VARIANTS.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(name);
      return parseTaskNote(found.text).frontmatter.tags;
    };
    expect(find("flow-style-tags")).toEqual(["work", "review"]);
    expect(find("block-style-tags")).toEqual(["work", "review"]);
  });

  test("a tag list written by the property editor round-trips", () => {
    const found = YAML_NOTE_VARIANTS.find((entry) => entry.name === "block-style-tags");
    if (found === undefined) throw new Error("variant missing");
    const parsed = parseTaskNote(found.text);
    const again = parseTaskNote(
      stringifyTaskNote(parsed.frontmatter, parsed.body, parsed.passthrough),
    );
    expect(again.frontmatter).toEqual(parsed.frontmatter);
  });

  test("double-quoted strings, unquoted words, CRLF and an empty body parse", () => {
    for (const name of [
      "double-quoted-strings",
      "unquoted-yes-title",
      "crlf-line-endings",
      "empty-body",
    ]) {
      const found = YAML_NOTE_VARIANTS.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(name);
      expect(() => parseTaskNote(found.text), name).not.toThrow();
    }
    const yes = YAML_NOTE_VARIANTS.find((entry) => entry.name === "unquoted-yes-title");
    expect(parseTaskNote(yes?.text ?? "").frontmatter.title).toBe("yes");
  });
});

describe("Test 5: refusals", () => {
  const valid = (extra = ""): string =>
    `---\nid: ${ID}\nscope: global\nstage: capture\ncreated: '2026-10-05T12:00:00Z'\nupdated: '2026-10-05T12:00:00Z'\ngeneratedBy: {}\naiGenerated: false\nsources: []\nconfidence: unverified\nlastReviewed: null\ntype: task\ntitle: T\nstatus: inbox\n${extra}---\n`;

  function reasonOf(raw: string): { error: unknown; reason: string | undefined } {
    try {
      parseTaskNote(raw);
    } catch (error) {
      return { error, reason: (error as TaskNoteError).reason };
    }
    return { error: undefined, reason: undefined };
  }

  test("a language-tagged opening delimiter is refused in every spelling", () => {
    for (const opening of ["---js", "---JS", "---javascript", "--- js", "---coffee", "---toml"]) {
      const { error, reason } = reasonOf(valid().replace("---\n", `${opening}\n`));
      expect(error, opening).toBeInstanceOf(TaskNoteRefusedDelimiterError);
      expect(reason).toBe("refused-delimiter");
    }
    const bom = reasonOf(`﻿${valid().replace("---\n", "---js\n")}`);
    expect(bom.reason).toBe("refused-delimiter");
  });

  test("executable and object tags are refused, not loaded", () => {
    const tagged = (tag: string): string => `extra: ${tag}\n`;
    for (const tag of [
      '!!js/function "function () { return 1 }"',
      "!!js/regexp /x/",
      "!!js/undefined ''",
      "!!python/object:os.system {}",
      "!!python/name:os.system ''",
    ]) {
      const { error, reason } = reasonOf(valid(tagged(tag)));
      expect(error, tag).toBeInstanceOf(TaskNoteInvalidError);
      expect(reason).toBe("invalid-yaml");
    }
  });

  test("a merge key is an ordinary key under the core schema, not an expansion", () => {
    const parsed = parseTaskNote(valid("base: &b {x: 1}\nother:\n  <<: *b\n"));
    expect(parsed.passthrough.other).toEqual({ "<<": { x: 1 } });
  });

  test("frontmatter over 64 KiB is refused before any task object is returned", () => {
    const big = `pad: ${"x".repeat(TASK_FRONTMATTER_MAX_BYTES + 10)}\n`;
    const { error, reason } = reasonOf(valid(big));
    expect(error).toBeInstanceOf(TaskNoteTooLargeError);
    expect(reason).toBe("frontmatter-too-large");
  });

  test("a whole file over 256 KiB is refused", () => {
    const { error, reason } = reasonOf(`${valid()}${"y".repeat(TASK_FILE_MAX_BYTES + 1)}`);
    expect(error).toBeInstanceOf(TaskNoteTooLargeError);
    expect(reason).toBe("too-large");
    // Counted in bytes, not characters.
    const wide = `${valid()}${"日".repeat(Math.ceil(TASK_FILE_MAX_BYTES / 3) + 1)}`;
    expect(reasonOf(wide).reason).toBe("too-large");
  });

  test("an alias bomb small enough to load is refused when it would expand past the limit", () => {
    const lines: string[] = ["l0: &l0 [x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level <= 7; level++) {
      const refs = Array.from({ length: 9 }, () => `*l${level - 1}`).join(", ");
      lines.push(`l${level}: &l${level} [${refs}]`);
    }
    const bomb = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(bomb)).toBeLessThan(TASK_FRONTMATTER_MAX_BYTES);
    const { error, reason } = reasonOf(valid(bomb));
    expect(error).toBeInstanceOf(TaskNoteTooLargeError);
    expect(reason).toBe("frontmatter-too-large");
  });

  test("a harmless alias is still read", () => {
    const parsed = parseTaskNote(valid("a: &a [1, 2]\nb: *a\n"));
    expect(parsed.passthrough.b).toEqual([1, 2]);
  });

  test("a missing id and an id that is not a note id are reported, never minted", () => {
    const noId = valid().replace(`id: ${ID}\n`, "");
    const missing = reasonOf(noId);
    expect(missing.error).toBeInstanceOf(TaskNoteInvalidError);
    expect(missing.reason).toBe("missing-id");
    const badId = reasonOf(valid().replace(`id: ${ID}`, "id: copy-of-a-task"));
    expect(badId.error).toBeInstanceOf(TaskNoteInvalidError);
    expect(badId.reason).toBe("invalid-frontmatter");
    const nullId = reasonOf(valid().replace(`id: ${ID}`, "id: null"));
    expect(nullId.reason).toBe("missing-id");
  });

  test("broken YAML, a duplicated key, a non-map block and a missing block are not repaired", () => {
    expect(reasonOf(valid("x: [unclosed\n")).reason).toBe("invalid-yaml");
    expect(reasonOf(valid("title: second\n")).reason).toBe("invalid-yaml");
    expect(reasonOf("---\n- a\n- b\n---\n").reason).toBe("invalid-frontmatter");
    expect(reasonOf("---\njust text\n---\n").reason).toBe("invalid-frontmatter");
    expect(reasonOf("# Only a body\n").reason).toBe("missing-id");
    expect(reasonOf("").reason).toBe("missing-id");
  });

  test("a title with an invisible or control character is refused by the schema", () => {
    const bad = HOSTILE_TASK_TITLES.filter((title) => !VALID_HOSTILE_TASK_TITLES.includes(title));
    expect(bad.length).toBeGreaterThan(10);
    for (const title of bad) {
      // Hand-built YAML so the refusal is the reader's, not the writer's.
      const raw = valid().replace("title: T", `title: ${JSON.stringify(title)}`);
      expect(reasonOf(raw).reason, JSON.stringify(title)).toBe("invalid-frontmatter");
    }
  });

  test("a refusal carries a fixed reason and no file text", () => {
    const { error } = reasonOf(valid("pad: secret-marker-text\n").replace("title: T", "title: 7"));
    expect((error as TaskNoteError).message).not.toContain("secret-marker-text");
  });
});

describe("Test 6: body safety", () => {
  const bodies = [
    "---\nforged: yes\nstatus: done\n---\nafter\n",
    "---js\nprocess.exit(1)\n---\n",
    "---yaml\nstatus: done\n---\n",
    "---\n",
    "no trailing newline",
    "",
    "\n\nleading blank lines\n",
    "key:: value\n#tag text\n",
  ];

  test("a body is preserved byte for byte and never alters the frontmatter", () => {
    const fm = frontmatterFor("Safe body");
    for (const body of bodies) {
      const text = stringifyTaskNote(fm, body);
      const parsed = parseTaskNote(text);
      expect(parsed.body, JSON.stringify(body)).toBe(body);
      expect(parsed.frontmatter).toEqual(fm);
      expect(parsed.passthrough).toEqual({});
      expect(stringifyTaskNote(parsed.frontmatter, parsed.body, parsed.passthrough)).toBe(text);
    }
  });
});

describe("Test 7: writeTaskNote", () => {
  test("mints the id, derives the file name once and writes the whole file", () => {
    const written = writeTaskNote({
      vaultRoot,
      scope: "global",
      title: "Draft the weekly review",
      body: "Notes for the review.\n",
      intent: "ready",
      now: NOW,
    });
    expect(written.id).toMatch(/^[0-9a-z]{25}$/);
    expect(written.path).toBe(
      `global/tasks/${taskFileName("Draft the weekly review", written.id)}`,
    );
    expect(basename(written.path)).toMatch(/^draft-the-weekly-review-[0-9a-z]{8}\.md$/);
    expect(basename(written.path).slice(-11, -3)).toBe(written.id.slice(-8));
    expect(written.frontmatter.status).toBe("ready");
    expect(written.frontmatter.stage).toBe("capture");
    expect(written.frontmatter.type).toBe("task");
    expect(written.frontmatter.created).toBe(NOW.toISOString());
    expect(written.frontmatter.updated).toBe(NOW.toISOString());
    expect(written.frontmatter.scope).toBe("global");

    const bytes = readFileSync(written.absolutePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(written.contentHash);
    const parsed = parseTaskNote(bytes.toString("utf8"));
    expect(parsed.frontmatter).toEqual(written.frontmatter);
    expect(parsed.body).toBe("Notes for the review.\n");
    expect(bytes.toString("utf8")).toBe(
      stringifyTaskNote(written.frontmatter, "Notes for the review.\n"),
    );
  });

  test("the default intent is inbox and the other fields are stored as given", () => {
    const written = writeTaskNote({
      vaultRoot,
      scope: "global",
      title: "Pay the invoice",
      priority: "high",
      due: "2026-10-09",
      tags: ["money", "admin"],
      projectId: "a1b2c3d4e0123456789abcdef",
      now: NOW,
    });
    expect(written.frontmatter.status).toBe("inbox");
    expect(written.frontmatter.priority).toBe("high");
    expect(written.frontmatter.due).toBe("2026-10-09");
    expect(written.frontmatter.tags).toEqual(["money", "admin"]);
    expect(written.frontmatter.sourceType).toBe("manual");
  });

  test("an automation can write a proposed task with provenance", () => {
    const written = writeTaskNote({
      vaultRoot,
      scope: "global",
      title: "Review the open pull requests",
      intent: "proposed",
      aiGenerated: true,
      claimType: "recommendation",
      generatedBy: { automation: "daily-research" },
      sourceType: "research",
      sourceLink: "https://example.test/report",
      now: NOW,
    });
    expect(written.frontmatter.status).toBe("proposed");
    expect(written.frontmatter.aiGenerated).toBe(true);
    expect(written.frontmatter.claimType).toBe("recommendation");
    expect(written.frontmatter.generatedBy).toEqual({ automation: "daily-research" });
  });

  test("a workspace scope writes inside that workspace", () => {
    initializeVault(vaultRoot);
    const workspace = createWorkspace(vaultRoot, "Research");
    const written = writeTaskNote({
      vaultRoot,
      scope: workspaceScope(workspace.workspaceId),
      title: "Compare the options",
      now: NOW,
    });
    expect(written.path.startsWith(`workspaces/${workspace.workspaceId}/tasks/`)).toBe(true);
    expect(written.frontmatter.scope).toBe(`workspace:${workspace.workspaceId}`);
  });

  test("every valid hostile title gives an ASCII file name and a title that round-trips", () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const written = writeTaskNote({ vaultRoot, scope: "global", title, now: NOW });
      const name = basename(written.path);
      expect(name, title).toMatch(/^[a-z0-9-]{1,48}-[0-9a-z]{8}\.md$/);
      expect(dirname(written.path)).toBe("global/tasks");
      expect(parseTaskNote(readFileSync(written.absolutePath, "utf8")).frontmatter.title).toBe(
        title,
      );
    }
  });

  test("a title the schema refuses writes nothing", () => {
    const before = treeNames(join(vaultRoot, "global", "tasks"));
    for (const title of HOSTILE_TASK_TITLES.filter((t) => !VALID_HOSTILE_TASK_TITLES.includes(t))) {
      expect(() => writeTaskNote({ vaultRoot, scope: "global", title, now: NOW }), title).toThrow();
    }
    expect(treeNames(join(vaultRoot, "global", "tasks"))).toEqual(before);
  });

  test("a second task never changes the first file", () => {
    const first = writeTaskNote({ vaultRoot, scope: "global", title: "Same title", now: NOW });
    const firstBytes = readFileSync(first.absolutePath);
    const second = writeTaskNote({ vaultRoot, scope: "global", title: "Same title", now: NOW });
    expect(second.path).not.toBe(first.path);
    expect(second.id).not.toBe(first.id);
    expect(readFileSync(first.absolutePath).equals(firstBytes)).toBe(true);
  });

  test("the write leaves no temporary file behind", () => {
    const written = writeTaskNote({ vaultRoot, scope: "global", title: "Atomic", now: NOW });
    expect(treeNames(dirname(written.absolutePath))).toEqual([basename(written.path)]);
  });
});

describe("Test 8: scope and containment are checked before any directory exists", () => {
  test("a workspace that does not exist on disk is refused and creates nothing", () => {
    initializeVault(vaultRoot);
    const before = treeNames(join(vaultRoot, "workspaces"));
    expect(() =>
      writeTaskNote({
        vaultRoot,
        scope: "workspace:zzzzzzzzzzzzzzzzzzzzzzzzz",
        title: "Orphan",
        now: NOW,
      }),
    ).toThrow(WorkspaceScopeViolationError);
    expect(treeNames(join(vaultRoot, "workspaces"))).toEqual(before);
  });

  test("a scope string with a separator or a traversal is refused", () => {
    initializeVault(vaultRoot);
    for (const scope of [
      "workspace:../../etc",
      "workspace:a/b",
      "../global",
      "global/../x",
      "",
      "workspace:",
    ]) {
      expect(() => writeTaskNote({ vaultRoot, scope, title: "Escape", now: NOW }), scope).toThrow(
        WorkspaceScopeViolationError,
      );
    }
    expect(existsSync(join(vaultRoot, "..", "x"))).toBe(false);
  });

  test("a tasks folder that is a symlink out of the vault is refused", () => {
    initializeVault(vaultRoot);
    const outside = mkdtempSync(join(TEST_BASE, "vtask-outside-"));
    try {
      symlinkSync(outside, join(vaultRoot, "global", "tasks"));
      expect(() => writeTaskNote({ vaultRoot, scope: "global", title: "Leak", now: NOW })).toThrow(
        WorkspaceScopeViolationError,
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Test 9: no index and no delete", () => {
  test("a task write regenerates no index and removes or moves nothing", () => {
    mkdirSync(join(vaultRoot, "global", "tasks"), { recursive: true });
    const sentinel = "sentinel index bytes\n";
    writeFileSync(join(vaultRoot, "global", "tasks", "index.md"), sentinel, "utf8");
    writeFileSync(join(vaultRoot, "global", "tasks", "hand-made.md"), "mine\n", "utf8");
    const before = treeNames(join(vaultRoot, "global", "tasks"));

    const written = writeTaskNote({ vaultRoot, scope: "global", title: "Add one", now: NOW });

    const after = treeNames(join(vaultRoot, "global", "tasks"));
    expect(after).toEqual([...before, basename(written.path)].sort());
    expect(readFileSync(join(vaultRoot, "global", "tasks", "index.md"), "utf8")).toBe(sentinel);
    expect(readFileSync(join(vaultRoot, "global", "tasks", "hand-made.md"), "utf8")).toBe("mine\n");
  });

  test("a write into a folder with no index does not create one", () => {
    const written = writeTaskNote({ vaultRoot, scope: "global", title: "No index", now: NOW });
    expect(existsSync(join(dirname(written.absolutePath), "index.md"))).toBe(false);
  });
});

describe("Test 10: the manifest and the lockfile", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  test("js-yaml is declared at the exact pin the plugin already uses", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages", "vault-repo", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const plugin = JSON.parse(
      readFileSync(join(repoRoot, "packages", "plugin", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["js-yaml"]).toBe("3.15.2");
    expect(manifest.dependencies["js-yaml"]).toBe(plugin.dependencies["js-yaml"]);
    expect(
      Object.keys(manifest.dependencies).some((name) => name.startsWith("@types/js-yaml")),
    ).toBe(false);
  });

  test("the lockfile holds one js-yaml package entry and no types package for it", () => {
    const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    const entries = lock.split("\n").filter((line) => /^ {2}js-yaml@/.test(line));
    expect(entries.filter((line) => line.startsWith("  js-yaml@3.15.2:"))).toHaveLength(2);
    expect(entries.every((line) => line.startsWith("  js-yaml@3.15.2:"))).toBe(true);
    expect(lock).not.toMatch(/@types\/js-yaml/);
  });
});
