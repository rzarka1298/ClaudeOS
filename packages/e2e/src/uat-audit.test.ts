import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { REPO_ROOT } from "./repo-paths.js";
import {
  type AuditResult,
  type AuditTestHooks,
  auditPhases,
  classifyResult,
  PHASE_EVIDENCE,
} from "./uat-audit.js";
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

/** The item counts of the miniature fixtures (the real counts come from the spec maps). */
const FIXTURE_COUNTS = { "06": 3, "07": 2, "08": 2, "09": 2 } as const;

/**
 * Runs the audit through the real `main`. A `--only a,b` pair in `args` is lifted out into the
 * test hook, because the production parser refuses `--only` (FIX1B B-M1); `rawAudit` is the
 * production parser unchanged. Fixture item counts replace the spec-map counts unless
 * `realCounts` is set.
 */
async function audit(
  args: string[],
  io: Record<string, unknown> = {},
  options: { realCounts?: boolean } = {},
): Promise<{ code: number; lines: string[] }> {
  const rest = [...args];
  let only: string[] | undefined;
  const at = rest.indexOf("--only");
  if (at !== -1 && rest[at + 1] !== undefined) {
    only = (rest[at + 1] as string).split(",");
    rest.splice(at, 2);
  }
  return rawAudit(rest, io, {
    ...(only === undefined ? {} : { only }),
    ...(options.realCounts === true ? {} : { expectedItems: FIXTURE_COUNTS }),
  });
}

async function rawAudit(
  args: string[],
  io: Record<string, unknown> = {},
  hooks: AuditTestHooks = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(["audit", ...args], {
    write: (line) => lines.push(line),
    auditHooks: hooks,
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
      "---\nstatus: testing\nphase: 03-gamma\n---\n\n## Tests\n\n### 1. Unrun\nrun: owner\nresult: [pending]\n\n## Summary\n\ntotal: 1\n",
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
      "---\nstatus: complete\nphase: 03-gamma\n---\n\n### 1. A\nresult: fail\n\n## Summary\n\ntotal: 1\n",
    );
    put(
      phases,
      "04-delta",
      "04-UAT.md",
      "---\nstatus: complete\nphase: 04-delta\n---\n\n### 1. A\nresult: maybe later\n\n## Summary\n\ntotal: 1\n",
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
    "## Summary",
    "",
    "total: 1",
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
      [["--only", "02"], "--only"],
      [["--only=02"], "--only"],
      [["--phases-dir"], "--phases-dir"],
    ] as const) {
      const { code, lines } = await rawAudit([...args]);
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
    expectedItems: FIXTURE_COUNTS,
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
      ["05.1-claude-run", "05.1-u2", "05.1-u3", "05.1-u4"].sort(),
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
        "05.1-u4",
        "05.2-no-uat-file",
        "06-claude-ratified",
      ].sort(),
    );
    for (const line of rows) {
      expect(line).toMatch(/\| OD-7 \| pending \|$/);
    }
    expect(text).toMatch(/^exceptions: 8$/m);
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
    text = text.replace(/^(\| 01-item-10 \|.*\| )pending \|$/m, "$12000-05-06 |");
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

// ---------------------------------------------------------------------------
// FIX1B: the checker fails closed.

/** True when the temp volume treats upper and lower case as the same name (APFS default). */
const CASE_INSENSITIVE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "ccc-e2e-case."));
  try {
    writeFileSync(join(probe, "Probe"), "x");
    return existsSync(join(probe, "pROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("the production parser has no --only (B-M1)", () => {
  it("refuses --only in either spelling and writes nothing", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const out = join(scratch, "AUDIT.md");
    for (const only of [["--only", "02,07"], ["--only=02,07"]]) {
      const { code, lines } = await rawAudit(["--phases-dir", phases, "--out", out, ...only]);
      expect(code, only.join(" ")).toBe(2);
      expect(lines.join("\n")).toContain("--only");
    }
    expect(existsSync(out)).toBe(false);
  });
});

