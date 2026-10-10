// Plan 06-18, Task 1: the conflict-safe task note updater (D-35, D-37, T-06-19,
// T-06-22, T-06-26). Expected bytes are literal strings in the fixtures file,
// never produced by the code under test.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_FILE_MAX_BYTES,
  TASK_FRONTMATTER_MAX_BYTES,
  VALID_HOSTILE_TASK_TITLES,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { FakeVault } from "../test-support/fake-obsidian-host.js";
import {
  COMPLETED_NOTE,
  NOW,
  OPEN_BODY,
  OPEN_NOTE,
  TASK_ID,
  TASK_PATH,
  taskEditVault,
} from "../test-support/task-note-fixtures.js";
import { parseTaskContent, readTaskForEdit, updateTaskNote } from "./task-update.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function setup(content = OPEN_NOTE): { vault: FakeVault; file: { path: string } } {
  const vault = new FakeVault({ [TASK_PATH]: content });
  return { vault, file: vault.file(TASK_PATH) };
}

describe("Test 2: updateTaskNote applies one edit and nothing else", () => {
  it("commits a status change, advances updated, keeps the body and passthrough keys byte for byte", async () => {
    const { vault, file } = setup();
    const result = await updateTaskNote(vault, file, OPEN_NOTE, {
      now: NOW,
      changes: { status: "done", completed: NOW },
    });
    expect(result.kind).toBe("applied");
    expect(vault.read(TASK_PATH)).toBe(COMPLETED_NOTE);
    expect(vault.read(TASK_PATH).endsWith(`---\n${OPEN_BODY}`)).toBe(true);
    expect(vault.processCallCount).toBe(1);
    expect(vault.writtenPaths).toEqual([TASK_PATH]);
    if (result.kind === "applied") {
      expect(result.content).toBe(COMPLETED_NOTE);
      expect(result.task.status).toBe("done");
    }
  });

  it("replaces the body only when the edit carries a description", async () => {
    const { vault, file } = setup();
    await updateTaskNote(vault, file, OPEN_NOTE, {
      now: NOW,
      changes: { description: "New text.\n" },
    });
    expect(vault.read(TASK_PATH).endsWith("---\nNew text.\n")).toBe(true);
    expect(vault.read(TASK_PATH)).toContain("zeta: 1\naliases:\n  - Weekly\ncssclasses: wide\n");
  });

  it("clears an optional key when the change is null and refuses an edit that breaks the schema", async () => {
    const { vault, file } = setup();
    const cleared = await updateTaskNote(vault, file, OPEN_NOTE, {
      now: NOW,
      changes: { priority: null, due: null },
    });
    expect(cleared.kind).toBe("applied");
    expect(vault.read(TASK_PATH)).not.toMatch(/^priority:/m);
    expect(vault.read(TASK_PATH)).not.toMatch(/^due:/m);

    const second = setup();
    const invalid = await updateTaskNote(second.vault, second.file, OPEN_NOTE, {
      now: NOW,
      changes: { title: "line one\nline two" },
    });
    expect(invalid).toEqual({ kind: "invalid", fields: { title: "invalid" } });
    expect(second.vault.read(TASK_PATH)).toBe(OPEN_NOTE);
    expect(second.vault.processCallCount).toBe(0);
  });

  it("round-trips every valid hostile title through an edit", async () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const { vault, file } = setup();
      const result = await updateTaskNote(vault, file, OPEN_NOTE, { now: NOW, changes: { title } });
      expect(result.kind).toBe("applied");
      const reread = parseTaskContent(vault.read(TASK_PATH));
      expect(reread.kind === "ok" && reread.task.frontmatter.title).toBe(title);
      expect(reread.kind === "ok" && reread.task.body).toBe(OPEN_BODY);
    }
  });
});

