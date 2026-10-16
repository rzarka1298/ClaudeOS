import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId, RESEARCH_STAGES } from "@ccc/domain";
import { inlineCode, parseNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunNoteInput, renderRunNote, runNotePathFor, writeRunNote } from "./run-note.js";

const BASE = join(homedir(), ".ccc-test");
const T0 = "2026-10-15T08:00:00.000Z";
const NOTE_A = "n".repeat(26);

let vaultRoot: string;
beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(BASE, "rn-"));
  mkdirSync(join(vaultRoot, "automation-runs"), { recursive: true });
});
afterEach(() => rmSync(vaultRoot, { recursive: true, force: true }));

function input(overrides: Partial<RunNoteInput> = {}): RunNoteInput {
  return {
    runId: newRunId(),
    startedAt: T0,
    endedAt: "2026-10-15T08:01:00.000Z",
    outcome: "success",
    errorCode: null,
    stages: RESEARCH_STAGES.map((stage, index) => ({
      stage,
      at: `2026-10-15T08:00:0${index}.000Z`,
      noteIds: stage === "raw" ? [NOTE_A, "m".repeat(26)] : [],
    })),
    sources: [
      { label: "Node.js releases", contributed: true, code: null },
      { label: "Rust blog", contributed: false, code: "timeout" },
    ],
    reportPath: "global/output/research-2026-10-15-abc.md",
    ...overrides,
  };
}

describe("Test 2 (trace): the run note lists every stage with its instant and the note ids it produced", () => {
  it("lists the six stages in order with ISO timestamps and note ids", () => {
    const body = renderRunNote(input());
    let last = -1;
    for (const stage of RESEARCH_STAGES) {
      const at = body.indexOf(inlineCode(stage));
      expect(at, stage).toBeGreaterThan(last);
      last = at;
    }
    expect(body).toContain("2026-10-15T08:00:01.000Z");
    expect(body).toContain(NOTE_A);
    expect(body).toContain("Outcome: Success");
  });

  it("names the error code and the outcome word of a failed run", () => {
    const body = renderRunNote(
      input({ outcome: "failure", errorCode: "summariser-failed", reportPath: null }),
    );
    expect(body).toContain("Outcome: Failure");
    expect(body).toContain(inlineCode("summariser-failed"));
  });

  it("says Running with no end instant while a run is in flight", () => {
    const body = renderRunNote(input({ outcome: null, endedAt: null, stages: [] }));
    expect(body).toContain("Outcome: Running");
    expect(body).not.toContain("Ended:");
  });
});

describe("Test 5 (run note template): only engine text, codes, ids, instants and escaped owner labels", () => {
  it("escapes an owner label that holds Markdown and an address", () => {
    const label = "Evil [x](https://e.invalid/p) ![i](https://b.invalid/p.png) [[Private]] <b>";
    const body = renderRunNote(
      input({ sources: [{ label, contributed: false, code: "parse-failure" }] }),
    );
    expect(body).not.toContain("](https");
    expect(body).not.toContain("![");
    expect(body).not.toContain("[[");
    expect(body).not.toContain("<b>");
    expect(body).toContain("\\[x\\]");
  });

  it("marks an unavailable source with its closed code only", () => {
    const body = renderRunNote(input());
    expect(body).toContain("Rust blog");
    expect(body).toContain(inlineCode("timeout"));
  });
});

describe("writeRunNote", () => {
  it("writes automation-runs/<run id>.md and rewrites it in place keeping the id and created stamp", () => {
    const runId = newRunId();
    const first = writeRunNote({
      vaultRoot,
      input: input({ runId, outcome: null, endedAt: null, stages: [] }),
    });
    expect(first.path).toBe(runNotePathFor(runId));
    expect(first.path).toBe(`automation-runs/${runId}.md`);
    const second = writeRunNote({ vaultRoot, input: input({ runId }), prior: first });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(first.created);
    const parsed = parseNote(readFileSync(join(vaultRoot, second.path), "utf8"));
    expect(parsed.frontmatter.generatedBy.automation).toBe("research.daily-tech");
    expect(parsed.frontmatter.generatedBy.runId).toBe(runId);
    expect(parsed.frontmatter.aiGenerated).toBe(false);
    expect(parsed.body).toContain("Outcome: Success");
  });

  it("refuses a run id that is not a run id before touching the disk", () => {
    expect(() => runNotePathFor("../escape")).toThrow(RangeError);
    expect(() => writeRunNote({ vaultRoot, input: input({ runId: "../escape" }) })).toThrow(
      RangeError,
    );
  });
});
