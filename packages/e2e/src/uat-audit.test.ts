import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { REPO_ROOT } from "./repo-paths.js";
import { type AuditResult, auditPhases, classifyResult } from "./uat-audit.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Plan 08-06 (SLICE-02, D-24, D-25, D-29): the audit checker over synthetic fixtures. The fixtures
 * under `fixtures/uat-audit/phases` are made-up miniatures of each evidence format; nothing in this
 * file reads a real phase file except the one clearly marked real-tree case (private checkouts
 * only), which asserts that no item title or result text is ever printed.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/uat-audit/phases", import.meta.url));
const HEAD = "0123456789abcdef0123456789abcdef01234567";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ccc-e2e-audit."));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A phases folder holding copies of the named fixture folders. */
function phasesWith(...names: string[]): string {
  const dir = join(scratch, "phases");
  mkdirSync(dir, { recursive: true });
  for (const name of names) cpSync(join(FIXTURES, name), join(dir, name), { recursive: true });
  return dir;
}

/** Writes one file below a phases folder, creating the phase folder. */
function put(phases: string, folder: string, file: string, text: string): void {
  mkdirSync(join(phases, folder), { recursive: true });
  writeFileSync(join(phases, folder, file), text);
}

async function audit(
  args: string[],
  io: Record<string, unknown> = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(["audit", ...args], {
    write: (line) => lines.push(line),
    io: {
      readGitFacts: async () => ({ head: HEAD, clean: true, changedSince: null }),
      now: () => new Date("2026-01-02T03:04:05Z"),
      ...io,
    },
  });
  return { code, lines };
}

describe("the audit command over a standard script folder (Test 1, tracer)", () => {
  it("exits 1 when the evidence table names phases missing from the folder", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const out = join(scratch, "AUDIT.md");
    const { code } = await audit(["--phases-dir", phases, "--out", out]);
    expect(code).toBe(1);
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^\| 01 \|.*\| missing \|/m);
  });

  it("exits 0 with --only 02,07 and writes a recorded row for 02 and a pending row for 07", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const out = join(scratch, "AUDIT.md");
    const { code, lines } = await audit(["--phases-dir", phases, "--out", out, "--only", "02,07"]);
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^\| 02 \|.*\| 3\/3 \| recorded \|/m);
    expect(text).toMatch(/^\| 07 \|.*\| 0\/2 \| pending-live-uat \|/m);
    expect(text).not.toMatch(/^\| 01 \|/m);
    // Counts and file names only: no item title or result text reaches the console.
    expect(lines.join("\n")).not.toMatch(/synthetic check|PASSED|RESOLVED/);
  });

  it("exits 1 when a phase other than 07 or 08 is pending", async () => {
    const phases = phasesWith("02-beta");
    put(
      phases,
      "03-gamma",
      "03-UAT.md",
      "---\nstatus: testing\nphase: 03-gamma\n---\n\n## Tests\n\n### 1. Unrun\nrun: owner\nresult: [pending]\n",
    );
    const out = join(scratch, "AUDIT.md");
    const { code } = await audit(["--phases-dir", phases, "--out", out, "--only", "02,03"]);
    expect(code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 03 \|.*\| pending-live-uat \|/m);
  });

  it("exits 1 for an unresolved failure and for an unrecognised result", async () => {
    const phases = phasesWith("02-beta");
    put(
      phases,
      "03-gamma",
      "03-UAT.md",
      "---\nstatus: complete\nphase: 03-gamma\n---\n\n### 1. A\nresult: fail\n",
    );
    put(
      phases,
      "04-delta",
      "04-UAT.md",
      "---\nstatus: complete\nphase: 04-delta\n---\n\n### 1. A\nresult: maybe later\n",
    );
    const out = join(scratch, "AUDIT.md");
    expect((await audit(["--phases-dir", phases, "--out", out, "--only", "02,03"])).code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 03 \|.*\| issue \|/m);
    expect((await audit(["--phases-dir", phases, "--out", out, "--only", "02,04"])).code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 04 \|.*\| unrecognised \|/m);
  });

  it("records the head and the date in the front matter", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const out = join(scratch, "AUDIT.md");
    await audit(["--phases-dir", phases, "--out", out, "--only", "02,07"]);
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^generated: 2026-01-02$/m);
    expect(text).toMatch(new RegExp(`^git-head: ${HEAD}$`, "m"));
  });
});

