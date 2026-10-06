// The canonical task frontmatter contract (plan 06-05 task 1; D-29, D-30, D-36,
// ADR-0020, research Pattern 11 and spike S1). The schema, the key-order array
// and these tests move together: a key added to one and not the others fails here.
import { describe, expect, it } from "vitest";
import { NOTE_FRONTMATTER_KEY_ORDER } from "./note-schema.js";
import {
  isOpenTaskStatus,
  TASK_DECISION_KEY_ORDER,
  TASK_FILE_MAX_BYTES,
  TASK_FRONTMATTER_KEY_ORDER,
  TASK_FRONTMATTER_MAX_BYTES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASKS_FOLDER_NAME,
  TaskDateSchema,
  TaskDecisionSchema,
  TaskFrontmatterSchema,
  TaskTitleSchema,
} from "./task-schema.js";
import {
  HOSTILE_TASK_TITLES,
  VALID_HOSTILE_TASK_TITLES,
  YAML_NOTE_VARIANTS,
} from "./task-corpus.js";

const ID_A = "abcdefghi0123456789abcdef";
const ID_B = "zyxwvutsr9876543210fedcba";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID_A,
    scope: "global",
    stage: "capture",
    created: "2026-10-05T12:00:00Z",
    updated: "2026-10-05T12:00:00Z",
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
    type: "task",
    title: "Draft the weekly review",
    status: "inbox",
    ...overrides,
  };
}

function parses(overrides: Record<string, unknown> = {}): boolean {
  return TaskFrontmatterSchema.safeParse(base(overrides)).success;
}

/** Every bidi override, isolate and mark, written as a code point so no raw character is in this file. */
const BIDI_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

