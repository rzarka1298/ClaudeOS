import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 08-23 Tasks 2 and 3 (T-08-56): keeps the Phase 8 threat-evidence record, its bundle privacy
 * trace (success criterion 4), its probe-safety table, the merge-gate runbook, the validation map
 * and the regenerated SLICE-02 audit true to the repository. These are private planning artifacts:
 * a public clone has no `.planning/` and reports that once. A claim that cites a file, a test
 * title, a commit, a cap or a command that no longer exists fails here, so a stale proof cannot
 * give the security judge false assurance.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const planned = existsSync(PLANNING_INDEX);
const phasesDir = join(REPO_ROOT, ".planning", "phases");
const phaseName = existsSync(phasesDir)
  ? readdirSync(phasesDir).find((entry) => entry.startsWith("08-"))
  : undefined;
const dir = phaseName === undefined ? "" : join(phasesDir, phaseName);
const read = (name: string): string =>
  planned && existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
const evidence = read("08-THREAT-EVIDENCE.md");

const run = planned ? describe : describe.skip;

describe("guard (Test 1)", () => {
  it("finds the documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(phaseName, "the phase directory").toBeDefined();
    for (const name of ["08-THREAT-EVIDENCE.md", "08-UAT.md", "08-VALIDATION.md"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function planFiles(): string[] {
  return readdirSync(dir).filter((name) => /^08-\d\d-PLAN\.md$/.test(name));
}

function planThreatIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of planFiles()) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /^\| (T-08-[A-Za-z0-9]+) \|/gm,
    )) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

interface Cite {
  readonly file: string;
  readonly quote: string;
}

interface Row {
  readonly id: string;
  readonly disposition: string;
  readonly kind: string;
  readonly cell: string;
  readonly cites: Cite[];
  readonly commits: string;
  readonly status: string;
}

const CITE = /`([^`]+)`\s+"([^"]+)"/g;

function citesOf(cell: string): Cite[] {
  return [...cell.matchAll(CITE)].map((m) => ({ file: m[1] as string, quote: m[2] as string }));
}

function cellsOf(line: string): string[] {
  return line.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const line of evidence.split("\n")) {
    const cells = cellsOf(line);
    if (!/^T-08-[A-Za-z0-9]+$/.test(cells[1] ?? "")) continue;
    out.push({
      id: cells[1] as string,
      disposition: cells[3] ?? "",
      kind: cells[4] ?? "",
      cell: cells[5] ?? "",
      cites: citesOf(cells[5] ?? ""),
      commits: cells[6] ?? "",
      status: cells[7] ?? "",
    });
  }
  return out;
}

/** The text between a level-2 heading and the next level-2 heading. */
function section(source: string, heading: string): string {
  const match = new RegExp(`^## ${heading}$`, "m").exec(source);
  if (match === null) return "";
  const rest = source.slice(match.index + match[0].length);
  return rest.split(/^## /m)[0] as string;
}

/**
 * The titles a test file declares, as vitest would run them (07-FIX7, MINOR f). A title counts
 * when it is the first argument of a `describe`, `it` or `test` call (or the `run` alias this
 * folder uses for a conditional describe) that is not skipped, nor inside a skipped describe. A
 * describe counts only when it holds at least one such live `it` or `test`. Text in a comment, a
 * string that is not a call's title and a template title are never matched.
 */