describe("the --out guard (B-M1, Codex-1, B-MINOR 6)", () => {
  const sevenOf = (phases: string): string => join(phases, "07-eta", "07-UAT.md");

  /** An audit filtered to phase 02, aimed at `out`: the filter must not hide 07's file. */
  async function aimed(phases: string, out: string) {
    return audit(["--phases-dir", phases, "--out", out, "--only", "02"]);
  }

  it("refuses another phase's evidence file whatever the --only filter", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const before = readFileSync(sevenOf(phases), "utf8");
    const { code, lines } = await aimed(phases, sevenOf(phases));
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--out");
    expect(readFileSync(sevenOf(phases), "utf8")).toBe(before);
  });

  it.runIf(CASE_INSENSITIVE)("refuses a case variant of an evidence file", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const before = readFileSync(sevenOf(phases), "utf8");
    const variant = join(phases, "07-ETA", "07-uat.MD");
    expect((await aimed(phases, variant)).code).toBe(2);
    expect(readFileSync(sevenOf(phases), "utf8")).toBe(before);
  });

  it("refuses a symbolic link and a hard link to an evidence file", async () => {
    const phases = phasesWith("02-beta", "07-eta");
    const before = readFileSync(sevenOf(phases), "utf8");
    const soft = join(scratch, "soft.md");
    symlinkSync(sevenOf(phases), soft);
    expect((await aimed(phases, soft)).code).toBe(2);
    const hard = join(scratch, "hard.md");
    linkSync(sevenOf(phases), hard);
    expect((await aimed(phases, hard)).code).toBe(2);
    const dirLink = join(scratch, "dir-link");
    symlinkSync(join(phases, "07-eta"), dirLink);
    expect((await aimed(phases, join(dirLink, "07-UAT.md"))).code).toBe(2);
    expect(readFileSync(sevenOf(phases), "utf8")).toBe(before);
  });

  it("refuses an --out outside the Phase 8 folder and the temp folder", async () => {
    const phases = phasesWith("02-beta");
    const elsewhere = join(REPO_ROOT, "packages", "e2e", "audit-out-must-not-exist.md");
    expect((await aimed(phases, elsewhere)).code).toBe(2);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("allows a new file below the temp folder", async () => {
    const phases = phasesWith("02-beta");
    expect((await aimed(phases, join(scratch, "fresh-record.md"))).code).toBe(0);
  });

  it("allows the Phase 8 folder and, by default, writes the record there", async () => {
    const phases = phasesWith("02-beta");
    put(phases, "08-theta", "keep.txt", "x");
    const inside = join(phases, "08-theta", "08-UAT-AUDIT.md");
    expect((await aimed(phases, inside)).code).toBe(0);
    expect(existsSync(inside)).toBe(true);
    rmSync(inside);
    const { code } = await audit(["--phases-dir", phases, "--only", "02"]);
    expect(code).toBe(0);
    expect(existsSync(inside)).toBe(true);
  });
});