describe("classifyResult (Test 2)", () => {
  it("maps empty and [pending] to pending", () => {
    for (const value of [null, "", "   ", "[pending]", "[pending] not run yet"]) {
      expect(classifyResult(value), String(value)).toBe("pending");
    }
  });

  it("maps pass, passed, resolved and accepted to ok", () => {
    for (const value of [
      "pass",
      "passed",
      "PASSED (2000-01-01, note)",
      "pass - details",
      "resolved",
      "RESOLVED via plan 02-99",
      "accepted",
      "Accepted by the owner",
    ]) {
      expect(classifyResult(value), value).toBe("ok");
    }
  });

  it("maps fail, failed, issue and blocked to issue", () => {
    for (const value of ["fail", "FAILED", "issue", "ISSUE (major)", "blocked", "blocked by x"]) {
      expect(classifyResult(value), value).toBe("issue");
    }
  });

  it("maps anything else to unrecognised and never guesses", () => {
    for (const value of ["maybe", "skipped", "passing", "passes", "n/a", "unverified"]) {
      expect(classifyResult(value), value).toBe("unrecognised");
    }
  });
});

describe("an auto result counts only when its run is ratified (Test 3)", () => {
  const SCRIPT = [
    "---",
    "status: testing",
    "phase: 03-gamma",
    "---",
    "",
    "## Tests",
    "",
    "### 1. An automated synthetic check",
    "run: auto",
    "auto-result: pass @ 0a1b2c3d 2000-03-01",
    "result: [pending]",
    "",
  ].join("\n");
  const REPORT = (ratified: string): string =>
    [
      "---",
      "run-id: 0a1b2c3d",
      "phase: 03",
      `ratified: ${ratified}`,
      "---",
      "",
      "# Synthetic report",
      "",
    ].join("\n");

  it("is recorded when a ratified report for that run is in the phase folder", async () => {
    const phases = phasesWith();
    put(phases, "03-gamma", "03-UAT.md", SCRIPT);
    put(
      phases,
      "03-gamma",
      "03-UAT-AUTO-REPORT.md",
      REPORT("Accepted by the owner on 2000-03-02."),
    );
    const out = join(scratch, "AUDIT.md");
    const { code } = await audit(["--phases-dir", phases, "--out", out, "--only", "03"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 03 \|.*\| 1\/1 \| recorded \|/m);
  });

  it("stays pending without a report, with an unratified report or for another run", async () => {
    const out = join(scratch, "AUDIT.md");
    const without = phasesWith();
    put(without, "03-gamma", "03-UAT.md", SCRIPT);
    expect((await audit(["--phases-dir", without, "--out", out, "--only", "03"])).code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 03 \|.*\| 0\/1 \| pending-live-uat \|/m);

    const unratified = join(scratch, "unratified");
    put(unratified, "03-gamma", "03-UAT.md", SCRIPT);
    put(unratified, "03-gamma", "03-UAT-AUTO-REPORT.md", REPORT("pending"));
    expect((await audit(["--phases-dir", unratified, "--out", out, "--only", "03"])).code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/\| 0\/1 \| pending-live-uat \|/);

    const otherRun = join(scratch, "other-run");
    put(otherRun, "03-gamma", "03-UAT.md", SCRIPT);
    put(
      otherRun,
      "03-gamma",
      "03-UAT-AUTO-REPORT.md",
      REPORT("Accepted.").replace("0a1b2c3d", "ffffffff"),
    );
    expect((await audit(["--phases-dir", otherRun, "--out", out, "--only", "03"])).code).toBe(1);
  });
});

describe("usage errors (Test 4)", () => {
  it("exit 2 and name the flag, never a file's content", async () => {
    for (const [args, flag] of [
      [["--bogus"], "--bogus"],
      [["--only", "99"], "--only"],
      [["--only", "0x"], "--only"],
      [["--phases-dir"], "--phases-dir"],
    ] as const) {
      const { code, lines } = await audit([...args]);
      expect(code, args.join(" ")).toBe(2);
      expect(lines.join("\n")).toContain(flag);
    }
    const missing = join(scratch, "no-such-folder");
    const { code, lines } = await audit(["--phases-dir", missing, "--out", join(scratch, "A.md")]);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--phases-dir");
    expect(lines.join("\n")).not.toContain(missing);
    expect(existsSync(join(scratch, "A.md"))).toBe(false);
  });

  it("refuses an --out that is a registered evidence file, and positional arguments", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const before = readFileSync(join(phases, "02-beta", "02-UAT.md"), "utf8");
    const { code, lines } = await audit([
      "--phases-dir",
      phases,
      "--out",
      join(phases, "02-beta", "02-UAT.md"),
      "--only",
      "02,07",
    ]);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--out");
    expect(readFileSync(join(phases, "02-beta", "02-UAT.md"), "utf8")).toBe(before);
    expect((await audit(["stray"])).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the five non-standard evidence formats and the exception list.

function auditTree(phases: string, only: string[]): AuditResult {
  return auditPhases({
    phasesDir: phases,
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    only,
  });
}

function rowOf(result: AuditResult, phase: string) {
  const row = result.rows.find((entry) => entry.phase === phase);
  if (row === undefined) throw new Error(`no row for phase ${phase}`);
  return row;
}

describe("the Phase 1 adapter (Test 1)", () => {
  it("reads the Owner UAT heading and lists the deferred item as the one exception", () => {
    const row = rowOf(auditTree(phasesWith("01-alpha"), ["01"]), "01");
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["01-item-10"]);
    expect(row.exceptions[0]?.summary).toMatch(/Item 10.*deferred/);
  });

  it("is recorded without exceptions when nothing is deferred, and pending without the heading", () => {
    const phases = phasesWith("01-alpha");
    const file = join(phases, "01-alpha", "01-VERIFICATION.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/Item 10[\s\S]*$/, "Nothing is deferred.\n"),
    );
    expect(rowOf(auditTree(phases, ["01"]), "01").status).toBe("recorded");
    writeFileSync(file, "---\nstatus: passed\n---\n\n# No heading here\n");
    expect(rowOf(auditTree(phases, ["01"]), "01").status).toBe("pending-live-uat");
  });
});

describe("the Phase 5 adapter (Test 2)", () => {
  it("takes items from the Items list, lets the latest line win and lists UNVERIFIED", () => {
    const row = rowOf(auditTree(phasesWith("05-gamma"), ["05"]), "05");
    // The setup reminder is not an item; UAT-2's re-run supersedes its earlier ISSUE.
    expect(row.total).toBe(4);
    expect(row.recorded).toBe(4);
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["05-uat-3"]);
  });

  it("treats a stale NOT RUN header with results as a defect, not a failure", () => {
    const row = rowOf(auditTree(phasesWith("05-gamma"), ["05"]), "05");
    expect(row.defects.join(" ")).toMatch(/NOT RUN/);
    expect(row.status).not.toBe("issue");
  });

  it("stays an issue when the ISSUE line is not superseded", () => {
    const phases = phasesWith("05-gamma");
    const file = join(phases, "05-gamma", "05-UAT.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^- UAT-2 \(re-run.*\n/m, ""));
    expect(rowOf(auditTree(phases, ["05"]), "05").status).toBe("issue");
  });
});

describe("the Phase 05.1 adapter (Test 3)", () => {
  it("takes items from the U headings and results from the log, ignoring part lines", () => {
    const row = rowOf(auditTree(phasesWith("05.1-delta"), ["05.1"]), "05.1");
    expect(row.total).toBe(5);
    expect(row.recorded).toBe(5);
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id).sort()).toEqual(
      ["05.1-claude-run", "05.1-u2", "05.1-u3"].sort(),
    );
  });

  it("reports in-file [pending] results as a defect, since the log is the record", () => {
    const row = rowOf(auditTree(phasesWith("05.1-delta"), ["05.1"]), "05.1");
    expect(row.defects.join(" ")).toMatch(/5 in-file result line\(s\) still read \[pending\]/);
  });

  it("is missing when the log file is absent", () => {
    const phases = phasesWith("05.1-delta");
    rmSync(join(phases, "05.1-delta", "05.1-UAT-RESULTS-LOG.md"));
    expect(rowOf(auditTree(phases, ["05.1"]), "05.1").status).toBe("missing");
  });
});

describe("the Phase 05.2 adapter (Test 4)", () => {
  it("is recorded with the no-UAT-file exception when passed and a ratified run is named", () => {
    const row = rowOf(auditTree(phasesWith("05.2-epsilon"), ["05.2"]), "05.2");
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["05.2-no-uat-file"]);
  });

  it("is pending when the record is not passed or names no run", () => {
    const phases = phasesWith("05.2-epsilon");
    const file = join(phases, "05.2-epsilon", "05.2-VERIFICATION.md");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("status: passed", "status: human_needed"));
    expect(rowOf(auditTree(phases, ["05.2"]), "05.2").status).toBe("pending-live-uat");
    writeFileSync(file, original.replace(/run 0a1b2c3d/gi, "a run"));
    expect(rowOf(auditTree(phases, ["05.2"]), "05.2").status).toBe("pending-live-uat");
  });
});

