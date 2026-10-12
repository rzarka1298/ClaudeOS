import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  checkCreatedNote,
  checkStatusChangeDiff,
  classifyDuplicateAttention,
  countsMatchLists,
  duePropertyVerdict,
  emptyProjectVerdict,
  evaluateLongtasks,
  inspectUntrustedRender,
  LONGTASK_BAR_MS,
  localDateIn,
  MOVE_ALLOWANCE_MS,
  measureInteractions,
  movedWithin,
  notInEitherList,
  panelIndependent,
  TASK_PAGE_LIMIT,
  parseNoteFrontmatter,
  readDecisionOutcome,
  readerSelectors,
  redateDueLine,
  rendererClick,
  rendererInspectDue,
  rendererReadTasks,
  rendererSetInput,
  rendererVaultOp,
  shiftLocalDate,
  untrustedRenderVerdict,
} from "./tasks-support.js";

const ID = "abcdefghij0123456789klmno";

function note(
  overrides: Record<string, string | null> = {},
  title = "Weekly report draft",
): string {
  const base: Record<string, string | null> = {
    id: ID,
    scope: "global",
    stage: "capture",
    created: "2026-10-08T09:00:00.000Z",
    updated: "2026-10-08T09:00:00.000Z",
    type: "task",
    title: `"${title}"`,
    status: "inbox",
    ...overrides,
  };
  const lines = Object.entries(base)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\nbody\n`;
}

describe("parseNoteFrontmatter (Test 2)", () => {
  it("reads scalar lines into a flat map, quotes preserved, in original order", () => {
    const parsed = parseNoteFrontmatter(note({ due: "2026-10-08" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.map["id"]).toBe(ID);
    expect(parsed.map["title"]).toBe('"Weekly report draft"');
    expect(parsed.map["due"]).toBe("2026-10-08");
    expect(parsed.entries.map(([key]) => key)).toEqual([
      "id",
      "scope",
      "stage",
      "created",
      "updated",
      "type",
      "title",
      "status",
      "due",
    ]);
  });

  it("skips indented and list lines and keeps a block key with an empty value", () => {
    const text =
      "---\nid: x\ntags:\n  - a\n  - b\ndecision:\n  outcome: accepted\nstatus: ready\n---\n";
    const parsed = parseNoteFrontmatter(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map(([key]) => key)).toEqual(["id", "tags", "decision", "status"]);
    expect(parsed.map["tags"]).toBe("");
  });

  it("rejects a note without a closing delimiter and one without an opening one", () => {
    expect(parseNoteFrontmatter("---\nid: x\nstatus: ready\n")).toEqual({
      ok: false,
      reason: "unterminated",
    });
    expect(parseNoteFrontmatter("id: x\n---\n")).toEqual({ ok: false, reason: "no-opening" });
    expect(parseNoteFrontmatter("")).toEqual({ ok: false, reason: "no-opening" });
  });

  it("tolerates carriage returns at line ends", () => {
    const parsed = parseNoteFrontmatter("---\r\nid: x\r\nstatus: ready\r\n---\r\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.map["status"]).toBe("ready");
  });
});

describe("checkCreatedNote (Test 3)", () => {
  const fileName = `weekly-report-draft-${ID.slice(-8)}.md`;
  const expected = { status: "inbox", title: "Weekly report draft" } as const;

  it("accepts a well-formed created note", () => {
    expect(checkCreatedNote(note(), fileName, expected)).toEqual({ ok: true });
  });

  it("accepts the ready status when ready is expected", () => {
    expect(
      checkCreatedNote(note({ status: "ready" }), fileName, { ...expected, status: "ready" }),
    ).toEqual({ ok: true });
  });

  it("rejects a 24-character id", () => {
    const result = checkCreatedNote(note({ id: ID.slice(1) }), fileName, expected);
    expect(result).toMatchObject({ ok: false, code: "id-invalid" });
  });

  it("rejects an id with a character outside the alphabet", () => {
    const result = checkCreatedNote(note({ id: `${ID.slice(1)}A` }), fileName, expected);
    expect(result).toMatchObject({ ok: false, code: "id-invalid" });
  });

  it("rejects a wrong status", () => {
    expect(checkCreatedNote(note({ status: "ready" }), fileName, expected)).toMatchObject({
      ok: false,
      code: "status-mismatch",
    });
  });

  it("rejects a missing updated stamp", () => {
    expect(checkCreatedNote(note({ updated: null }), fileName, expected)).toMatchObject({
      ok: false,
      code: "updated-missing",
    });
  });

  it("rejects a missing created stamp and a wrong type with their own codes", () => {
    expect(checkCreatedNote(note({ created: null }), fileName, expected)).toMatchObject({
      code: "created-missing",
    });
    expect(checkCreatedNote(note({ type: "note" }), fileName, expected)).toMatchObject({
      code: "type-not-task",
    });
  });

  it("rejects a file name that does not carry the typed title", () => {
    expect(checkCreatedNote(note(), "something-else-12345678.md", expected)).toMatchObject({
      ok: false,
      code: "title-not-in-file-name",
    });
  });

  it("rejects text that is not a note at all", () => {
    expect(checkCreatedNote("no frontmatter", fileName, expected)).toMatchObject({
      ok: false,
      code: "not-a-note",
    });
  });

  it("uses distinct codes for the four named failures", () => {
    const codes = [
      checkCreatedNote(note({ id: ID.slice(1) }), fileName, expected),
      checkCreatedNote(note({ status: "ready" }), fileName, expected),
      checkCreatedNote(note({ updated: null }), fileName, expected),
      checkCreatedNote(note(), "other-12345678.md", expected),
    ].map((result) => (result.ok ? "ok" : result.code));
    expect(new Set(codes).size).toBe(4);
  });
});

describe("renderer functions are self-contained (wdio serialises them with toString)", () => {
  const emptyDocument = { querySelector: () => null, querySelectorAll: () => [] };

  function inFreshRealm(fn: (...args: never[]) => unknown, ...args: unknown[]): unknown {
    const source = fn.toString();
    expect(source).not.toContain("__name(");
    return runInNewContext(`(${source})(null, ...args)`, { document: emptyDocument, args });
  }

  it("rendererClick finds nothing in an empty document and reports false", () => {
    expect(inFreshRealm(rendererClick, "button", "Confirm")).toBe(false);
  });

  it("rendererSetInput reports false when the form is absent", () => {
    expect(inFreshRealm(rendererSetInput, "form", "Title", "x")).toBe(false);
  });

  it("rendererReadTasks reports an unmounted surface for a missing root", () => {
    const result = inFreshRealm(rendererReadTasks, "section.none", readerSelectors()) as {
      mounted: boolean;
      rows: unknown[];
    };
    expect(result.mounted).toBe(false);
    expect(result.rows).toEqual([]);
  });
});

describe("checkStatusChangeDiff (Test 2, the raw diff of a Mark done)", () => {
  const before = [
    "---",
    "id: abcdefghij0123456789klmno",
    "updated: 2026-10-08T08:00:00.000Z",
    "type: task",
    'title: "Live check properties style date"',
    "status: ready",
    "due: 2026-10-08",
    "tags: []",
    "---",
    "Synthetic live-check task.",
    "",
  ].join("\n");

  function edited(edit: (lines: string[]) => string[]): string {
    return edit(before.split("\n")).join("\n");
  }

  function moved(line: string, status: string): string {
    if (line.startsWith("updated:")) return "updated: 2026-10-08T09:00:00.000Z";
    return line === "status: ready" ? `status: ${status}` : line;
  }

  const doneAfter = edited((lines) =>
    lines
      .map((line) => moved(line, "done"))
      .flatMap((line) =>
        line.startsWith("due:") ? [line, "completed: 2026-10-08T09:00:00.000Z"] : [line],
      ),
  );

  it("accepts a diff of only status, updated and completed with the due line untouched", () => {
    expect(checkStatusChangeDiff(before, doneAfter, { expectStatus: "done" })).toEqual({
      ok: true,
    });
  });

  it("accepts a cancel that adds no completed line", () => {
    const cancelled = edited((lines) => lines.map((line) => moved(line, "cancelled")));
    expect(checkStatusChangeDiff(before, cancelled, { expectStatus: "cancelled" })).toEqual({
      ok: true,
    });
  });

  it("rejects a changed due line", () => {
    const text = doneAfter.replace("due: 2026-10-08", "due: 2026-10-09");
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "due-changed",
    });
  });

  it("rejects a due line the writer quoted", () => {
    const text = doneAfter.replace("due: 2026-10-08", 'due: "2026-10-08"');
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "due-quoted",
    });
  });

  it("rejects an extra changed key", () => {
    const text = doneAfter.replace('title: "Live check properties style date"', 'title: "Other"');
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "extra-change",
    });
  });

  it("rejects a changed body", () => {
    const text = doneAfter.replace("Synthetic live-check task.", "Edited.");
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "extra-change",
    });
  });

  it("rejects a missing completed line when done is expected", () => {
    const text = doneAfter
      .split("\n")
      .filter((line) => !line.startsWith("completed:"))
      .join("\n");
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "completed-missing",
    });
  });

  it("rejects an unchanged status", () => {
    expect(checkStatusChangeDiff(before, before, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "status-unchanged",
    });
  });

  it("rejects a status other than the expected one", () => {
    expect(checkStatusChangeDiff(before, doneAfter, { expectStatus: "cancelled" })).toMatchObject({
      ok: false,
      code: "status-wrong",
    });
  });

  it("rejects an updated stamp that did not move", () => {
    const text = doneAfter.replace(
      "updated: 2026-10-08T09:00:00.000Z",
      "updated: 2026-10-08T08:00:00.000Z",
    );
    expect(checkStatusChangeDiff(before, text, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "updated-unchanged",
    });
  });

  it("rejects a note that has no due line before the change", () => {
    const noDue = before.replace("due: 2026-10-08\n", "");
    expect(checkStatusChangeDiff(noDue, doneAfter, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "due-missing",
    });
  });

  it("rejects text that is not a note", () => {
    expect(checkStatusChangeDiff("x", doneAfter, { expectStatus: "done" })).toMatchObject({
      ok: false,
      code: "not-a-note",
    });
  });
});

describe("readDecisionOutcome and redateDueLine", () => {
  it("reads the outcome of the nested decision map", () => {
    const text =
      "---\nstatus: ready\ndecision:\n  outcome: accepted\n  at: 2026-10-08T09:00:00.000Z\n---\n";
    expect(readDecisionOutcome(text)).toBe("accepted");
    expect(readDecisionOutcome(text.replace("accepted", "dismissed"))).toBe("dismissed");
  });

  it("reads null when no decision is recorded or the note is unreadable", () => {
    expect(readDecisionOutcome("---\nstatus: ready\n---\n")).toBeNull();
    expect(readDecisionOutcome("nothing")).toBeNull();
    expect(readDecisionOutcome("---\ndecision:\n  outcome: maybe\n---\n")).toBeNull();
  });

  it("re-dates the due line unquoted and leaves every other line alone", () => {
    const text = "---\nstatus: ready\ndue: 2026-10-08\ntags: []\n---\nbody\n";
    expect(redateDueLine(text, "2026-10-11")).toBe(
      "---\nstatus: ready\ndue: 2026-10-11\ntags: []\n---\nbody\n",
    );
  });

  it("refuses a note with no due line and a date that is not a date", () => {
    expect(() => redateDueLine("---\nstatus: ready\n---\n", "2026-10-11")).toThrow();
    expect(() => redateDueLine("---\ndue: 2026-10-08\n---\n", "tomorrow")).toThrow();
  });
});

describe("local dates", () => {
  it("formats a date in a named zone", () => {
    const ms = Date.parse("2026-10-11T23:30:00Z");
    expect(localDateIn("UTC", ms)).toBe("2026-10-11");
    expect(localDateIn("Pacific/Auckland", ms)).toBe("2026-10-12");
  });

  it("shifts a date across month and year ends", () => {
    expect(shiftLocalDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftLocalDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftLocalDate("2026-10-11", 0)).toBe("2026-10-11");
  });
});

describe("duplicate classification (Test 3)", () => {
  it("is true only when the original and the copy both sit under attention and in no list", () => {
    expect(
      classifyDuplicateAttention(["Plan roadmap", "Plan roadmap", "Other"], "Plan roadmap"),
    ).toBe(true);
  });

  it("is false when only one of the two is under attention", () => {
    expect(classifyDuplicateAttention(["Plan roadmap", "Other"], "Plan roadmap")).toBe(false);
  });

  it("is false when neither is under attention", () => {
    expect(classifyDuplicateAttention([], "Plan roadmap")).toBe(false);
  });

  it("is false when the task still appears in a list", () => {
    expect(
      classifyDuplicateAttention(["Plan roadmap", "Plan roadmap"], "Plan roadmap", [
        "Plan roadmap",
      ]),
    ).toBe(false);
  });

  it("confirms the original left Today and Upcoming while both are held back", () => {
    expect(notInEitherList(["A"], ["B"], "Plan roadmap")).toBe(true);
    expect(notInEitherList(["Plan roadmap"], [], "Plan roadmap")).toBe(false);
    expect(notInEitherList([], ["Plan roadmap"], "Plan roadmap")).toBe(false);
  });
});

describe("untrusted text rendering (Test 4)", () => {
  it("accepts zero scripts, zero such anchors and at least one text element", () => {
    expect(untrustedRenderVerdict({ scripts: 0, anchors: 0, titleElements: 1 })).toEqual({
      ok: true,
    });
  });

  it("rejects a script element, a clickable synthetic link and a missing text element", () => {
    expect(untrustedRenderVerdict({ scripts: 1, anchors: 0, titleElements: 1 })).toMatchObject({
      ok: false,
      code: "script-created",
    });
    expect(untrustedRenderVerdict({ scripts: 0, anchors: 1, titleElements: 1 })).toMatchObject({
      ok: false,
      code: "link-clickable",
    });
    expect(untrustedRenderVerdict({ scripts: 0, anchors: 0, titleElements: 0 })).toMatchObject({
      ok: false,
      code: "text-not-shown",
    });
  });

  it("can require the source link text to be on screen as text", () => {
    const counts = { scripts: 0, anchors: 0, titleElements: 1, linkTextElements: 0 };
    expect(untrustedRenderVerdict(counts, { requireLinkText: true })).toMatchObject({
      ok: false,
      code: "link-text-not-shown",
    });
    expect(
      untrustedRenderVerdict({ ...counts, linkTextElements: 2 }, { requireLinkText: true }),
    ).toEqual({ ok: true });
  });

  it("counts scripts, anchors to the synthetic host and exact-text elements in a rendered tree", () => {
    const element = (text: string, href?: string): object => ({
      textContent: text,
      getAttribute: (name: string) => (name === "href" ? (href ?? null) : null),
    });
    const tree: Record<string, object[]> = {
      script: [],
      "a[href]": [element("see", "https://example.invalid/synthetic-source")],
      "*": [
        element("yes"),
        element("yes"),
        element("see https://example.invalid/synthetic-source and more"),
      ],
    };
    const root = { querySelectorAll: (selector: string) => tree[selector] ?? [] };
    const document = { querySelector: () => root };
    const source = inspectUntrustedRender.toString();
    expect(source).not.toContain("__name(");
    const counts = runInNewContext(
      `(${source})(null, "root", "yes", "https://example.invalid/synthetic-source")`,
      { document },
    );
    expect(counts).toEqual({ scripts: 0, anchors: 1, titleElements: 2, linkTextElements: 1 });
  });
});

describe("the Properties view check and the vault operation (U-6, U-7)", () => {
  it("accepts a date input holding a plain date", () => {
    expect(duePropertyVerdict({ found: true, inputType: "date", value: "2026-10-12" })).toEqual({
      ok: true,
    });
  });

  it("rejects a missing property, a text input and a value with a time", () => {
    expect(duePropertyVerdict({ found: false, inputType: null, value: null })).toMatchObject({
      code: "property-missing",
    });
    expect(
      duePropertyVerdict({ found: true, inputType: "text", value: "2026-10-12" }),
    ).toMatchObject({ code: "not-a-date-input" });
    expect(
      duePropertyVerdict({ found: true, inputType: "date", value: "2026-10-12T09:00" }),
    ).toMatchObject({ code: "has-time" });
  });

  it("the renderer functions are self-contained and tolerate an empty document", async () => {
    const empty = { querySelector: () => null, querySelectorAll: () => [] };
    const due = runInNewContext(`(${rendererInspectDue.toString()})(null)`, { document: empty });
    expect(due).toEqual({ found: false, inputType: null, value: null });
    const calls: string[] = [];
    const ctx = {
      app: {
        vault: {
          getAbstractFileByPath: (path: string) => (path === "a.md" ? { path } : null),
          copy: async (_file: unknown, target: string) => void calls.push(`copy ${target}`),
          delete: async () => void calls.push("delete"),
        },
      },
    };
    const source = rendererVaultOp.toString();
    expect(source).not.toContain("__name(");
    const run = runInNewContext(`(${source})`, {}) as typeof rendererVaultOp;
    expect(await run(ctx, "copy", "a.md", "a 1.md")).toBe("ok");
    expect(await run(ctx, "delete", "a.md", "")).toBe("ok");
    expect(await run(ctx, "delete", "missing.md", "")).toBe("missing");
    expect(calls).toEqual(["copy a 1.md", "delete"]);
  });
});

const VIEWS = ["all", "today", "upcoming", "overdue", "project", "proposed", "blocked", "completed"];

function chipsOf(counts: number[]): Record<string, number> {
  return Object.fromEntries(VIEWS.map((view, index) => [view, counts[index] ?? 0]));
}

describe("countsMatchLists (Task 3 Test 2)", () => {
  it("is ok when each rendered list has the length its chip names", () => {
    const counts = chipsOf([30, 3, 4, 1, 0, 2, 5, 6]);
    const lists = chipsOf([TASK_PAGE_LIMIT, 3, 4, 1, 0, 2, 5, 6]);
    expect(countsMatchLists(counts, lists)).toEqual({ ok: true });
  });

  it("tolerates the paging limit and nothing beyond it", () => {
    expect(TASK_PAGE_LIMIT).toBe(25);
    expect(countsMatchLists(chipsOf([300]), chipsOf([25]))).toEqual({ ok: true });
    expect(countsMatchLists(chipsOf([300]), chipsOf([26]))).toMatchObject({
      ok: false,
      view: "all",
    });
  });

  it("names the view that mismatches", () => {
    const counts = chipsOf([3, 3, 4, 1, 0, 2, 5, 6]);
    const lists = chipsOf([3, 3, 3, 1, 0, 2, 5, 6]);
    expect(countsMatchLists(counts, lists)).toEqual({ ok: false, view: "upcoming" });
  });

  it("fails a view that has no count or no list", () => {
    expect(countsMatchLists({ all: null }, { all: 0 })).toMatchObject({ ok: false, view: "all" });
    expect(countsMatchLists({ all: 1 }, {})).toMatchObject({ ok: false, view: "all" });
  });
});

describe("movedWithin (Task 3 Test 3)", () => {
  const before = chipsOf([10, 2, 3, 1]);

  it("is true when exactly the expected chips moved by the expected amounts in time", () => {
    const after = { ...before, today: 1, overdue: 2 };
    expect(MOVE_ALLOWANCE_MS).toBe(2000);
    expect(movedWithin(before, after, { today: -1, overdue: 1 }, 1500, MOVE_ALLOWANCE_MS)).toBe(
      true,
    );
  });

  it("is false when it took too long, a chip moved by another amount or an extra chip moved", () => {
    const after = { ...before, today: 1, overdue: 2 };
    expect(movedWithin(before, after, { today: -1, overdue: 1 }, 2500, MOVE_ALLOWANCE_MS)).toBe(
      false,
    );
    expect(movedWithin(before, after, { today: -1, overdue: 2 }, 100, MOVE_ALLOWANCE_MS)).toBe(
      false,
    );
    expect(
      movedWithin(before, { ...after, all: 11 }, { today: -1, overdue: 1 }, 100, MOVE_ALLOWANCE_MS),
    ).toBe(false);
    expect(movedWithin(before, before, { today: -1 }, 100, MOVE_ALLOWANCE_MS)).toBe(false);
  });
});

describe("long tasks and interaction timings (Task 3 Test 4, T-05.2-28)", () => {
  it("passes a supported observer whose longest entry is at or under the bar", () => {
    expect(LONGTASK_BAR_MS).toBe(300);
    const entries = [
      { startTime: 1, duration: 120 },
      { startTime: 9, duration: 300 },
    ];
    expect(evaluateLongtasks({ supported: true, entries }, LONGTASK_BAR_MS)).toEqual({
      verdict: "pass",
    });
    expect(evaluateLongtasks({ supported: true, entries: [] }, LONGTASK_BAR_MS)).toEqual({
      verdict: "pass",
    });
  });

  it("fails an entry over the bar and reports the longest", () => {
    const entries = [
      { startTime: 1, duration: 120 },
      { startTime: 9, duration: 301 },
    ];
    expect(evaluateLongtasks({ supported: true, entries }, LONGTASK_BAR_MS)).toEqual({
      verdict: "fail",
      longestMs: 301,
    });
  });

  it("is inconclusive, never a pass, when the observer is unsupported", () => {
    const result = evaluateLongtasks({ supported: false, entries: [] }, LONGTASK_BAR_MS);
    expect(result.verdict).toBe("inconclusive");
    expect(result).toHaveProperty("reason");
    expect(
      evaluateLongtasks({ supported: false, entries: [{ startTime: 0, duration: 1 }] }, 300).verdict,
    ).toBe("inconclusive");
  });

  it("fails when any interaction is over the bar and names the slowest", () => {
    const ok = [
      { label: "chip today", ms: 80 },
      { label: "scroll", ms: 300 },
    ];
    expect(measureInteractions(ok, LONGTASK_BAR_MS)).toEqual({ ok: true, slowest: "scroll" });
    expect(
      measureInteractions([...ok, { label: "create a task", ms: 450 }], LONGTASK_BAR_MS),
    ).toEqual({ ok: false, slowest: "create a task", slowestMs: 450 });
  });

  it("fails an empty set of timings: nothing measured is not a pass", () => {
    expect(measureInteractions([], LONGTASK_BAR_MS)).toMatchObject({ ok: false });
  });
});

describe("panel independence (Task 3 Test 5)", () => {
  const snap = (active: string, counts: Record<string, number>) => ({ active, counts });
  const same = snap("all", { all: 2, today: 1 });

  it("is true when the global side changed and the panel stayed the same", () => {
    expect(
      panelIndependent(snap("today", { all: 5 }), snap("overdue", { all: 5 }), same, same),
    ).toBe(true);
  });

  it("is true for the reverse call with the roles swapped", () => {
    expect(
      panelIndependent(same, same, snap("all", { all: 2 }), snap("overdue", { all: 2 })),
    ).toBe(false);
    expect(
      panelIndependent(snap("all", { all: 2 }), snap("overdue", { all: 2 }), same, same),
    ).toBe(true);
  });

  it("is false when the panel moved with the global change or nothing changed at all", () => {
    expect(
      panelIndependent(
        snap("today", { all: 5 }),
        snap("overdue", { all: 5 }),
        same,
        snap("all", { all: 9, today: 1 }),
      ),
    ).toBe(false);
    expect(panelIndependent(same, same, same, same)).toBe(false);
  });

  it("an empty project shows its own empty line, not the global list", () => {
    expect(
      emptyProjectVerdict({ panelRowIds: [], globalRowIds: ["a", "b"], emptyHeading: "Nothing here yet" }),
    ).toEqual({ ok: true });
    expect(
      emptyProjectVerdict({ panelRowIds: ["a"], globalRowIds: ["a", "b"], emptyHeading: null }),
    ).toMatchObject({ ok: false });
    expect(
      emptyProjectVerdict({ panelRowIds: [], globalRowIds: ["a"], emptyHeading: null }),
    ).toMatchObject({ ok: false });
  });
});