describe("script items fail closed (B-M2 a, b, d)", () => {
  const body = (items: string[], summary: string | null): string =>
    [
      "---",
      "status: complete",
      "phase: 03-gamma",
      "---",
      "",
      "## Tests",
      "",
      ...items,
      ...(summary === null ? [] : ["## Summary", "", summary, ""]),
    ].join("\n");
  const ok = (n: number): string => `### ${n}. Item ${n}\nrun: owner\nresult: pass\n`;

  function statusOfScript(text: string, expected?: Record<string, number>): AuditResult {
    const phases = phasesWith();
    put(phases, "03-gamma", "03-UAT.md", text);
    return auditPhases({
      phasesDir: phases,
      readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
      only: ["03"],
      ...(expected === undefined ? {} : { expectedItems: expected }),
    });
  }

  it("reads a clean script as recorded", () => {
    const row = rowOf(statusOfScript(body([ok(1), ok(2)], "total: 2")), "03");
    expect(row.status).toBe("recorded");
    expect(row.defects).toEqual([]);
  });

  it("reads an item with no result line, or with two, as unrecognised", () => {
    const none = rowOf(statusOfScript(body([ok(1), "### 2. B\nrun: owner\n"], "total: 2")), "03");
    expect(none.status).toBe("unrecognised");
    const two = rowOf(
      statusOfScript(body([ok(1), "### 2. B\nresult: fail\nresult: pass\n"], "total: 2")),
      "03",
    );
    expect(two.status).toBe("unrecognised");
  });

  it("reads a script with a parse finding such as a repeated item as unrecognised", () => {
    const row = rowOf(statusOfScript(body([ok(1), ok(1)], "total: 2")), "03");
    expect(row.status).toBe("unrecognised");
    expect(row.defects.join(" ")).toMatch(/ITEM_DUPLICATE/);
    const tag = rowOf(
      statusOfScript(body([ok(1), "### 2. B\nrun: owner\nrun: auto\nresult: pass\n"], "total: 2")),
      "03",
    );
    expect(tag.status).toBe("unrecognised");
  });

  it("reads an item count that differs from the Summary total, or a missing total, as a problem", () => {
    const fewer = rowOf(statusOfScript(body([ok(1), ok(2)], "total: 3")), "03");
    expect(fewer.status).toBe("unrecognised");
    expect(fewer.defects.join(" ")).toMatch(/total/);
    expect(rowOf(statusOfScript(body([ok(1)], null)), "03").status).toBe("unrecognised");
    expect(rowOf(statusOfScript(body([ok(1)], "total: many")), "03").status).toBe("unrecognised");
  });

  it("compares phases 06, 07 and 08 with the spec map item count", () => {
    const phases = phasesWith("06-zeta");
    const run = (expected?: Record<string, number>) =>
      auditPhases({
        phasesDir: phases,
        readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
        listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
        only: ["06"],
        ...(expected === undefined ? {} : { expectedItems: expected }),
      });
    // The default is the real map (26 items for Phase 6): the 3-item miniature does not match it.
    const real = rowOf(run(), "06");
    expect(real.status).toBe("unrecognised");
    expect(real.defects.join(" ")).toMatch(/spec map/);
    expect(rowOf(run({ "06": 3 }), "06").status).toBe("recorded-with-exceptions");
  });

  it("reads an explicit automated failure as an issue even while the owner result is pending", () => {
    const failing = [
      "### 1. Auto",
      "run: auto",
      "auto-result: fail @ 0a1b2c3d 2000-03-01",
      "result: [pending]",
      "",
    ].join("\n");
    const row = rowOf(statusOfScript(body([failing], "total: 1")), "03");
    expect(row.status).toBe("issue");
    // A later owner pass is the owner's own word and stands.
    const walked = failing.replace("result: [pending]", "result: pass");
    expect(rowOf(statusOfScript(body([walked], "total: 1")), "03").status).toBe("recorded");
  });
});

describe("the 05.1 log adapter (B-M2 c)", () => {
  const SCRIPT =
    "# Synthetic\n\nStatus: COMPLETE\n\n" +
    [1, 2, 3].map((n) => `### U${n} — Item ${n}\nresult: [pending]\n`).join("\n");

  function logRow(log: string) {
    const phases = phasesWith();
    put(phases, "05.1-delta", "05.1-UAT.md", SCRIPT);
    put(phases, "05.1-delta", "05.1-UAT-RESULTS-LOG.md", log);
    return rowOf(auditTree(phases, ["05.1"]), "05.1");
  }

  it("takes the latest complete result of each item and ignores part lines", () => {
    const row = logRow("U1 fail — first\nU1 part 1 pass\nU1 pass — re-run\nU2 PASSED\nU3 pass\n");
    expect(row.recorded).toBe(3);
    expect(row.status).toBe("recorded");
  });

  it("lets a later failure supersede an earlier pass", () => {
    const row = logRow("U1 pass\nU2 pass\nU3 pass\nU2 failed — regressed\n");
    expect(row.status).toBe("issue");
  });

  it("reads an unknown verb as unrecognised, never as pending or ok", () => {
    const row = logRow("U1 pass\nU2 wibbled — who knows\nU3 pass\n");
    expect(row.status).toBe("unrecognised");
  });

  it("matches a result after any whitespace, and reports not applicable as an exception", () => {
    const row = logRow("U1\tpass\nU2  pass\nU3 not applicable — the IDE cannot do it\n");
    expect(row.recorded).toBe(3);
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["05.1-u3"]);
    expect(row.status).toBe("recorded-with-exceptions");
  });

  it("flags a log result for an item the script does not have", () => {
    const row = logRow("U1 pass\nU2 pass\nU3 pass\nU9 pass\n");
    expect(row.defects.join(" ")).toMatch(/U9/);
  });
});