function liveTitles(source: string): Set<string> {
  const calls: {
    kind: "suite" | "case";
    title: string;
    skipped: boolean;
    start: number;
    end: number;
  }[] = [];
  // A call whose title is a string or a template, and a test call whose title is computed (a case
  // made in a loop): the second kind has no title to cite but is a live case all the same.
  const pattern =
    /(?<![.\w$])(describe|it|test|run)((?:\.\w+)*)\s*(?:\([^()]*\))?\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\\n])*)\3/g;
  const computed = /(?<![.\w$])(it|test)((?:\.\w+)*)\s*(?:\([^()]*\))?\s*\(\s*(?=[A-Za-z_$])/g;
  const matches = [
    ...[...source.matchAll(pattern)].map((match) => ({ match, title: match[4] ?? "" })),
    ...[...source.matchAll(computed)].map((match) => ({ match, title: "\u0000computed" })),
  ];
  for (const { match, title } of matches) {
    const start = match.index ?? 0;
    // Skip a match inside a line comment, or inside a string literal that began earlier on its line.
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const before = source.slice(lineStart, start);
    if (/^\s*(\/\/|\*|\/\*)/.test(before)) continue;
    const quotes = (mark: string): number => before.replace(/\\./g, "").split(mark).length - 1;
    if (quotes('"') % 2 === 1 || quotes("'") % 2 === 1) continue;
    const suite = match[1] === "describe" || match[1] === "run";
    // A suite runs from its own line to the next suite at the same or a shallower indentation (or
    // the end of the file). Indentation, not braces: regular expressions and strings in a body hold
    // quotes and braces that a light scan cannot tell from code.
    let end = source.length;
    if (suite) {
      const indent = (/^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "").length;
      const next = [
        ...source.matchAll(/^([ \t]*)(?:describe|run)(?:\.\w+)*\s*(?:\([^()]*\))?\s*\(/gm),
      ].find(
        (candidate) => (candidate.index ?? 0) > start && (candidate[1] ?? "").length <= indent,
      );
      end = next?.index ?? source.length;
    }
    calls.push({
      kind: suite ? "suite" : "case",
      title: title.replace(/\\(["'`\\])/g, "$1"),
      skipped: /\.(skip|todo)\b/.test(match[2] ?? ""),
      start,
      end,
    });
  }
  const live = (call: (typeof calls)[number]): boolean =>
    !call.skipped &&
    !calls.some(
      (other) =>
        other.kind === "suite" &&
        other.skipped &&
        other.start < call.start &&
        call.start < other.end,
    );
  const titles = new Set<string>();
  for (const call of calls) {
    if (!live(call)) continue;
    if (call.kind === "case") titles.add(call.title);
    else if (
      calls.some(
        (inner) =>
          inner.kind === "case" &&
          live(inner) &&
          inner.start > call.start &&
          inner.start < call.end,
      )
    ) {
      titles.add(call.title);
    }
  }
  return titles;
}

/** True when this cite is proved by a test file: a vitest file or an audit test. */
const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);

function commitExists(hash: string): boolean {
  try {
    return (
      execFileSync("git", ["cat-file", "-t", hash], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "commit"
    );
  } catch {
    return false;
  }
}

function checkCites(label: string, cites: Cite[]): number {
  let checked = 0;
  for (const cite of cites) {
    const path = join(REPO_ROOT, cite.file);
    expect(existsSync(path), `${label} ${cite.file}`).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text, `${label} ${cite.file} "${cite.quote}"`).toContain(cite.quote);
    if (isTestFile(cite.file)) {
      expect(
        liveTitles(text).has(cite.quote),
        `${label} ${cite.file} "${cite.quote}" is a live test title`,
      ).toBe(true);
    }
    checked += 1;
  }
  return checked;
}

const MITIGATED_STATUS = [
  "proved",
  "proved, residual noted",
  "proved, live contrast owed to the runner",
];
const ACCEPTED_STATUS = ["accepted", "accepted, confirmation pending: owner item 36"];

run("completeness and shape (Tests 1 and 2 of Task 2)", () => {
  it("has a row for exactly the declared threat ids, including the split and supply-chain ids", () => {
    const declared = planThreatIds();
    for (const id of ["T-08-SC", "T-08-11b", "T-08-22b", "T-08-30b", "T-08-55", "T-08-56"]) {
      expect(declared.has(id), id).toBe(true);
    }
    expect(declared.size).toBeGreaterThan(55);
    expect(new Set(rows().map((row) => row.id))).toEqual(declared);
    expect(rows().length).toBe(declared.size);
  });

  it("gives every row a disposition, an evidence kind, a file, a quoted title, commits and a status", () => {
    expect(rows().length).toBeGreaterThan(55);
    for (const row of rows()) {
      expect(["mitigate", "accept"], row.id).toContain(row.disposition);
      expect(["test", "gate", "lint", "document", "source scan", "measurement"], row.id).toContain(
        row.kind,
      );
      expect(row.cites.length, row.id).toBeGreaterThan(0);
      for (const cite of row.cites) {
        expect(cite.file, `${row.id} ${cite.file}`).not.toMatch(/^(\/|~|\.\.)/);
      }
      expect(row.cell, row.id).not.toMatch(/\b(TBD|TODO|unresolved|not built|untested)\b/i);
      expect(row.commits, row.id).toMatch(/[0-9a-f]{8}|this plan/);
      if (row.status.startsWith("OPEN")) continue;
      expect(
        row.disposition === "accept" ? ACCEPTED_STATUS : MITIGATED_STATUS,
        `${row.id} status`,
      ).toContain(row.status);
    }
  });

  it("agrees with the plan tables on which rows are accepted", () => {
    const accepted = new Set<string>();
    for (const file of planFiles()) {
      for (const match of readFileSync(join(dir, file), "utf8").matchAll(
        /^\| (T-08-[A-Za-z0-9]+) \|[^\n]*\| accept \|/gm,
      )) {
        accepted.add(match[1] as string);
      }
    }
    expect(accepted.has("T-08-09")).toBe(true);
    expect(accepted.has("T-08-SC")).toBe(true);
    expect(
      new Set(
        rows()
          .filter((r) => r.disposition === "accept")
          .map((r) => r.id),
      ),
    ).toEqual(accepted);
  });

  it("lists exactly the rows marked OPEN under Open threats, and leaves the pending owner item visible", () => {
    const open = rows()
      .filter((row) => row.status.startsWith("OPEN"))
      .map((row) => row.id);
    const sectionText = section(evidence, "Open threats");
    expect(sectionText.length).toBeGreaterThan(0);
    for (const id of open) expect(sectionText, id).toContain(id);
    if (open.length === 0) expect(sectionText).toMatch(/^None\./m);
    // T-08-09 is accepted with a confirmation only the owner can give: it must say so.
    const nine = rows().find((row) => row.id === "T-08-09");
    expect(nine?.status).toBe("accepted, confirmation pending: owner item 36");
    expect(nine?.cell).toContain("08-UAT.md");
  });
});

run("evidence is real (Tests 3 of Task 2)", () => {
  it("cites files that exist and contain the quoted text, and test files whose quoted title is live", () => {
    let checked = 0;
    for (const row of rows()) {
      if (row.id === "T-08-56") {
        // This test file is the evidence for its own row; it exists because this test is running.
        continue;
      }
      checked += checkCites(row.id, row.cites);
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("makes every mitigated row cite a test, a gate script or a lint, and every accepted row a record", () => {
    for (const row of rows().filter((r) => r.disposition === "mitigate")) {
      expect(
        row.cites.some((c) => isTestFile(c.file) || /^scripts\//.test(c.file)),
        row.id,
      ).toBe(true);
    }
    for (const row of rows().filter((r) => r.disposition === "accept")) {
      expect(
        row.cites.some((c) => /^(docs\/|\.planning\/)/.test(c.file) || c.file.endsWith(".json")),
        row.id,
      ).toBe(true);
    }
  });

  it("names commits that exist, for every row and for every fix round", () => {
    const header = evidence.split(/^\| Threat \|/m)[0] as string;
    const fixRounds = [...header.matchAll(/`([0-9a-f]{8})`/g)].map((m) => m[1] as string);
    expect(fixRounds.length).toBe(7);
    for (const hash of fixRounds) expect(commitExists(hash), `fix round ${hash}`).toBe(true);
    let checked = 0;
    for (const row of rows()) {
      for (const hash of row.commits.match(/\b[0-9a-f]{8}\b/g) ?? []) {
        expect(commitExists(hash), `${row.id} ${hash}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("covers every fix round: each fix commit named in the header is cited by at least one row", () => {
    // FIX1A to FIX4B each changed code a threat row depends on; a round nobody cites is a gap.
    const named = new Set(rows().flatMap((row) => row.commits.match(/\b[0-9a-f]{8}\b/g) ?? []));
    // One representative fix commit per round, measured from the git log of the phase.
    for (const [round, hash] of [
      ["FIX1A", "98ab52f5"],
      ["FIX1B", "b4b42b68"],
      ["FIX2A", "572597c2"],
      ["FIX2B", "f344d6ba"],
      ["FIX3A", "02477e6b"],
      ["FIX4A", "0369a40e"],
      ["FIX4B", "75e38e63"],
    ] as const) {
      expect(named.has(hash), `${round} ${hash}`).toBe(true);
    }
  });

  describe("liveTitles (control: the check can fail)", () => {
    const sample = [
      '// it("only in a comment", () => {});',
      'describe("a suite", () => {',
      '  it("a live case", () => {});',
      '  it.skip("a skipped case", () => {});',
      '  it.todo("a todo case");',
      "  it(",
      '    "a case with its title on the next line",',
      "    () => {},",
      "  );",
      "});",
      'describe.skip("a skipped suite", () => {',
      '  it("a case in a skipped suite", () => {});',
      "});",
      'describe("a suite with nothing live", () => {',
      '  it.skip("only a skipped case", () => {});',
      "});",
    ].join("\n");
    const titles = liveTitles(sample);

    it("accepts live cases, wrapped titles and suites that hold a live case", () => {
      for (const title of ["a suite", "a live case", "a case with its title on the next line"]) {
        expect(titles.has(title), title).toBe(true);
      }
    });

    it("refuses skipped and todo cases, a case inside a skipped suite and text that is not a title", () => {
      for (const title of [
        "only in a comment",
        "a skipped case",
        "a todo case",
        "a skipped suite",
        "a case in a skipped suite",
        "a suite with nothing live",
        "only a skipped case",
      ]) {
        expect(titles.has(title), title).toBe(false);
      }
    });
  });
});

run("bundle privacy trace (Test 4 of Task 2)", () => {
  const trace = section(evidence, "Bundle privacy trace");

  interface Step {
    readonly step: number;
    readonly file: string;
    readonly symbol: string;
    readonly what: string;
    readonly proofs: Cite[];
  }

  function steps(): Step[] {
    const out: Step[] = [];
    for (const line of trace.split("\n")) {
      const cells = cellsOf(line);
      if (!/^\d+$/.test(cells[1] ?? "")) continue;
      out.push({
        step: Number(cells[1]),
        file: (/`([^`]+)`/.exec(cells[2] ?? "")?.[1] ?? "") as string,
        symbol: (/`([^`]+)`/.exec(cells[3] ?? "")?.[1] ?? "") as string,
        what: cells[4] ?? "",
        proofs: citesOf(cells[5] ?? ""),
      });
    }
    return out;
  }

  it("lists, in order, the schema, the builder, the denylist, the verifier, the one serialisation, the block and the save", () => {
    const order = [
      "DiagnosticBundleSchema",
      "buildDiagnosticBundle",
      "buildDenylist",
      "verifyBundle",
      "serialiseBundle",
      "DiagnosticBundleBlock",
      "saveBundle",
    ];
    expect(steps().map((s) => s.symbol)).toEqual(order);
    expect(steps().map((s) => s.step)).toEqual(order.map((_, i) => i + 1));
  });

  it("names a real file and a real symbol in it for every step, and proves each with live tests", () => {
    for (const step of steps()) {
      const path = join(REPO_ROOT, step.file);
      expect(existsSync(path), `step ${step.step} ${step.file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `step ${step.step} ${step.symbol}`).toContain(step.symbol);
      expect(step.proofs.length, `step ${step.step}`).toBeGreaterThan(0);
      checkCites(`step ${step.step}`, step.proofs);
    }
  });

  it("states what the save step refuses and how, and the one-string rule", () => {
    const [save, serialise] = [steps()[6], steps()[4]];
    expect(save?.what).toMatch(/inside the vault/);
    expect(save?.what).toMatch(/identity/);
    expect(save?.what).toMatch(/0600/);
    expect(save?.what).toMatch(/never replaced/);
    expect(serialise?.what).toContain("verifyAndSerialise");
    expect(trace).toMatch(/only that string is\s+previewed, copied or saved/);
    // The save proofs include the firmlink identity check and the no-overwrite rule (D-12a).
    const proofs = (save?.proofs ?? []).map((p) => p.quote).join(" ");
    expect(proofs).toMatch(/firmlink/);
    expect(proofs).toMatch(/never overwrites/);
    expect(proofs).toMatch(/mode 0600/);
  });

  it("is backed by the code: the plugin writes only in export.ts and serialises only in the verifier", () => {
    const exportSource = readFileSync(
      join(REPO_ROOT, "packages/plugin/src/health/export.ts"),
      "utf8",
    );
    expect(exportSource).toMatch(/O_NOFOLLOW/);
    expect(exportSource).toMatch(/properties: \["createDirectory"\]/);
    const block = readFileSync(
      join(REPO_ROOT, "packages/plugin/src/view/diagnostics-bundle.tsx"),
      "utf8",
    );
    expect(block).not.toMatch(/JSON\.stringify|serialiseBundle/);
  });
});

run("probe safety (Test 5 of Task 2)", () => {
  const safety = section(evidence, "Probe safety");

  interface ProbeRow {
    readonly name: string;
    readonly file: string;
    readonly symbol: string;
    readonly calls: string;
    readonly cap: string;
    readonly proofs: Cite[];
  }

  function probeRows(): ProbeRow[] {
    const out: ProbeRow[] = [];
    for (const line of safety.split("\n")) {
      const cells = cellsOf(line);
      const file = /`([^`]+)`/.exec(cells[2] ?? "")?.[1];
      if (file === undefined || !/^packages\//.test(file)) continue;
      out.push({
        name: cells[1] ?? "",
        file,
        symbol: (/`([^`]+)`/.exec(cells[3] ?? "")?.[1] ?? "") as string,
        calls: cells[4] ?? "",
        cap: cells[5] ?? "",
        proofs: citesOf(cells[6] ?? ""),
      });
    }
    return out;
  }

  const byName = (symbol: string): ProbeRow | undefined =>
    probeRows().find((row) => row.symbol === symbol);

  it("lists hasSecret, probeBundle, isExecutableFile, the vault probe and refreshSettingsFacts, with their calls and caps", () => {
    const symbols = probeRows().map((r) => r.symbol);
    for (const symbol of [
      "hasSecret",
      "probeBundle",
      "isExecutableFile",
      "probeVault",
      "refreshSettingsFacts",
    ]) {
      expect(symbols, symbol).toContain(symbol);
    }
    for (const row of probeRows()) {
      expect(row.calls.length, row.symbol).toBeGreaterThan(20);
      expect(row.cap, row.symbol).toMatch(/\d/);
      const source = readFileSync(join(REPO_ROOT, row.file), "utf8");
      expect(source, `${row.file} holds ${row.symbol}`).toContain(row.symbol);
    }
  });

  it("proves every row with live tests", () => {
    let checked = 0;
    for (const row of probeRows()) {
      expect(row.proofs.length, row.symbol).toBeGreaterThan(0);
      checked += checkCites(row.symbol, row.proofs);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("states caps and argv that the code holds", () => {
    const keychain = readFileSync(join(REPO_ROOT, "packages/keychain/src/security-cli.ts"), "utf8");
    expect(byName("hasSecret")?.cap).toContain("1,500 ms");
    expect(keychain).toMatch(/HAS_SECRET_TIMEOUT_MS = 1500/);
    expect(byName("hasSecret")?.calls).toContain(
      "/usr/bin/security find-generic-password -a <account> -s com.claude-command-center",
    );
    expect(keychain).toMatch(/\["find-generic-password", "-a", account, "-s", SERVICE_NAME\]/);
    // The presence check's own body never asks for the value (-w) or the password (-g).
    const start = keychain.indexOf("export async function hasSecret");
    expect(start).toBeGreaterThan(-1);
    const next = keychain.indexOf("\nexport ", start + 10);
    const presence = keychain.slice(start, next === -1 ? undefined : next);
    expect(presence).toContain("find-generic-password");
    expect(presence).not.toMatch(/"-w"|"-g"/);

    const detection = readFileSync(
      join(REPO_ROOT, "packages/service/src/projects/detection.ts"),
      "utf8",
    );
    expect(byName("probeBundle")?.cap).toContain("1,100 ms");
    expect(byName("probeBundle")?.cap).toContain("400 ms");
    expect(detection).toMatch(/PROBE_MDFIND_TIMEOUT_MS = 1100/);
    expect(detection).toMatch(/PROBE_PLUTIL_TIMEOUT_MS = 400/);
    expect(detection).toContain('"/usr/bin/mdfind"');
    expect(detection).toContain('"/usr/bin/plutil"');

    const runProbes = readFileSync(
      join(REPO_ROOT, "packages/service/src/diagnostics/run-probes.ts"),
      "utf8",
    );
    expect(byName("runProbes")?.cap).toContain("2 s per probe, 5 s overall");
    expect(runProbes).toMatch(/PER_PROBE_CAP_MS = 2000/);
    expect(runProbes).toMatch(/OVERALL_CAP_MS = 5000/);
    expect(runProbes).toMatch(/HEALTH_CACHE_TTL_MS = 2000/);

    const status = readFileSync(
      join(REPO_ROOT, "packages/service/src/claude/integration-status.ts"),
      "utf8",
    );
    expect(byName("refreshSettingsFacts")?.cap).toContain("1 MiB");
    expect(byName("refreshSettingsFacts")?.cap).toContain("64 KiB");
    expect(status).toMatch(/MAX_SETTINGS_BYTES = 1024 \* 1024/);
    expect(status).toMatch(/MAX_INSTALL_RECORD_BYTES = 64 \* 1024/);

    const launchers = readFileSync(
      join(REPO_ROOT, "packages/service/src/projects/terminal-launchers.ts"),
      "utf8",
    );
    expect(launchers).toMatch(/await access\(path, constants\.X_OK\)/);
    expect(launchers).toMatch(/info\.isFile\(\)/);
  });

  it("names the diagnostics backstop rule, its script and its source scan, and the rule exists", () => {
    expect(safety).toContain("backstop rule 18");
    expect(safety).toContain("scripts/check-boundaries.sh");
    expect(safety).toContain("diagnostics-source-scan.audit.test.ts");
    const script = readFileSync(join(REPO_ROOT, "scripts", "check-boundaries.sh"), "utf8");
    expect(script).toMatch(
      /# --- Rule 18: no non-test file under packages\/service\/src\/diagnostics\//,
    );
    expect(
      existsSync(
        join(REPO_ROOT, "packages/service/src/diagnostics/diagnostics-source-scan.audit.test.ts"),
      ),
    ).toBe(true);
  });
});
