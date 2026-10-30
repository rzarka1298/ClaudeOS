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
    for (const name of [
      "08-THREAT-EVIDENCE.md",
      "08-UAT.md",
      "08-MERGE-GATES.md",
      "08-VALIDATION.md",
      "08-UAT-AUDIT.md",
    ]) {
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

// ---------------------------------------------------------------------------------------------
// Task 3: the merge-gate runbook, the validation map and the regenerated audit

const gates = read("08-MERGE-GATES.md");
const validation = read("08-VALIDATION.md");
const audit = read("08-UAT-AUDIT.md");

function packageScripts(path: string): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
}

/** The spec file base names a spec map declares, read as text (the e2e package is a leaf). */
function specNames(mapFile: string): string[] {
  const source = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", mapFile), "utf8");
  return [...source.matchAll(/specPath\("([a-z0-9-]+)"\)/g)].map((m) => m[1] as string);
}

/** The `--spec` base names on the one runbook line that runs the given phase script. */
function runLineSpecs(phase: "07" | "08"): string[] {
  const line = gates
    .split("\n")
    .find((l) => l.includes("packages/e2e/dist/cli.js run") && l.includes(`${phase}-UAT.md`));
  expect(line, `the run command for phase ${phase}`).toBeDefined();
  return [
    ...(line as string).matchAll(/--spec "\$PWD\/packages\/e2e\/specs\/([a-z0-9-]+)\.e2e\.ts"/g),
  ].map((m) => m[1] as string);
}