describe("--strict reads the acceptance exactly (B-M3)", () => {
  async function strictWith(value: string): Promise<{ code: number; lines: string[] }> {
    const phases = phasesWith("01-alpha");
    const out = join(scratch, "AUDIT.md");
    await audit(["--phases-dir", phases, "--out", out, "--only", "01"]);
    writeFileSync(
      out,
      readFileSync(out, "utf8").replace(/^(\| 01-item-10 \|.*\| )pending \|$/m, `$1${value} |`),
    );
    return audit(["--phases-dir", phases, "--out", out, "--only", "01", "--strict"]);
  }

  it("accepts a bare date and 'accepted <date>'", async () => {
    expect((await strictWith("2026-11-01")).code).toBe(0);
    expect((await strictWith("accepted 2026-11-01")).code).toBe(0);
  });

  it("fails on anything else, naming the acceptance as unreadable", async () => {
    for (const value of [
      "2026-11-01 rejected — not this",
      "2026-11-01 (synthetic owner)",
      "accepted 2026-11-01 but not really",
      "2026-13-45",
      "rejected",
      "2026-1-1",
    ]) {
      const { code, lines } = await strictWith(value);
      expect(code, value).toBe(1);
      expect(lines.join("\n"), value).toMatch(/01-item-10 acceptance unreadable/);
    }
  });
});

