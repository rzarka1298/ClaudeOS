import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * Plan 05.2-10 Task 2 (D-14, L-1, E2E-08, T-05.2-35): pins the one ratification rule across
 * the documents that govern acceptance, so the workflow, the compliance skill and the project
 * decisions cannot drift apart or let an automated run stand in for an owner item. The documents
 * are private planning artifacts: a public clone has no `.planning/` and these tests skip.
 */

/** The shared rule, compared after backticks are removed, whitespace is collapsed and case is folded. */
export const RATIFICATION_RULE =
  "a ratified, current automated run is the replacement for items tagged run: auto and run: auto+look, never for items tagged run: owner";

const planned = existsSync(join(REPO_ROOT, ".planning", "ROADMAP.md"));
const run = planned ? describe : describe.skip;

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/** Backticks removed, whitespace collapsed, lower case: wrapping and emphasis never break a match. */
function flat(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").toLowerCase();
}

/** The text from a heading line to the next heading of the same or a higher level. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start === -1) return "";
  const rest = text.slice(start);
  const level = /^(#+)/.exec(rest)?.[1]?.length ?? 2;
  const lines = rest.split("\n");
  const end = lines.findIndex(
    (line, index) =>
      index > 0 &&
      new RegExp(`^#{1,${level}} `).test(line) &&
      !line.startsWith("#".repeat(level + 1)),
  );
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

const E2E_IDS = Array.from({ length: 11 }, (_, i) => `E2E-${String(i + 1).padStart(2, "0")}`);

run("WORKFLOW.md (Test 1)", () => {
  const text = planned ? read(".planning/WORKFLOW.md") : "";
  const testing = flat(section(text, /^## Testing agents/m));

  it("states the rule in Testing agents and drops the unqualified old sentence", () => {
    expect(testing).toContain(RATIFICATION_RULE);
    expect(testing).toContain("replacement for items tagged");
    expect(testing).toContain("never for");
    expect(flat(text)).not.toContain("never a replacement for them");
  });

  it("says who launches the runner, how the owner can hold it, and how images are handled", () => {
    expect(testing).toContain("ratified");
    expect(testing).toContain("parent orchestrator launches the runner");
    expect(testing).toMatch(/executors never/);
    expect(testing).toMatch(/announces in one chat line/);
    expect(testing).toMatch(/owner can say hold/);
    expect(testing).toMatch(/deleted after the verdict/);
    expect(testing).toMatch(/never leave the machine/);
    expect(testing).toMatch(/phase 05\.1 onward/);
    expect(testing).toMatch(/walked entirely by the owner/);
  });

  it("limits the owner's checkpoint sitting to the owner-tagged items", () => {
    const autonomy = flat(section(text, /^## Autonomy model: phase-gated/m));
    expect(autonomy).toMatch(/walks only run: owner items/);
    expect(autonomy).toMatch(/ratified current/);
  });

  it("extends the compliance judge row with the ratified current run", () => {
    const row = flat(
      section(text, /^## Judge panel/m)
        .split("\n")
        .find((line) => line.includes("`prd-compliance-review`")) ?? "",
    );
    expect(row).toContain("ratified current run");
  });

  it("describes the automated UAT flow in the orchestrator notes", () => {
    const notes = flat(section(text, /^# Orchestrator Operating Notes/m));
    expect(notes).toContain("automated uat flow");
    expect(notes).toContain("preflight");
    expect(notes).toContain("look verdict");
    expect(notes).toContain("accept auto-results of run");
    expect(notes).toMatch(/stale/);
    expect(notes).toMatch(/never in ci/);
  });
});

run("the prd-compliance-review skill (Test 2)", () => {
  const text = planned ? read(".claude/skills/prd-compliance-review/SKILL.md") : "";
  const step5 = flat(text.slice(text.indexOf("\n5. "), text.indexOf("\n6. ")));
  const step6 = flat(text.slice(text.indexOf("\n6. "), text.indexOf("\n7. ")));

  it("step 5 names the run tags and what satisfies an automated item", () => {
    expect(step5).toContain("run: auto");
    expect(step5).toContain("run: auto+look");
    expect(step5).toContain("run: owner");
    expect(step5).toMatch(/only by a ratified, current run/);
    expect(step5).toMatch(/every item passed/);
    expect(step5).toMatch(/every look verdict recorded/);
  });

  it("step 6 refuses completion for a missing owner result and a missing ratified pass", () => {
    expect(step6).toMatch(/never (reported )?complete/);
    expect(step6).toMatch(/owner item lacks the owner's result/);
    expect(step6).toMatch(/automated item lacks a ratified current pass/);
    expect(step6).toMatch(/say which/);
  });

  it("keeps step 7 and the output file name", () => {
    expect(text).toContain("{phase}-PRD-COMPLIANCE.md");
    expect(text).toMatch(/\n7\. \*\*Output/);
  });
});

run("PROJECT.md and REQUIREMENTS.md (Test 3)", () => {
  it("has the Key Decisions row for the automated live UAT runner", () => {
    const project = read(".planning/PROJECT.md");
    const row = flat(
      project.split("\n").find((line) => flat(line).startsWith("| automated live uat runner")) ??
        "",
    );
    expect(row).not.toBe("");
    expect(row).toContain("2026-10-10");
    expect(row).toContain("l-1");
    expect(row).toContain("l-3");
    expect(row).toContain(".planning/research/automated-uat.md");
    expect(row).toContain("approved - built right after phase 05.1");
    expect(flat(project.slice(project.lastIndexOf("*Last updated")))).toContain("05.2");
  });

  it("lists E2E-01 to E2E-11 once each, with a Pending traceability row for Phase 05.2", () => {
    const requirements = read(".planning/REQUIREMENTS.md");
    expect(requirements).toMatch(/^### Automated Live UAT Runner/m);
    for (const id of E2E_IDS) {
      const lines = requirements.split("\n").filter((line) => line.startsWith(`- [ ] **${id}**`));
      expect(lines, id).toHaveLength(1);
      const rows = requirements
        .split("\n")
        .filter((line) => line.startsWith(`| ${id} | Phase 05.2`) && line.endsWith("| Pending |"));
      expect(rows, id).toHaveLength(1);
    }
  });

  it("raises the v1 total by 11, adds the 05.2 distribution row and updates the footer", () => {
    const requirements = read(".planning/REQUIREMENTS.md");
    expect(requirements).toContain("- v1 requirements: 176 total");
    expect(requirements).toContain("- Mapped to phases: 176");
    expect(requirements).toMatch(/^\| 05\.2 \| Automated Live UAT Runner[^|]*\| 11 \|$/m);
    expect(requirements).toContain("| **Total** | | **176** |");
    const footer = requirements.slice(requirements.lastIndexOf("*Last updated"));
    expect(footer).toContain("05.2");
    expect(footer).toContain("E2E-01");
  });
});

run("ROADMAP.md (Test 4)", () => {
  it("lists the requirements and the ten plans of Phase 05.2", () => {
    const roadmap = read(".planning/ROADMAP.md");
    const block = section(roadmap, /^### Phase 05\.2:/m);
    expect(block).not.toBe("");
    for (const id of E2E_IDS) expect(block, id).toContain(id);
    for (let n = 1; n <= 10; n += 1) {
      expect(block, `plan ${n}`).toContain(`05.2-${String(n).padStart(2, "0")}-PLAN.md`);
    }
  });
});

run("the rule is stated identically (Test 5)", () => {
  it("appears verbatim in Testing agents, the compliance skill and the Key Decisions row", () => {
    const workflow = flat(section(read(".planning/WORKFLOW.md"), /^## Testing agents/m));
    const skill = flat(read(".claude/skills/prd-compliance-review/SKILL.md"));
    const row = flat(
      read(".planning/PROJECT.md")
        .split("\n")
        .find((line) => flat(line).startsWith("| automated live uat runner")) ?? "",
    );
    for (const [name, text] of [
      ["WORKFLOW.md", workflow],
      ["SKILL.md", skill],
      ["the Key Decisions row", row],
    ] as const) {
      expect(text, name).toContain(RATIFICATION_RULE);
    }
  });

  it("is never contradicted by a sentence that lets an automated run replace an owner item", () => {
    for (const file of [
      ".planning/WORKFLOW.md",
      ".claude/skills/prd-compliance-review/SKILL.md",
      ".planning/PROJECT.md",
      ".planning/REQUIREMENTS.md",
    ]) {
      expect(flat(read(file)), file).not.toMatch(
        /automated run (is|can be|may be) (the|a) (replacement|pass|substitute) for (items tagged )?(run: )?owner/,
      );
    }
  });
});