describe("the Phase 6 adapter (Test 5)", () => {
  it("records every item and lists the Claude ratification as an exception", () => {
    const row = rowOf(auditTree(phasesWith("06-zeta"), ["06"]), "06");
    expect(row.total).toBe(3);
    expect(row.recorded).toBe(3);
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["06-claude-ratified"]);
  });

  it("is plainly recorded when the owner made the ratification statement", () => {
    const phases = phasesWith("06-zeta");
    const file = join(phases, "06-zeta", "06-UAT-AUTO-REPORT.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /^ratified: .*$/m,
        "ratified: Accepted by the owner on 2000-04-02.",
      ),
    );
    expect(rowOf(auditTree(phases, ["06"]), "06").status).toBe("recorded");
  });

  it("is missing when the registered report is absent", () => {
    const phases = phasesWith("06-zeta");
    rmSync(join(phases, "06-zeta", "06-UAT-AUTO-REPORT.md"));
    expect(rowOf(auditTree(phases, ["06"]), "06").status).toBe("missing");
  });
});

describe("the exception list in the record (Test 6)", () => {
  it("gives every exception row the OD-7 pointer and accepted: pending", async () => {
    const phases = phasesWith("01-alpha", "05-gamma", "05.1-delta", "05.2-epsilon", "06-zeta");
    const out = join(scratch, "AUDIT.md");
    const { code } = await audit([
      "--phases-dir",
      phases,
      "--out",
      out,
      "--only",
      "01,05,05.1,05.2,06",
    ]);
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    const rows = text
      .split("\n")
      .filter((line) => /^\| (?:01|05|05\.1|05\.2|06)-[a-z0-9-]+ \|/.test(line));
    expect(rows.map((line) => line.split("|")[1]?.trim()).sort()).toEqual(
      [
        "01-item-10",
        "05-uat-3",
        "05.1-claude-run",
        "05.1-u2",
        "05.1-u3",
        "05.2-no-uat-file",
        "06-claude-ratified",
      ].sort(),
    );
    for (const line of rows) {
      expect(line).toMatch(/\| OD-7 \| pending \|$/);
    }
    expect(text).toMatch(/^exceptions: 7$/m);
    expect(text).toMatch(/^exceptions-accepted: 0$/m);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the preserved blocks, strict mode, the public clone and the real tree.

describe("regeneration keeps what the owner wrote (Test 1)", () => {
  async function firstRecord(): Promise<{ out: string; phases: string }> {
    const phases = phasesWith("01-alpha", "05-gamma");
    const out = join(scratch, "AUDIT.md");
    await audit(["--phases-dir", phases, "--out", out, "--only", "01,05"]);
    return { out, phases };
  }

  it("writes default Amendments and Milestone statement blocks on the first run", async () => {
    const { out } = await firstRecord();
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^## Amendments$/m);
    expect(text).toMatch(/^## Milestone statement$/m);
    expect(text).toMatch(/OD-7, accept the exceptions above in one statement: pending/);
  });

  it("keeps the accepted: values, the Amendments block and the statement block byte for byte", async () => {
    const { out, phases } = await firstRecord();
    let text = readFileSync(out, "utf8");
    text = text.replace(/^(\| 01-item-10 \|.*\| )pending \|$/m, "$12000-05-06 (synthetic owner) |");
    text = text.replace(
      /^## Amendments[\s\S]*?(?=^## Milestone statement)/m,
      "## Amendments\n\n- 2000-05-05: a made-up amendment line, kept verbatim.\n\n",
    );
    text = text.replace(
      /^## Milestone statement[\s\S]*$/m,
      "## Milestone statement\n\nOwner words, kept verbatim: accepted.\n- Verdict: yes\n",
    );
    text = text.replace("## Phases\n", "## Phases\n\nSTALE GENERATED LINE\n");
    writeFileSync(out, text);
    const kept = (value: string) =>
      [
        value.match(/^\| 01-item-10 \|.*$/m)?.[0],
        value.match(/^## Amendments[\s\S]*?(?=^## Milestone statement)/m)?.[0],
        value.match(/^## Milestone statement[\s\S]*$/m)?.[0],
      ].join("\n--\n");
    const before = kept(text);

    await audit(["--phases-dir", phases, "--out", out, "--only", "01,05"]);

    const after = readFileSync(out, "utf8");
    expect(kept(after)).toBe(before);
    expect(after).not.toContain("STALE GENERATED LINE");
    expect(after).toMatch(/^exceptions-accepted: 1$/m);
    // The accepted exception no longer counts against a strict run; the pending one still does.
    expect(after).toMatch(/^strict-clean: false$/m);
  });
});

describe("--strict (Test 2)", () => {
  async function recorded(phases: string, only: string, extra: string[] = []): Promise<number> {
    return (
      await audit([
        "--phases-dir",
        phases,
        "--out",
        join(scratch, "AUDIT.md"),
        "--only",
        only,
        ...extra,
      ])
    ).code;
  }

  it("fails while 07 is pending or an exception is not accepted, and passes once both are settled", async () => {
    const phases = phasesWith("01-alpha", "07-eta");
    expect(await recorded(phases, "01,07")).toBe(0);
    expect(await recorded(phases, "01,07", ["--strict"])).toBe(1);

    // 07 walked: every result recorded. The one exception is still unaccepted.
    const seven = join(phases, "07-eta", "07-UAT.md");
    writeFileSync(seven, readFileSync(seven, "utf8").replace(/\[pending\]/g, "pass"));
    expect(await recorded(phases, "01,07", ["--strict"])).toBe(1);
    expect(readFileSync(join(scratch, "AUDIT.md"), "utf8")).toMatch(/^strict-clean: false$/m);

    // The owner accepts it in the record; the next strict run is clean.
    const out = join(scratch, "AUDIT.md");
    writeFileSync(
      out,
      readFileSync(out, "utf8").replace(/^(\| 01-item-10 \|.*\| )pending \|$/m, "$12000-05-06 |"),
    );
    expect(await recorded(phases, "01,07", ["--strict"])).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/^strict-clean: true$/m);
  });
});

describe("a public clone (Test 3)", () => {
  it("prints one not-applicable line and exits 0 when there is no planning folder", async () => {
    const written: string[] = [];
    const { code, lines } = await audit([], {
      exists: () => false,
      writeText: (path: string) => written.push(path),
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["not applicable (no planning directory)"]);
    expect(written).toEqual([]);
  });
});

const planned = existsSync(join(REPO_ROOT, ".planning", "ROADMAP.md"));
const real = planned ? describe : describe.skip;

real("the real tree (Test 4, private checkouts only)", () => {
  it("exits 0 with phases 01 to 06 recorded and 07 and 08 pending, and prints no item text", async () => {
    const out = join(scratch, "REAL-AUDIT.md");
    const { code, lines } = await audit(["--out", out]);
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    for (const phase of ["01", "02", "03", "04", "05", "05.1", "05.2", "06"]) {
      expect(text, phase).toMatch(
        new RegExp(
          `^\\| ${phase.replace(".", "\\.")} \\|.*\\| (?:recorded|recorded-with-exceptions) \\|`,
          "m",
        ),
      );
    }
    for (const phase of ["07", "08"]) {
      expect(text, phase).toMatch(new RegExp(`^\\| ${phase} \\|.*\\| pending-live-uat \\|`, "m"));
    }
    // Console output is counts and statuses only: no item title and no result text.
    const phasesDir = join(REPO_ROOT, ".planning", "phases");
    const folder = readdirSync(phasesDir).find((name) => name.startsWith("07-")) ?? "";
    const titles = parseUatScript(
      readFileSync(join(phasesDir, folder, "07-UAT.md"), "utf8"),
    ).items.map((item) => item.title);
    expect(titles.length).toBeGreaterThan(0);
    const printed = lines.join("\n");
    for (const title of titles) expect(printed).not.toContain(title);
    expect(printed).not.toMatch(/iTerm2|UNVERIFIED|computer use/);
    for (const line of lines) {
      expect(line).toMatch(
        /^(Phase \d{2}(?:\.\d)?: [a-z-]+ \(\d+\/\d+ items recorded\)|Exceptions listed: \d+\.|Record written: [A-Za-z0-9.-]+\.)$/,
      );
    }
  });
});