describe("Test 1 (shape)", () => {
  it("parses a fully populated task", () => {
    const result = TaskFrontmatterSchema.safeParse(
      base({
        priority: "high",
        due: "2026-10-09",
        scheduled: "2026-10-08T09:30:00-04:00",
        completed: "2026-10-10T10:00:00Z",
        projectId: "abcdefghi0123456789abcdef".slice(0, 9) + "0123456789abcdef",
        assignee: "automation",
        sourceType: "email",
        sourceLink: "message-id-in-plain-text",
        parent: ID_B,
        dependencies: [ID_B],
        tags: ["work", "q4/review"],
        decision: { outcome: "accepted", at: "2026-10-05T13:00:00Z" },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("parses the required fields alone and defaults the lists and the source type", () => {
    const result = TaskFrontmatterSchema.parse(base());
    expect(result.dependencies).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.sourceType).toBe("manual");
    expect(result.priority).toBeUndefined();
  });

  it("requires type task and stage capture", () => {
    expect(parses({ type: "note" })).toBe(false);
    expect(parses({ type: undefined })).toBe(false);
    expect(parses({ stage: "wiki" })).toBe(false);
    expect(parses({ stage: "capture" })).toBe(true);
  });

  it("extends the note schema without forking it (the provenance keys still validate)", () => {
    expect(parses({ id: "NOT-AN-ID" })).toBe(false);
    expect(parses({ scope: "elsewhere" })).toBe(false);
    expect(parses({ confidence: "certain" })).toBe(false);
  });

  it("limits sourceType and sourceLink and keeps both single line", () => {
    expect(parses({ sourceType: "x".repeat(33) })).toBe(false);
    expect(parses({ sourceType: "" })).toBe(false);
    expect(parses({ sourceLink: "x".repeat(2049) })).toBe(false);
    expect(parses({ sourceLink: "x".repeat(2048) })).toBe(true);
    expect(parses({ sourceLink: "line one\nline two" })).toBe(false);
    expect(parses({ assignee: "someone-else" })).toBe(false);
  });
});

describe("Test 2 (status and priority)", () => {
  it("has exactly the seven statuses and four priorities", () => {
    expect([...TASK_STATUSES]).toEqual([
      "inbox",
      "proposed",
      "ready",
      "in-progress",
      "blocked",
      "done",
      "cancelled",
    ]);
    expect([...TASK_PRIORITIES]).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("accepts each status and priority and rejects anything else", () => {
    for (const status of TASK_STATUSES) expect(parses({ status })).toBe(true);
    for (const priority of TASK_PRIORITIES) expect(parses({ priority })).toBe(true);
    expect(parses({ status: "waiting" })).toBe(false);
    expect(parses({ status: "Done" })).toBe(false);
    expect(parses({ priority: "none" })).toBe(false);
    expect(parses({ priority: "critical" })).toBe(false);
  });

  it("treats done, cancelled and proposed as not open (research Pattern 12)", () => {
    expect(TASK_STATUSES.filter((status) => isOpenTaskStatus(status))).toEqual([
      "inbox",
      "ready",
      "in-progress",
      "blocked",
    ]);
  });
});

describe("Test 3 (title)", () => {
  it("rejects an empty title, a blank title and a 201-character title", () => {
    expect(parses({ title: "" })).toBe(false);
    expect(parses({ title: "   " })).toBe(false);
    expect(parses({ title: "x".repeat(201) })).toBe(false);
    expect(parses({ title: "x".repeat(200) })).toBe(true);
  });

  it("rejects a control, line-separator or paragraph-separator character", () => {
    for (const cp of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x2028, 0x2029]) {
      expect(parses({ title: `a${String.fromCodePoint(cp)}b` }), `U+${cp.toString(16)}`).toBe(false);
    }
  });

  it("rejects every bidi control and every zero-width or soft-hyphen format character", () => {
    for (const cp of [...BIDI_CODE_POINTS, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]) {
      expect(parses({ title: `a${String.fromCodePoint(cp)}b` }), `U+${cp.toString(16)}`).toBe(false);
    }
  });

  it("accepts ordinary international text", () => {
    for (const title of ["Review the budget", "Buy caf\u00e9 beans", "Prepare slides", "Plan the trip"]) {
      expect(TaskTitleSchema.safeParse(title).success, title).toBe(true);
    }
  });
});

describe("Test 4 (dates)", () => {
  it("accepts a calendar date or an offset instant for due and scheduled", () => {
    for (const value of [
      "2026-10-09",
      "2026-10-09T15:00:00Z",
      "2026-10-09T15:00:00-04:00",
      "2026-10-09T15:00:00.250+05:30",
    ]) {
      expect(parses({ due: value }), value).toBe(true);
      expect(parses({ scheduled: value }), value).toBe(true);
      expect(TaskDateSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it("rejects an offset-less datetime and a nonsense string", () => {
    for (const value of ["2026-10-09T15:00:00", "2026-10-09 15:00:00", "next friday", "2026-02-30", "", "15:00"]) {
      expect(parses({ due: value }), value).toBe(false);
      expect(parses({ scheduled: value }), value).toBe(false);
    }
  });

  it("accepts only an offset instant for completed", () => {
    expect(parses({ completed: "2026-10-10T10:00:00Z" })).toBe(true);
    expect(parses({ completed: "2026-10-10T10:00:00+01:00" })).toBe(true);
    expect(parses({ completed: "2026-10-10" })).toBe(false);
    expect(parses({ completed: "2026-10-10T10:00:00" })).toBe(false);
  });

  it("never confuses the two forms: a date stays a date and an instant stays an instant", () => {
    const parsed = TaskFrontmatterSchema.parse(base({ due: "2026-10-09", scheduled: "2026-10-09T15:00:00Z" }));
    expect(parsed.due).toBe("2026-10-09");
    expect(parsed.scheduled).toBe("2026-10-09T15:00:00Z");
  });
});

describe("Test 5 (relations and tags)", () => {
  it("requires note ids for parent and every dependency", () => {
    expect(parses({ parent: ID_B })).toBe(true);
    expect(parses({ parent: "short" })).toBe(false);
    expect(parses({ parent: ID_B.toUpperCase() })).toBe(false);
    expect(parses({ dependencies: [ID_B, ID_A] })).toBe(true);
    expect(parses({ dependencies: [ID_B, "../etc"] })).toBe(false);
  });

  it("limits dependencies to 50", () => {
    expect(parses({ dependencies: Array.from({ length: 50 }, () => ID_B) })).toBe(true);
    expect(parses({ dependencies: Array.from({ length: 51 }, () => ID_B) })).toBe(false);
  });

  it("follows Obsidian's tag rules", () => {
    for (const tag of ["work", "Work_2", "q4-review", "projects/alpha/beta", "2026-q1", "caf\u00e9"]) {
      expect(parses({ tags: [tag] }), tag).toBe(true);
    }
    for (const tag of ["has space", "1984", "#hash", "a,b", "", "x".repeat(65), "tab\tin", "emoji\u{1F600}"]) {
      expect(parses({ tags: [tag] }), tag).toBe(false);
    }
    expect(parses({ tags: ["x".repeat(64)] })).toBe(true);
  });

  it("limits tags to 20", () => {
    expect(parses({ tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) })).toBe(true);
    expect(parses({ tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) })).toBe(false);
  });
});

describe("Test 6 (decision)", () => {
  it("is optional and top level", () => {
    expect(parses()).toBe(true);
    expect(parses({ decision: { outcome: "dismissed", at: "2026-10-05T13:00:00Z" } })).toBe(true);
  });

  it("carries an outcome of accepted or dismissed plus an instant", () => {
    expect(TaskDecisionSchema.safeParse({ outcome: "accepted", at: "2026-10-05T13:00:00Z" }).success).toBe(true);
    expect(TaskDecisionSchema.safeParse({ outcome: "approved", at: "2026-10-05T13:00:00Z" }).success).toBe(false);
    expect(TaskDecisionSchema.safeParse({ outcome: "accepted", at: "yesterday" }).success).toBe(false);
    expect(TaskDecisionSchema.safeParse({ outcome: "accepted" }).success).toBe(false);
  });

  it("is strict: an extra key is rejected", () => {
    expect(
      TaskDecisionSchema.safeParse({ outcome: "accepted", at: "2026-10-05T13:00:00Z", by: "me" }).success,
    ).toBe(false);
    expect(parses({ decision: { outcome: "accepted", at: "2026-10-05T13:00:00Z", extra: 1 } })).toBe(false);
  });
});

describe("Test 7 (key order)", () => {
  it("begins with the twelve provenance keys, in order", () => {
    expect(NOTE_FRONTMATTER_KEY_ORDER).toHaveLength(12);
    expect(TASK_FRONTMATTER_KEY_ORDER.slice(0, 12)).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
  });

  it("lists the task keys after the provenance prefix with decision last", () => {
    expect(TASK_FRONTMATTER_KEY_ORDER.slice(12)).toEqual([
      "type",
      "title",
      "status",
      "priority",
      "due",
      "scheduled",
      "completed",
      "projectId",
      "assignee",
      "sourceType",
      "sourceLink",
      "parent",
      "dependencies",
      "tags",
      "decision",
    ]);
    expect(TASK_FRONTMATTER_KEY_ORDER[TASK_FRONTMATTER_KEY_ORDER.length - 1]).toBe("decision");
  });

  it("matches the schema's keys exactly, each once", () => {
    const schemaKeys = Object.keys(TaskFrontmatterSchema.shape).sort();
    expect([...TASK_FRONTMATTER_KEY_ORDER].sort()).toEqual(schemaKeys);
    expect(new Set(TASK_FRONTMATTER_KEY_ORDER).size).toBe(TASK_FRONTMATTER_KEY_ORDER.length);
  });

  it("gives the decision map its own two-key order, outcome then at", () => {
    expect([...TASK_DECISION_KEY_ORDER]).toEqual(["outcome", "at"]);
    expect(Object.keys(TaskDecisionSchema.shape).sort()).toEqual([...TASK_DECISION_KEY_ORDER].sort());
  });

  it("names the tasks folder", () => {
    expect(TASKS_FOLDER_NAME).toBe("tasks");
  });
});

describe("Test 8 (limits)", () => {
  it("fixes the frontmatter and whole-file size limits at 64 KiB and 256 KiB", () => {
    expect(TASK_FRONTMATTER_MAX_BYTES).toBe(64 * 1024);
    expect(TASK_FILE_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("Test 9 (hostile corpus)", () => {
  it("has at least sixty entries with no duplicates", () => {
    expect(HOSTILE_TASK_TITLES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(HOSTILE_TASK_TITLES).size).toBe(HOSTILE_TASK_TITLES.length);
  });

  it("covers every hostile family the research names", () => {
    const has = (predicate: (title: string) => boolean): boolean => HOSTILE_TASK_TITLES.some(predicate);
    for (const word of ["yes", "no", "on", "off", "null", "~", "true", "false"]) {
      expect(HOSTILE_TASK_TITLES, word).toContain(word);
    }
    expect(has((t) => /^-?\d+$/.test(t)), "integer").toBe(true);
    expect(has((t) => /^0x[0-9a-f]+$/i.test(t)), "hex").toBe(true);
    expect(has((t) => /^0o?[0-7]+$/.test(t)), "octal").toBe(true);
    expect(has((t) => /^\d+:\d\d:\d\d$/.test(t)), "sexagesimal").toBe(true);
    expect(has((t) => /^\d{4}-\d\d-\d\d$/.test(t)), "date").toBe(true);
    expect(has((t) => /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(t)), "timestamp").toBe(true);
    for (const lead of ["-", "?", ":", "[", "{", "#", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]) {
      expect(has((t) => t.startsWith(lead)), `leading ${lead}`).toBe(true);
    }
    expect(has((t) => t.includes(": ")), "colon space").toBe(true);
    expect(has((t) => t.includes(" #")), "hash").toBe(true);
    expect(has((t) => t.includes("'") && t.includes('"')), "both quotes").toBe(true);
    expect(has((t) => t.startsWith("&") || t.startsWith("*")), "anchor or alias").toBe(true);
    expect(has((t) => t.startsWith("!!")), "tag").toBe(true);
    expect(HOSTILE_TASK_TITLES).toContain("---");
    expect(HOSTILE_TASK_TITLES).toContain("...");
    expect(HOSTILE_TASK_TITLES).toContain("---js");
    expect(has((t) => t.length === 300), "300 characters").toBe(true);
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(has((t) => t.includes(String.fromCodePoint(cp))), `U+${cp.toString(16)}`).toBe(true);
    }
    expect(has((t) => t.includes("\n")), "newline").toBe(true);
    expect(has((t) => t.includes("\0")), "NUL").toBe(true);
  });

  it("parses every single-line entry as a title and rejects every other entry", () => {
    for (const title of HOSTILE_TASK_TITLES) {
      const valid = VALID_HOSTILE_TASK_TITLES.includes(title);
      const result = TaskTitleSchema.safeParse(title);
      expect(result.success, JSON.stringify(title)).toBe(valid);
      if (valid) {
        // The stored value is the authored value, byte for byte: nothing is coerced.
        expect(result.data).toBe(title);
        expect(TaskFrontmatterSchema.parse(base({ title })).title).toBe(title);
      }
    }
  });

  it("keeps a substantial valid subset", () => {
    expect(VALID_HOSTILE_TASK_TITLES.length).toBeGreaterThanOrEqual(45);
    for (const title of VALID_HOSTILE_TASK_TITLES) expect(HOSTILE_TASK_TITLES).toContain(title);
  });

  it("offers Obsidian-style note variants for the vault, store, service and plugin plans", () => {
    const names = YAML_NOTE_VARIANTS.map((variant) => variant.name);
    expect(new Set(names).size).toBe(names.length);
    for (const wanted of [
      "canonical",
      "unquoted-date",
      "double-quoted-strings",
      "flow-style-tags",
      "block-style-tags",
      "missing-id",
      "duplicate-id-first",
      "duplicate-id-second",
      "unquoted-yes-title",
      "unquoted-sexagesimal-title",
      "crlf-line-endings",
    ]) {
      expect(names, wanted).toContain(wanted);
    }
    for (const variant of YAML_NOTE_VARIANTS) {
      expect(variant.text.startsWith("---"), variant.name).toBe(true);
      expect(variant.fileName, variant.name).toMatch(/^[a-z0-9-]+\.md$/);
    }
    const first = YAML_NOTE_VARIANTS.find((variant) => variant.name === "duplicate-id-first");
    const second = YAML_NOTE_VARIANTS.find((variant) => variant.name === "duplicate-id-second");
    expect(first?.id).toBeDefined();
    expect(first?.id).toBe(second?.id);
    expect(first?.fileName).not.toBe(second?.fileName);
    expect(YAML_NOTE_VARIANTS.find((variant) => variant.name === "missing-id")?.id).toBeNull();
  });

  it("holds no raw invisible or non-ASCII character in the corpus source", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "task-corpus.ts"), "utf8");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find any non-ASCII byte
    expect(source).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
  });
});