describe("regeneration keeps the owner's region verbatim (B-M4)", () => {
  it("keeps everything from ## Amendments to the end, nested headings included", async () => {
    const phases = phasesWith("01-alpha");
    const out = join(scratch, "AUDIT.md");
    await audit(["--phases-dir", phases, "--out", out, "--only", "01"]);
    const generated = readFileSync(out, "utf8");
    const head = generated.slice(0, generated.indexOf("## Amendments"));
    const region = [
      "## Amendments",
      "",
      "- 2000-05-05: a made-up amendment line.",
      "",
      "## 07-UAT item 20 amendment",
      "",
      "Owner words about item 20.   Trailing spaces   ",
      "",
      "## Milestone statement",
      "",
      "- OD-7: accepted",
      "",
      "## Owner signature",
      "",
      "Signed, made up.",
      "no final newline",
    ].join("\n");
    writeFileSync(out, `${head.replace("## Phases\n", "## Phases\n\nSTALE\n")}${region}`);
    await audit(["--phases-dir", phases, "--out", out, "--only", "01"]);
    const after = readFileSync(out, "utf8");
    expect(after.endsWith(region)).toBe(true);
    expect(after).toContain("## 07-UAT item 20 amendment");
    expect(after).toContain("## Owner signature");
    expect(after).not.toContain("STALE");
    expect(after.match(/^## Amendments$/gm)?.length).toBe(1);
  });
});

describe("the remaining audit gaps (B-MINOR 7)", () => {
  it("reports a Phase 7 script that still says status: testing as a defect", () => {
    const row = rowOf(auditTree(phasesWith("07-eta"), ["07"]), "07");
    expect(row.status).toBe("pending-live-uat");
    expect(row.defects.join(" ")).toMatch(/status: testing/);
  });

  it("does not accept a bare run mention in the 05.2 record without a ratified marker", () => {
    const phases = phasesWith("05.2-epsilon");
    const file = join(phases, "05.2-epsilon", "05.2-VERIFICATION.md");
    const original = readFileSync(file, "utf8");
    const status = (text: string): string => {
      writeFileSync(file, text);
      return rowOf(auditTree(phases, ["05.2"]), "05.2").status;
    };
    const bare = original.replace(
      /^Run 0a1b2c3d passed.*$/m,
      "Run 0a1b2c3d passed 2/2 automated specs. Decide whether run 0a1b2c3d is ratified.",
    );
    expect(status(bare)).toBe("pending-live-uat");
    expect(status(original.replace(/was ratified under/, "was not ratified under"))).toBe(
      "pending-live-uat",
    );
    expect(
      status(original.replace(/^Run.*$/m, "The report says ratified: I accept run 0a1b2c3d.")),
    ).toBe("recorded-with-exceptions");
    expect(
      status(original.replace(/^Run.*$/m, "Run **0a1b2c3d** on main was ratified by Claude.")),
    ).toBe("recorded-with-exceptions");
  });

  it("does not list its own output as an unregistered UAT file", () => {
    const phases = phasesWith("02-beta");
    put(phases, "08-theta", "08-UAT-AUDIT.md", "x");
    put(phases, "08-theta", "08-UAT-NOTES.md", "x");
    const result = auditPhases({
      phasesDir: phases,
      readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
      expectedItems: FIXTURE_COUNTS,
    });
    expect(result.unregistered).toEqual(["08-theta/08-UAT-NOTES.md"]);
  });
});

const planned = existsSync(join(REPO_ROOT, ".planning", "ROADMAP.md"));
const real = planned ? describe : describe.skip;

real("the real tree (Test 4, private checkouts only)", () => {
  it("exits 0 with every phase recorded after the owner's sitting, and prints no item text", async () => {
    const out = join(scratch, "REAL-AUDIT.md");
    const { code, lines } = await audit(["--out", out], {}, { realCounts: true });
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    // The per-phase counts of the real evidence (a drift here is a finding, not a test to loosen).
    const counts: Record<string, string> = {
      "01": "1/1",
      "02": "4/4",
      "03": "12/12",
      "04": "14/14",
      "05": "17/17",
      "05.1": "16/16",
      "05.2": "1/1",
      "06": "26/26",
      // 07 and 08 were completed by the ratified automated runs and the owner's sitting (2026-10-26).
      "07": "24/24",
      "08": "39/39",
    };
    // Phase 9 joined the table in plan 09-21 with its owner items pending until the sitting.
    const nine = text.match(/^\| 09 \|[^|]*\| (\d+)\/(\d+) \| ([a-z-]+) \|/m);
    expect(nine, "a row for phase 09").not.toBeNull();
    expect(nine?.[3]).toBe("pending-live-uat");
    for (const [phase, count] of Object.entries(counts)) {
      expect(text, phase).toMatch(
        new RegExp(`^\\| ${phase.replace(".", "\\.")} \\|[^|]*\\| ${count} \\|`, "m"),
      );
    }
    // Every real exception is listed (the eight known at plan time, plus 05.1 U3 not applicable).
    const ids = text
      .split("\n")
      .filter((line) => /^\| (?:01|05|05\.1|05\.2|06)-[a-z0-9-]+ \|/.test(line))
      .map((line) => line.split("|")[1]?.trim())
      .sort();
    expect(ids).toEqual(
      [
        "01-item-10",
        "05-uat-6",
        "05.1-claude-run",
        "05.1-u3",
        "05.1-u5",
        "05.1-u7",
        "05.1-u14",
        "05.2-no-uat-file",
        "06-claude-ratified",
      ].sort(),
    );
    expect(text).not.toMatch(/unregistered UAT file: 08-/);
    for (const phase of ["01", "02", "03", "04", "05", "05.1", "05.2", "06", "07", "08"]) {
      expect(text, phase).toMatch(
        new RegExp(
          `^\\| ${phase.replace(".", "\\.")} \\|.*\\| (?:recorded|recorded-with-exceptions) \\|`,
          "m",
        ),
      );
    }
    // Only Phase 9 is still pending (its owner items are walked at the phase-end sitting).
    expect((text.match(/pending-live-uat \|/g) ?? []).length).toBe(1);
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

describe("Phase 9 in the audit table (plan 09-21, D-17)", () => {
  const NINE = [
    "---",
    "status: testing",
    "phase: 09-theta",
    "---",
    "",
    "## Tests",
    "",
    "### 1. Auto item",
    "run: auto",
    "via: dom",
    "result: [pending]",
    "",
    "### 2. Owner item",
    "run: owner",
    "owner-why: real-session",
    "result: [pending]",
    "",
    "## Summary",
    "",
    "total: 2",
    "",
  ].join("\n");

  it("registers 09 as a script phase with pending allowed", () => {
    expect(PHASE_EVIDENCE.find((entry) => entry.phase === "09")).toEqual({
      phase: "09",
      entries: [{ kind: "uat-script", files: ["09-UAT.md"] }],
      pendingAllowed: true,
    });
  });

  it("reads a testing script with pending results as pending-live-uat without a testing-status defect", () => {
    const phases = phasesWith();
    put(phases, "09-theta", "09-UAT.md", NINE);
    const row = rowOf(auditTree(phases, ["09"]), "09");
    expect(row.status).toBe("pending-live-uat");
    expect(row.recorded).toBe(0);
    expect(row.total).toBe(2);
    expect(row.defects.join(" ")).not.toMatch(/status: testing/);
  });

  it("exits 0 for a pending Phase 9 next to a recorded phase, and 1 for a pending phase 03", async () => {
    const phases = phasesWith("02-beta");
    put(phases, "09-theta", "09-UAT.md", NINE);
    const out = join(scratch, "AUDIT.md");
    expect((await audit(["--phases-dir", phases, "--out", out, "--only", "02,09"])).code).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 09 \|.*\| 0\/2 \| pending-live-uat \|/m);
    put(phases, "03-gamma", "03-UAT.md", NINE.replace("09-theta", "03-gamma"));
    expect((await audit(["--phases-dir", phases, "--out", out, "--only", "02,03"])).code).toBe(1);
  });

  it("still flags a testing status on a phase that is not 07, 08 or 09", () => {
    const phases = phasesWith();
    put(phases, "03-gamma", "03-UAT.md", NINE.replace("09-theta", "03-gamma"));
    const result = auditPhases({
      phasesDir: phases,
      readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
      only: ["03"],
      expectedItems: { "03": 2 },
    });
    expect(rowOf(result, "03").defects.join(" ")).toMatch(/status: testing/);
  });

  it("compares phase 09 with the spec map item count by default", () => {
    const phases = phasesWith();
    put(phases, "09-theta", "09-UAT.md", NINE);
    const result = auditPhases({
      phasesDir: phases,
      readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
      only: ["09"],
    });
    expect(rowOf(result, "09").defects.join(" ")).toMatch(/spec map/);
  });
});

describe("an owner item recorded as not walked (FIX11 finding 4)", () => {
  const script = (result: string) =>
    [
      "---",
      "status: testing",
      "phase: 09-theta",
      "---",
      "",
      "## Tests",
      "",
      "### 1. Walked",
      "run: owner",
      "owner-why: real-session",
      "result: pass — owner 2026-10-30: done",
      "",
      "### 2. Not walkable yet",
      "run: owner",
      "owner-why: real-session",
      `result: ${result}`,
      "",
      "## Summary",
      "",
      "total: 2",
      "",
    ].join("\n");
  const rowFor = (result: string) => {
    const phases = phasesWith();
    put(phases, "09-theta", "09-UAT.md", script(result));
    return rowOf(auditTree(phases, ["09"]), "09");
  };

  it("counts the item as recorded but lists an exception that needs the owner's dated acceptance", () => {
    const row = rowFor(
      "accepted — not walked: no presence-required class is enabled in this build",
    );
    expect(row.recorded).toBe(2);
    expect(row.status).toBe("recorded-with-exceptions");
    expect(row.exceptions.map((entry) => entry.id)).toEqual(["09-uat-2"]);
    expect(row.exceptions[0]?.summary).toMatch(/not walked/);
  });

  it("matches the words case-insensitively and for any phase", () => {
    expect(rowFor("pass — Not Walked here").exceptions.map((entry) => entry.id)).toEqual([
      "09-uat-2",
    ]);
  });

  it("raises no exception for a walked result", () => {
    const row = rowFor("pass — owner 2026-10-30: verified");
    expect(row.exceptions).toEqual([]);
    expect(row.status).toBe("recorded");
  });

  it("fails a strict run until the exception carries a dated acceptance", async () => {
    const phases = phasesWith("02-beta");
    put(
      phases,
      "09-theta",
      "09-UAT.md",
      script("accepted — not walked: no presence-required class is enabled in this build").replace(
        "status: testing",
        "status: complete",
      ),
    );
    const out = join(scratch, "AUDIT.md");
    const run = (extra: string[]) =>
      audit(["--phases-dir", phases, "--out", out, "--only", "02,09", ...extra]);
    expect((await run([])).code).toBe(0);
    expect((await run(["--strict"])).code).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/^\| 09-uat-2 \|.*\| pending \|$/m);
    writeFileSync(
      out,
      readFileSync(out, "utf8").replace(/^(\| 09-uat-2 \|.*\| )pending \|$/m, "$12000-05-06 |"),
    );
    expect((await run(["--strict"])).code).toBe(0);
  });
});