run("merge-gate runbook (Task 3, Tests 1 to 3)", () => {
  const ORDER = [
    "Post-wave gates",
    "Full unfiltered test run",
    "Next-free value re-checks",
    "Container visual comparison",
    "SLICE-02 audit",
    "Automated runs at the same final head",
    "Look verdicts",
    "Report and ratification",
    "Judge panel",
    "Codex blocking judge",
    "Owner sitting",
    "Strict audit after the sitting",
    "Merge and publish",
    "Closing checklist",
  ];

  it("orders the sections as the plan requires", () => {
    const positions = ORDER.map((title, index) => gates.indexOf(`## ${index + 1}. ${title}`));
    for (const [index, position] of positions.entries()) {
      expect(position, ORDER[index]).toBeGreaterThan(-1);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("makes both automated runs at one clean head after the last product commit, with separate --spec lists", () => {
    const shared = section(gates, "6\\. Automated runs at the same final head");
    expect(shared).toMatch(/same final head/);
    expect(shared).toMatch(/after the last product commit/);
    expect(shared).toMatch(/baselines/);
    expect(shared).toMatch(/clean/);
    expect(shared).toMatch(/staleness/i);
    expect(shared).toContain("packages/e2e/src/staleness.ts");
    expect(existsSync(join(REPO_ROOT, "packages/e2e/src/staleness.ts"))).toBe(true);
    // Phase 7's four research specs and Phase 8's five, each list the map declares, no overlap.
    const seven = runLineSpecs("07");
    const eight = runLineSpecs("08");
    expect([...seven].sort()).toEqual([...specNames("spec-map-07.ts")].sort());
    expect([...eight].sort()).toEqual([...specNames("spec-map-08.ts")].sort());
    expect(seven).toHaveLength(4);
    expect(eight).toHaveLength(5);
    expect(seven.filter((name) => eight.includes(name))).toEqual([]);
    for (const name of [...seven, ...eight]) {
      expect(existsSync(join(REPO_ROOT, "packages", "e2e", "specs", `${name}.e2e.ts`)), name).toBe(
        true,
      );
    }
    // Each run has its own screenshots folder and its own report.
    expect(gates).toContain("ccc-phase7-shots");
    expect(gates).toContain("ccc-phase8-shots");
    expect(gates).toContain("07-UAT-AUTO-REPORT.md");
    expect(gates).toContain("08-UAT-AUTO-REPORT.md");
  });

  it("names only commands, scripts, runner subcommands and flags that exist", () => {
    const scripts = packageScripts("package.json");
    const e2eScripts = packageScripts("packages/e2e/package.json");
    let checked = 0;
    for (const match of gates.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      expect(scripts[match[1] as string], match[0]).toBeDefined();
      checked += 1;
    }
    for (const match of gates.matchAll(/pnpm --filter @ccc\/e2e run ([a-z][a-z0-9:-]*)/g)) {
      expect(e2eScripts[match[1] as string], match[0]).toBeDefined();
      checked += 1;
    }
    for (const match of gates.matchAll(/\b(?:sh|node) (scripts\/[A-Za-z0-9_./-]+)/g)) {
      expect(existsSync(join(REPO_ROOT, match[1] as string)), match[0]).toBe(true);
      checked += 1;
    }
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    for (const match of gates.matchAll(/turbo run ((?:[a-z:]+ ?)+?)(?= --|`|$| &&)/gm)) {
      for (const task of (match[1] as string).trim().split(/\s+/)) {
        expect(turbo.tasks[task], `turbo task ${task}`).toBeDefined();
        checked += 1;
      }
    }
    const cli = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", "cli.ts"), "utf8");
    const cliArgs = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", "cli-args.ts"), "utf8");
    const knownFlag = (name: string): boolean =>
      cliArgs.includes(`"${name}"`) || new RegExp(`\\b${name}: \\{ type:`).test(cliArgs);
    for (const line of gates.split("\n").filter((l) => l.includes("packages/e2e/dist/cli.js"))) {
      const command = /packages\/e2e\/dist\/cli\.js ([a-z-]+)/.exec(line)?.[1] as string;
      const key = command.includes("-") ? `"${command}"` : command;
      expect(cli, `runner command ${command}`).toContain(key);
      if (command === "look") {
        const sub = /cli\.js look (list|record)\b/.exec(line)?.[1] as string;
        expect(cliArgs, `look ${sub}`).toContain(`look ${sub}`);
      }
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(knownFlag(flag.slice(2)), `${command} ${flag}`).toBe(true);
        checked += 1;
      }
    }
    // The audit is run as `pnpm run uat:audit` and `pnpm run uat:audit --strict`; its flags are the
    // runner's own audit flags, and a `--` before the flag is a usage error (shown in the text).
    for (const line of gates.split("\n").filter((l) => /pnpm run uat:audit/.test(l))) {
      for (const flag of line.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
        expect(knownFlag(flag.slice(2)), `uat:audit ${flag}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("names every gate the final run of this plan uses", () => {
    for (const gate of [
      "ci:format",
      "ci:lint",
      "ci:boundaries",
      "ci:backstop",
      "ci:obsidianmd",
      "ci:privacy",
      "ci:images",
      "ci:typecheck",
    ]) {
      expect(gates, gate).toContain(`pnpm run ${gate}`);
    }
    expect(gates).toContain("sh scripts/ci/visual-in-container.sh");
    expect(gates).toContain("pnpm run uat:audit");
  });

  it("states the policies the plan requires", () => {
    expect(gates).toMatch(/full unfiltered run is the post-merge gate/);
    expect(gates).toMatch(/live owner items must be recorded before phase closure/);
    expect(gates).toMatch(/never used to execute plans marked high risk/i);
    expect(gates).toMatch(/80 percent of the weekly allowance/);
    expect(gates).toMatch(/blind dual review and debate/);
    expect(gates).toMatch(/accept auto-results of run/);
    expect(gates).toMatch(/OD-6/);
    expect(gates).toMatch(/Phase 7 items 22 to 24/);
    expect(gates).toMatch(/Phase 8 owner items 34 to 39/);
    for (const judge of [
      "gsd-verifier",
      "code-review",
      "prd-compliance-review",
      "gsd-security-auditor",
    ]) {
      expect(gates, judge).toContain(judge);
    }
    expect(gates).toContain("08-THREAT-EVIDENCE.md");
    expect(gates).toContain("08-UAT-AUTO-REPORT.md");
    expect(gates).toContain("08-UAT-AUDIT.md");
    expect(gates).toContain("ADR 0031");
    // The audit with the strict flag runs after the owner sitting, in the form that works.
    expect(gates).toMatch(/pnpm run uat:audit --strict/);
    expect(gates).toMatch(/uat:audit -- --strict/);
    expect(gates).toMatch(/usage error/);
    const strict = section(gates, "12\\. Strict audit after the sitting");
    expect(strict).toMatch(/pnpm run uat:audit --strict/);
    expect(strict).toMatch(/OD-7/);
    expect(strict).toMatch(/OD-8/);
    // Next-free values: this phase added ADR 0031 and backstop rule 18 and no migration.
    const nextFree = section(gates, "3\\. Next-free value re-checks");
    expect(nextFree).toMatch(/0031/);
    expect(nextFree).toMatch(/rule 18/);
    expect(nextFree).toMatch(/no migration/);
  });

  it("lists the high-risk plans by reading each plan's front matter, and Codex never executes them", () => {
    const high = planFiles()
      .filter((name) => /^risk: high$/m.test(readFileSync(join(dir, name), "utf8")))
      .map((name) => name.slice(0, 5));
    expect(high.length).toBeGreaterThan(0);
    const listed = /High-risk plans[^:]*: ([^\n]+)/.exec(gates)?.[1] ?? "";
    for (const plan of high) expect(listed, plan).toContain(plan);
    const named = [...listed.matchAll(/08-\d\d/g)].map((m) => m[0]);
    expect(named.sort()).toEqual([...high].sort());
    for (const name of planFiles()) {
      expect(readFileSync(join(dir, name), "utf8"), name).toMatch(/^\s*codex_execute: never$/m);
    }
  });

  it("gives the closing checklist its owner, audit, evidence, validation and service lines", () => {
    const closing = section(gates, "14\\. Closing checklist");
    for (const word of [
      "08-UAT.md",
      "07-UAT.md",
      "08-UAT-AUDIT.md",
      "08-THREAT-EVIDENCE.md",
      "08-VALIDATION.md",
      "service restored",
      "SLICE-01",
      "SLICE-02",
      "DIAG-04",
    ]) {
      expect(closing, word).toContain(word);
    }
    expect(closing.match(/^- \[ \]/gm)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});

run("validation map (Task 3, Test 4)", () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(validation)?.[1] ?? "";
  const mapSection = section(validation, "Per-Task Verification Map");

  interface MapRow {
    readonly plan: string;
    readonly task: number;
    readonly commands: string[];
    readonly exists: string;
    readonly status: string;
  }

  function mapRows(): MapRow[] {
    const out: MapRow[] = [];
    for (const line of mapSection.split("\n")) {
      const cells = cellsOf(line);
      const id = /^(08-\d\d)-T(\d+)$/.exec(cells[1] ?? "");
      if (id === null) continue;
      out.push({
        plan: id[1] as string,
        task: Number(id[2]),
        commands: [...(cells[8] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
        exists: cells[9] ?? "",
        status: cells[10] ?? "",
      });
    }
    return out;
  }

  const GREEN = "✅ green";
  const MERGE_GATE = "⬜ merge gate";

  /** Test files a command names under `--filter @ccc/<pkg> exec vitest run ...` that do not exist. */
  function missingFiles(commands: string[]): string[] {
    const missing: string[] = [];
    for (const command of commands) {
      for (const match of command.matchAll(
        /--filter @ccc\/([a-z0-9-]+) exec vitest run ([^&;]*)/g,
      )) {
        for (const path of (match[2] as string)
          .split(/\s+/)
          .filter((p) => /\.test\.tsx?$/.test(p))) {
          if (!existsSync(join(REPO_ROOT, "packages", match[1] as string, path)))
            missing.push(path);
        }
      }
    }
    return missing;
  }

  it("has one row per task of every 08-NN plan, with a command, an existing file and a status", () => {
    const rows = mapRows();
    for (const file of planFiles()) {
      const plan = file.slice(0, 5);
      const tasks = (readFileSync(join(dir, file), "utf8").match(/^\s*<task type=/gm) ?? []).length;
      expect(tasks, plan).toBeGreaterThan(0);
      const mine = rows.filter((row) => row.plan === plan);
      expect(
        mine.map((row) => row.task),
        plan,
      ).toEqual(Array.from({ length: tasks }, (_, i) => i + 1));
    }
    expect(rows.length).toBe(69);
    for (const row of rows) {
      expect(row.commands.length, `${row.plan} T${row.task}`).toBeGreaterThan(0);
      expect([GREEN, MERGE_GATE], `${row.plan} T${row.task}`).toContain(row.status);
      expect(row.exists, `${row.plan} T${row.task}`).toContain("✅");
    }
  });

  it("carries each task's first automated command from its plan, and only the container compare is a merge gate", () => {
    const rows = mapRows();
    const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
    for (const file of planFiles()) {
      const plan = file.slice(0, 5);
      const blocks = [
        ...readFileSync(join(dir, file), "utf8").matchAll(/<task type=[^>]*>([\s\S]*?)<\/task>/g),
      ];
      for (const [index, block] of blocks.entries()) {
        const planned = [
          ...(block[1] as string).matchAll(/<automated>([\s\S]*?)<\/automated>/g),
        ].map((m) => flat(m[1] as string));
        const row = rows.find((r) => r.plan === plan && r.task === index + 1);
        expect(planned.length, `${plan} T${index + 1}`).toBeGreaterThan(0);
        expect(
          (row?.commands ?? []).map((c) => flat(c)),
          `${plan} T${index + 1}`,
        ).toContain(planned[0]);
      }
    }
    const open = rows.filter((row) => row.status !== GREEN);
    expect(open.map((row) => `${row.plan}-T${row.task}`)).toEqual(["08-21-T3"]);
    for (const row of open) expect(row.commands.join(" ")).toContain("visual-in-container");
  });

  it("names only test files that exist in the package the command filters to", () => {
    let checked = 0;
    for (const row of mapRows()) {
      expect(missingFiles(row.commands), `${row.plan} T${row.task}`).toEqual([]);
      for (const command of row.commands) {
        checked += [...command.matchAll(/--filter @ccc\/([a-z0-9-]+) exec vitest run ([^&;]*)/g)]
          .length;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("sets nyquist_compliant and wave_0_complete true only when no row is MISSING", () => {
    const missing =
      mapRows().some(
        (row) => missingFiles(row.commands).length > 0 || /MISSING/.test(row.status),
      ) || /\bMISSING\b/.test(section(validation, "Wave 0 Requirements"));
    const nyquist = /^nyquist_compliant: (true|false)$/m.exec(front)?.[1];
    const wave0 = /^wave_0_complete: (true|false)$/m.exec(front)?.[1];
    expect(["true", "false"]).toContain(nyquist);
    expect(["true", "false"]).toContain(wave0);
    expect(nyquist).toBe(missing ? "false" : "true");
    expect(wave0).toBe(missing ? "false" : "true");
  });

  it("fills the Wave 0 table with files that exist", () => {
    const wave0 = section(validation, "Wave 0 Requirements");
    const rows = wave0.split("\n").filter((line) => /^\| W0-\d/.test(line));
    expect(rows.length).toBe(23);
    const paths = [...wave0.matchAll(/`((?:packages|scripts|docs|\.planning)\/[^`\s]+)`/g)].map(
      (m) => m[1],
    );
    expect(paths.length).toBeGreaterThan(60);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
    for (const row of rows) expect(row, row).toMatch(/✅ filled/);
  });

  it("keeps the sign-off honest: the container compare row and the final-head runs are named", () => {
    const signOff = section(validation, "Validation Sign-Off");
    expect(signOff).toContain("08-MERGE-GATES.md");
    expect(signOff).toMatch(/container compare/i);
    expect(validation).toMatch(/Validated at head [0-9a-f]{8}/);
    const head = /Validated at head ([0-9a-f]{8})/.exec(validation)?.[1] as string;
    expect(commitExists(head), head).toBe(true);
  });
});

/** The exceptions and phase rows of an audit record, read from its tables. */
function auditTables(text: string): {
  readonly phases: { phase: string; status: string }[];
  readonly exceptions: string[][];
} {
  const phases: { phase: string; status: string }[] = [];
  for (const line of section(text, "Phases").split("\n")) {
    const cells = cellsOf(line);
    if (/^\d\d(\.\d)?$/.test(cells[1] ?? "")) {
      phases.push({ phase: cells[1] as string, status: cells[4] ?? "" });
    }
  }
  const exceptions = section(text, "Exceptions")
    .split("\n")
    .map(cellsOf)
    .filter((cells) => /^\d\d(\.\d)?-/.test(cells[1] ?? ""));
  return { phases, exceptions };
}

/** Exactly a date, or `accepted <date>`: the audit's own reading of a dated acceptance. */
const DATED = /^(?:accepted )?\d{4}-\d{2}-\d{2}$/;

/**
 * What an audit record's exception and strict-clean claims must satisfy (FIX12 C2). The nine
 * historical OD-7 exceptions (phases 01 to 08) are validated apart from Phase 9's: Phase 9 may add
 * only `09-uat-17`, the owner's "accepted - not walked" decision on item 17, which is a pending
 * exception until the owner dates it and holds `strict-clean: false` until then. Returns one short
 * sentence per problem; an empty list means the record is consistent.
 */
function auditExceptionProblems(text: string): string[] {
  const problems: string[] = [];
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const num = (key: string): number => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(front)?.[1]);
  const { phases, exceptions } = auditTables(text);
  const closed = ["07", "08"].every((phase) =>
    (phases.find((row) => row.phase === phase)?.status ?? "").startsWith("recorded"),
  );
  const historical = exceptions.filter((cells) => /^0[1-8](\.\d)?-/.test(cells[1] ?? ""));
  const ninth = exceptions.filter((cells) => /^09-/.test(cells[1] ?? ""));
  if (historical.length + ninth.length !== exceptions.length) {
    problems.push("an exception belongs to neither the historical phases nor Phase 9");
  }
  if (exceptions.length !== num("exceptions")) {
    problems.push("the exceptions count differs from the table");
  }
  if (historical.length !== 9) problems.push("the historical exceptions are not the nine");
  for (const cells of ninth) {
    if (cells[1] !== "09-uat-17") problems.push(`unexpected Phase 9 exception ${cells[1]}`);
  }
  for (const cells of exceptions) {
    if (cells[4] !== "OD-7") problems.push(`${cells[1]}: the pointer is not OD-7`);
    const acceptance = cells[5] ?? "";
    const historic = historical.includes(cells);
    if (historic && closed) {
      if (!/\d{4}-\d{2}-\d{2}/.test(acceptance)) problems.push(`${cells[1]}: not dated`);
    } else if (acceptance !== "pending" && !DATED.test(acceptance)) {
      problems.push(`${cells[1]}: neither pending nor a dated acceptance`);
    }
  }
  const dated = exceptions.filter((cells) => DATED.test(cells[5] ?? "")).length;
  if (num("exceptions-accepted") !== dated) {
    problems.push("exceptions-accepted differs from the dated acceptances");
  }
  // strict-clean (D-29): no phase pending the live UAT and every exception dated.
  const pendingPhase = phases.some((row) => row.status === "pending-live-uat");
  const strictClean = !pendingPhase && dated === exceptions.length;
  const claimed = /^strict-clean: (true|false)$/m.exec(front)?.[1];
  if (claimed !== String(strictClean)) {
    problems.push("the strict-clean flag disagrees with the phase states and acceptances");
  }
  return problems;
}

run("regenerated SLICE-02 audit (Task 3, Test 5)", () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(audit)?.[1] ?? "";
  const num = (key: string): number => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(front)?.[1]);
  // Closed once Phases 07 and 08 are recorded. A later phase (Phase 9 joined the audit table in plan
  // 09-21) may still be pending in the same record, so `strict-clean` is not the test of this.
  const closed = ["07", "08"].every((phase) =>
    (phaseRows().find((row) => row.phase === phase)?.status ?? "").startsWith("recorded"),
  );

  interface PhaseRow {
    readonly phase: string;
    readonly recorded: string;
    readonly status: string;
  }

  function phaseRows(): PhaseRow[] {
    const out: PhaseRow[] = [];
    for (const line of section(audit, "Phases").split("\n")) {
      const cells = cellsOf(line);
      if (!/^\d\d(\.\d)?$/.test(cells[1] ?? "")) continue;
      out.push({ phase: cells[1] as string, recorded: cells[3] ?? "", status: cells[4] ?? "" });
    }
    return out;
  }

  it("covers the ten milestone phases and agrees with the Phase 8 script's item count", () => {
    // Ten milestone phases; Phase 9 joined the table in plan 09-21 as an eleventh row.
    const phases = phaseRows().map((r) => r.phase);
    expect(phases.slice(0, 10)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "05.1",
      "05.2",
      "06",
      "07",
      "08",
    ]);
    expect([10, 11]).toContain(phases.length);
    if (phases.length === 11) expect(phases[10]).toBe("09");
    expect(num("phases")).toBe(phases.length);
    expect(num("not-recorded")).toBe(0);
    const total = Number(/^total: (\d+)$/m.exec(section(read("08-UAT.md"), "Summary"))?.[1]);
    expect(total).toBe(39);
    expect(
      phaseRows()
        .find((r) => r.phase === "08")
        ?.recorded.endsWith(`/${total}`),
    ).toBe(true);
    expect(
      phaseRows()
        .find((r) => r.phase === "07")
        ?.recorded.endsWith("/24"),
    ).toBe(true);
  });

  it("records phases 01 to 06 as recorded or recorded with exceptions, and 07 and 08 as pending the live UAT", () => {
    for (const row of phaseRows().filter((r) => !["07", "08", "09"].includes(r.phase))) {
      expect(["recorded", "recorded-with-exceptions"], row.phase).toContain(row.status);
    }
    for (const phase of ["07", "08"]) {
      const row = phaseRows().find((r) => r.phase === phase);
      if (closed) expect(["recorded", "recorded-with-exceptions"], phase).toContain(row?.status);
      else {
        expect(row?.status, phase).toBe("pending-live-uat");
        // Ratified automated results count before the owner's sitting; the total never changes.
        expect(row?.recorded, phase).toMatch(phase === "07" ? /^\d+\/24$/ : /^\d+\/39$/);
      }
    }
    if (!closed) expect(num("pending-live-uat")).toBe(2);
    expect(num("recorded") + num("recorded-with-exceptions") + num("pending-live-uat")).toBe(
      num("phases"),
    );
  });

  it("lists the OD-7 exceptions awaiting the owner, and settles them only with a date once closed", () => {
    expect(auditExceptionProblems(audit)).toEqual([]);
    const exceptions = auditTables(audit).exceptions.filter((cells) =>
      /^0[1-8](\.\d)?-/.test(cells[1] ?? ""),
    );
    expect(exceptions.length).toBe(9);
    for (const cells of exceptions) {
      expect(cells[4], cells[1]).toBe("OD-7");
      if (closed) expect(cells[5], cells[1]).toMatch(/\d{4}-\d{2}-\d{2}/);
      else expect(cells[5], cells[1]).toBe("pending");
    }
    if (!closed) expect(num("exceptions-accepted")).toBe(0);
  });

  // The audit regenerated after the owner records item 17 as `accepted - not walked` gains the tenth
  // exception `09-uat-17` and a Phase 09 row (FIX12 C2). Built in memory from the committed record;
  // no regenerated audit is committed.
  describe("a record regenerated with Phase 9's own exception (FIX12 C2)", () => {
    // The record as it stood with the nine historical exceptions only, whether or not the committed
    // copy already holds Phase 9's row and exception.
    const historicalOnly = audit.replace(/^\| 09(?:-uat-\d+)? \|.*\n/gm, "");
    const insertRow = (text: string, acceptance: string): string =>
      text.replace(
        /(\| 06-claude-ratified \|.*\|)\n/,
        `$1\n| 09-uat-17 | 09 | Item 17 recorded as not walked | OD-7 | ${acceptance} |\n`,
      );
    // The counts of a regenerated record are derived from its own table, as the audit derives them,
    // so a fixture is consistent whatever the committed record already holds.
    const withCounts = (text: string): string => {
      const { exceptions } = auditTables(text);
      const dated = exceptions.filter((cells) =>
        /^(?:accepted )?\d{4}-\d{2}-\d{2}$/.test(cells[5] ?? ""),
      ).length;
      return text
        .replace(/^exceptions: \d+$/m, `exceptions: ${exceptions.length}`)
        .replace(/^exceptions-accepted: \d+$/m, `exceptions-accepted: ${dated}`);
    };
    const regenerated = (acceptance: string, strictClean: string, phaseStatus: string): string =>
      withCounts(
        insertRow(
          historicalOnly
            .replace(/^phases: \d+$/m, "phases: 11")
            .replace(/^exceptions: \d+$/m, "exceptions: 10")
            .replace(/^strict-clean: \w+$/m, `strict-clean: ${strictClean}`)
            .replace(
              /^(\| 08 \|.*)$/m,
              `$1\n| 09 | 1 file(s) | 18/19 | ${phaseStatus} | 09-x/09-UAT.md |`,
            ),
          acceptance,
        ),
      );

    it("accepts the tenth exception pending, with Phase 9 pending and strict-clean false", () => {
      const text = regenerated("pending", "false", "pending-live-uat");
      expect(text).toContain("| 09-uat-17 |");
      expect(text).toMatch(/^exceptions-accepted: 9$/m);
      expect(auditExceptionProblems(text)).toEqual([]);
    });

    it("accepts it dated once the owner accepts it and Phase 9 is recorded, with strict-clean true", () => {
      const text = regenerated("accepted 2026-11-02", "true", "recorded-with-exceptions");
      expect(text).toMatch(/^exceptions-accepted: 10$/m);
      expect(auditExceptionProblems(text)).toEqual([]);
    });

    it("refuses any other Phase 9 exception and a flag that disagrees with the states", () => {
      const other = regenerated("pending", "false", "pending-live-uat").replace(
        "09-uat-17",
        "09-uat-3",
      );
      expect(auditExceptionProblems(other).join(" ")).toMatch(/unexpected Phase 9 exception/);
      const flag = regenerated("pending", "true", "pending-live-uat");
      expect(auditExceptionProblems(flag).join(" ")).toMatch(/strict-clean/);
      const undated = regenerated("pending", "true", "recorded-with-exceptions");
      expect(auditExceptionProblems(undated).join(" ")).toMatch(/strict-clean/);
    });

    it("keeps the nine historical exceptions at nine", () => {
      const lost = audit.replace(/^\| 05-uat-6 \|.*\n/m, "");
      expect(auditExceptionProblems(lost).join(" ")).toMatch(/nine|count/);
    });
  });

  it("preserves the D-47 amendment and the owner's statement block", () => {
    const amendments = section(audit, "Amendments");
    expect(amendments).toContain("07-UAT item 20");
    expect(amendments).toContain("D-47");
    expect(amendments).toContain("08-19");
    const statement = section(audit, "Milestone statement");
    expect(statement).toMatch(/OD-7/);
    expect(statement).toMatch(/OD-8/);
    expect(statement).toMatch(/Agents never fill this block/);
    if (!closed) expect(statement.match(/: pending$/gm)?.length).toBe(2);
    // The owner region runs from the Amendments heading to the end of the file.
    expect(audit.indexOf("## Amendments")).toBeGreaterThan(audit.indexOf("## Defects"));
    expect(audit.indexOf("## Milestone statement")).toBeGreaterThan(audit.indexOf("## Amendments"));
  });

  it("records a head that exists and a generation date", () => {
    const head = /^git-head: ([0-9a-f]{40})$/m.exec(front)?.[1] as string;
    expect(commitExists(head), head).toBe(true);
    expect(front).toMatch(/^generated: \d{4}-\d{2}-\d{2}$/m);
  });
});
