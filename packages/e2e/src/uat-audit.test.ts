import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { classifyResult } from "./uat-audit.js";

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