describe("Test 3: a conflict is reported, never forced", () => {
  it("leaves the note untouched when it changed between read and write", async () => {
    const { vault, file } = setup();
    const external = OPEN_NOTE.replace("Body with", "Body typed in the editor with");
    vault.setExternally(TASK_PATH, external);
    const result = await updateTaskNote(vault, file, OPEN_NOTE, {
      now: NOW,
      changes: { status: "done" },
    });
    expect(result).toEqual({ kind: "conflict" });
    expect(vault.read(TASK_PATH)).toBe(external);
    expect(vault.processCallCount).toBe(1);
  });
});

describe("readTaskForEdit", () => {
  it("returns the content to use as the expected prior content and the parsed task", async () => {
    const { vault, file } = setup();
    const read = await readTaskForEdit(taskEditVault(vault), file);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.content).toBe(OPEN_NOTE);
      expect(read.task.frontmatter.id).toBe(TASK_ID);
      expect(read.task.body).toBe(OPEN_BODY);
      expect(read.task.passthrough.map(([key]) => key)).toEqual(["zeta", "aliases", "cssclasses"]);
    }
  });

  it("reports an unreadable note, and a missing file, as unreadable", async () => {
    const { vault, file } = setup("not a task note");
    expect((await readTaskForEdit(taskEditVault(vault), file)).kind).toBe("unreadable");
    const missing = await readTaskForEdit(taskEditVault(vault), { path: "global/tasks/none.md" });
    expect(missing).toEqual({ kind: "unreadable", reason: "read-failed" });
  });
});

describe("Test 6: unreadable notes are reported and never rewritten", () => {
  const bigFrontmatter = `---\nid: ${TASK_ID}\nnotes: ${"a".repeat(TASK_FRONTMATTER_MAX_BYTES + 1)}\n---\nbody\n`;
  const bigFile = `${OPEN_NOTE}${"x".repeat(TASK_FILE_MAX_BYTES)}`;
  const cases: Record<string, [string, string]> = {
    "frontmatter over 64 KiB": [bigFrontmatter, "frontmatter-too-large"],
    "file over 256 KiB": [bigFile, "too-large"],
    "unreadable YAML": [
      OPEN_NOTE.replace("title: Draft the weekly review", "title: [unclosed"),
      "invalid-yaml",
    ],
    "failing the task schema": [
      OPEN_NOTE.replace("status: ready", "status: waiting"),
      "invalid-frontmatter",
    ],
    "no id": [OPEN_NOTE.replace(`id: ${TASK_ID}\n`, ""), "missing-id"],
    "a language-tagged opening delimiter": [
      OPEN_NOTE.replace("---\n", "---js\n"),
      "refused-delimiter",
    ],
    "no frontmatter": ["just text\n", "no-frontmatter"],
    "alias amplification": [
      `---\nid: ${TASK_ID}\n${[
        "a0: &a0 [x,x,x,x,x,x,x,x,x]",
        ...Array.from(
          { length: 6 },
          (_, i) => `a${i + 1}: &a${i + 1} [${Array(9).fill(`*a${i}`).join(",")}]`,
        ),
      ].join("\n")}\n---\n`,
      "frontmatter-too-large",
    ],
  };

  for (const [name, [content, reason]] of Object.entries(cases)) {
    it(`${name} is unreadable (${reason}) and the note is not rewritten`, async () => {
      const { vault, file } = setup(content);
      const result = await updateTaskNote(vault, file, content, {
        now: NOW,
        changes: { status: "done" },
      });
      expect(result).toEqual({ kind: "unreadable", reason });
      expect(vault.read(TASK_PATH)).toBe(content);
      expect(vault.processCallCount).toBe(0);
    });
  }
});

describe("Test 8: dates stay strings", () => {
  it("an unquoted date parses as a string and survives an unrelated edit as the same date", async () => {
    const parsed = parseTaskContent(OPEN_NOTE);
    expect(parsed.kind === "ok" && parsed.task.frontmatter.due).toBe("2026-10-09");
    const { vault, file } = setup();
    await updateTaskNote(vault, file, OPEN_NOTE, { now: NOW, changes: { status: "in-progress" } });
    const after = vault.read(TASK_PATH);
    expect(after).toContain("due: '2026-10-09'\n");
    const reread = parseTaskContent(after);
    expect(reread.kind === "ok" && reread.task.frontmatter.due).toBe("2026-10-09");
  });
});

describe("Test 9: export and purity", () => {
  const importsObsidianValue = (source: string): boolean =>
    /^import\s+(?!type\b)[^;]*from\s+["']obsidian["']/m.test(source) ||
    /require\(\s*["']obsidian["']\s*\)/.test(source);

  it("exports the writer pieces from the package entry", () => {
    const entry = readFileSync(join(SRC, "index.ts"), "utf8");
    for (const name of [
      "serializeTaskFrontmatter",
      "updateTaskNote",
      "readTaskForEdit",
      "completeTask",
    ]) {
      expect(entry).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(entry).not.toMatch(/vault-write/);
  });

  it("imports no Obsidian runtime value in the conflict-safe primitive, the serializer or anything under tasks/", () => {
    const files = [
      join(SRC, "conflict-safe.ts"),
      join(SRC, "frontmatter-serializer.ts"),
      ...readdirSync(join(SRC, "tasks"))
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
        .map((name) => join(SRC, "tasks", name)),
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(importsObsidianValue(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});

describe("codex-1: an edit never writes what the readers reject", () => {
  it("refuses a completion that would push a valid note over the whole-file limit", async () => {
    const base = OPEN_NOTE.slice(0, OPEN_NOTE.length - 1);
    const full = `${base}${"x".repeat(TASK_FILE_MAX_BYTES - Buffer.byteLength(base) - 1)}\n`;
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(TASK_FILE_MAX_BYTES);
    expect(parseTaskContent(full).kind).toBe("ok");
    const { vault, file } = setup(full);
    const result = await updateTaskNote(vault, file, full, {
      now: NOW,
      changes: { status: "done", completed: NOW },
    });
    expect(result.kind).toBe("invalid");
    expect(vault.read(TASK_PATH)).toBe(full);
    expect(vault.processCallCount).toBe(0);
  });

  it("refuses an edit whose alias-expanded passthrough would exceed the frontmatter limit", async () => {
    const refs = Array.from({ length: 150 }, () => "  - *a").join("\n");
    const note = OPEN_NOTE.replace(
      "zeta: 1\n",
      `zeta: 1\nbase: &a "${"y".repeat(500)}"\nrefs:\n${refs}\n`,
    );
    expect(parseTaskContent(note).kind).toBe("ok");
    const { vault, file } = setup(note);
    const result = await updateTaskNote(vault, file, note, {
      now: NOW,
      changes: { status: "done" },
    });
    expect(result.kind).toBe("invalid");
    expect(vault.read(TASK_PATH)).toBe(note);
  });

  it("every applied edit over the hostile corpus re-parses with the reader", async () => {
    for (const title of VALID_HOSTILE_TASK_TITLES) {
      const { vault, file } = setup();
      const result = await updateTaskNote(vault, file, OPEN_NOTE, { now: NOW, changes: { title } });
      if (result.kind === "applied") expect(parseTaskContent(result.content).kind).toBe("ok");
    }
  });
});

describe("closing delimiter parity with the service reader", () => {
  it("accepts a closing delimiter at end of file with no trailing newline", () => {
    const eof = `${OPEN_NOTE.slice(0, OPEN_NOTE.indexOf("\n---\n"))}\n---`;
    const parsed = parseTaskContent(eof);
    expect(parsed.kind).toBe("ok");
  });

  it("leaves CRLF notes unreadable with the refused-delimiter code", () => {
    const parsed = parseTaskContent(OPEN_NOTE.replace(/\n/g, "\r\n"));
    expect(parsed).toMatchObject({ kind: "unreadable", reason: "refused-delimiter" });
  });
});
