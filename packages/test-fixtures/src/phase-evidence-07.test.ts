import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 07-18 Tasks 2 and 3 (T-07-48): keeps the Phase 7 threat-evidence record, its summariser
 * call-path trace (success criterion 4), its security scan inputs, the merge-gate runbook and the
 * validation map true to the repository. These are private planning artifacts: a public clone has
 * no `.planning/` and reports that once. A claim that cites a file or a test title that no longer
 * exists fails here, so a stale proof cannot give the security judge false assurance.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const planned = existsSync(PLANNING_INDEX);
const phasesDir = join(REPO_ROOT, ".planning", "phases");
const phaseName = existsSync(phasesDir)
  ? readdirSync(phasesDir).find((entry) => entry.startsWith("07-"))
  : undefined;
const dir = phaseName === undefined ? "" : join(phasesDir, phaseName);
const read = (name: string): string =>
  planned && existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
const evidence = read("07-THREAT-EVIDENCE.md");
const gates = read("07-MERGE-GATES.md");
const validation = read("07-VALIDATION.md");

const run = planned ? describe : describe.skip;

describe("guard (Test 1)", () => {
  it("finds the documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(phaseName, "the phase directory").toBeDefined();
    for (const name of [
      "07-THREAT-EVIDENCE.md",
      "07-UAT.md",
      "07-MERGE-GATES.md",
      "07-VALIDATION.md",
    ]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function planFiles(): string[] {
  return readdirSync(dir).filter((name) => /^07-\d\d-PLAN\.md$/.test(name));
}

function planThreatIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of planFiles()) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /^\| (T-07-[A-Z0-9]+) \|/gm,
    )) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

interface Row {
  readonly id: string;
  readonly disposition: string;
  readonly kind: string;
  readonly cell: string;
  readonly cites: { file: string; quote: string }[];
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const line of evidence.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (!/^T-07-[A-Z0-9]+$/.test(cells[1] ?? "")) continue;
    const cell = cells[5] ?? "";
    out.push({
      id: cells[1] as string,
      disposition: cells[3] ?? "",
      kind: cells[4] ?? "",
      cell,
      cites: [...cell.matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map((m) => ({
        file: m[1] as string,
        quote: m[2] as string,
      })),
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

run("completeness and shape (Tests 1 and 2 of Task 2)", () => {
  it("has a row for exactly the declared threat ids, including the supply-chain and provenance ids", () => {
    const declared = planThreatIds();
    expect(declared.has("T-07-SC")).toBe(true);
    expect(declared.has("T-07-F6")).toBe(true);
    expect(declared.size).toBeGreaterThan(40);
    expect(new Set(rows().map((row) => row.id))).toEqual(declared);
    expect(rows().length).toBe(declared.size);
  });

  it("gives every row a disposition, an evidence kind, a file and a quoted title, and leaves none open", () => {
    expect(rows().length).toBeGreaterThan(40);
    for (const row of rows()) {
      expect(["mitigate", "accept", "transfer"], row.id).toContain(row.disposition);
      expect(["test", "gate", "lint", "document", "source scan", "measurement"], row.id).toContain(
        row.kind,
      );
      expect(row.cites.length, row.id).toBeGreaterThan(0);
      expect(row.cell, row.id).not.toMatch(/\b(TBD|TODO|unresolved|not built|untested)\b/i);
    }
  });
});

run("evidence is real (Tests 3 and 4)", () => {
  it("cites files that exist and contain the quoted text", () => {
    let checked = 0;
    for (const row of rows()) {
      for (const cite of row.cites) {
        const path = join(REPO_ROOT, cite.file);
        expect(existsSync(path), `${row.id} ${cite.file}`).toBe(true);
        expect(readFileSync(path, "utf8"), `${row.id} ${cite.file}`).toContain(cite.quote);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("cites, in every test file, a title that is a live test or a describe that holds one (07-FIX7)", () => {
    let checked = 0;
    for (const row of rows()) {
      for (const cite of row.cites) {
        if (!/\.test\.tsx?$/.test(cite.file)) continue;
        const titles = liveTitles(readFileSync(join(REPO_ROOT, cite.file), "utf8"));
        expect(titles.has(cite.quote), `${row.id} ${cite.file} "${cite.quote}"`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("names a specific test for the three rows that used to cite only the whole gate (T-07-01, 43, 47)", () => {
    for (const id of ["T-07-01", "T-07-43", "T-07-47"]) {
      const row = rows().find((r) => r.id === id);
      const privacy = (row?.cites ?? []).filter((c) => c.file.endsWith("check-privacy.test.ts"));
      expect(privacy.length, id).toBeGreaterThan(0);
      for (const cite of privacy) expect(cite.quote, id).not.toBe("check-privacy");
    }
  });

  describe("liveTitles (control: the check can fail)", () => {
    const sample = [
      '// it("only in a comment", () => {});',
      'describe("a suite", () => {',
      '  it("a live case", () => {});',
      '  it.skip("a skipped case", () => {});',
      '  it.todo("a todo case");',
      '  it.skipIf(process.platform === "none")("a conditional case", () => {});',
      "  it(",
      '    "a case with its title on the next line",',
      "    () => {},",
      "  );",
      "  const note = \"it('a string, not a call')\";",
      "});",
      'describe.skip("a skipped suite", () => {',
      '  it("a case in a skipped suite", () => {});',
      "});",
      'describe("a suite with nothing live", () => {',
      '  it.skip("only a skipped case", () => {});',
      "});",
      'describe("a suite with a brace in a string", () => {',
      '  it("a case after the brace", () => { const x = "}"; });',
      "});",
    ].join("\n");
    const titles = liveTitles(sample);

    it("accepts live cases, conditionally skipped cases, wrapped titles and suites that hold a live case", () => {
      for (const title of [
        "a suite",
        "a live case",
        "a conditional case",
        "a case with its title on the next line",
        "a suite with a brace in a string",
        "a case after the brace",
      ]) {
        expect(titles.has(title), title).toBe(true);
      }
    });

    it("refuses skipped and todo cases, a case inside a skipped suite, a suite with nothing live and text that is not a title", () => {
      for (const title of [
        "only in a comment",
        "a skipped case",
        "a todo case",
        "a skipped suite",
        "a case in a skipped suite",
        "a suite with nothing live",
        "only a skipped case",
        "a string, not a call",
        "check-privacy",
      ]) {
        expect(titles.has(title), title).toBe(false);
      }
    });
  });

  it("makes document rows cite docs, the coverage record or a planning record", () => {
    expect(rows().filter((r) => r.kind === "document").length).toBeGreaterThan(0);
    for (const row of rows().filter((r) => r.kind === "document")) {
      expect(
        row.cites.some(
          (c) =>
            /^(docs\/|\.planning\/)/.test(c.file) ||
            c.file.endsWith("package.json") ||
            c.file.endsWith("COVERAGE.md"),
        ),
        row.id,
      ).toBe(true);
    }
  });

  it("cites a test file or a gate script for every mitigated row that is not a document row", () => {
    expect(rows().filter((r) => r.disposition === "mitigate").length).toBeGreaterThan(40);
    for (const row of rows().filter((r) => r.disposition === "mitigate" && r.kind !== "document")) {
      expect(
        row.cites.some(
          (c) =>
            /\.test\.tsx?$/.test(c.file) ||
            /^scripts\//.test(c.file) ||
            /\.audit\.test\./.test(c.file),
        ),
        row.id,
      ).toBe(true);
    }
  });

  it("covers the provenance model of 07-FIX6 and 07-FIX6b: the store is the trust root", () => {
    const row = rows().find((r) => r.id === "T-07-F6");
    const files = row?.cites.map((c) => c.file) ?? [];
    expect(files).toContain("docs/adr/0030-research-provenance-store-trust-root.md");
    expect(files).toContain("packages/service/src/research/view-model-store-trust.test.ts");
    expect(files).toContain("packages/service/src/research/view-model-report-binding.test.ts");
    expect(files).toContain("packages/test-fixtures/src/research-routes-hostile.int.test.ts");
    expect(files).toContain("packages/operational-store/src/research-source-store.test.ts");
    expect(files).toContain("packages/operational-store/src/research-report-store.test.ts");
    expect(row?.cell).toMatch(/vault-confined/);
  });
});

run("summariser call path (SC4, Test 4)", () => {
  const trace = section(evidence, "Summariser call path");

  interface Step {
    readonly step: number;
    readonly file: string;
    readonly symbol: string;
    readonly proofs: { file: string; quote: string }[];
  }

  function steps(): Step[] {
    const out: Step[] = [];
    for (const line of trace.split("\n")) {
      const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
      if (!/^\d+$/.test(cells[1] ?? "")) continue;
      out.push({
        step: Number(cells[1]),
        file: (/`([^`]+)`/.exec(cells[2] ?? "")?.[1] ?? "") as string,
        symbol: (/`([^`]+)`/.exec(cells[3] ?? "")?.[1] ?? "") as string,
        proofs: [...(cells[5] ?? "").matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map((m) => ({
          file: m[1] as string,
          quote: m[2] as string,
        })),
      });
    }
    return out;
  }

  it("lists the call, in order, from the composition root to the response parser", () => {
    const order = [
      "main.ts",
      "createResearchServices",
      "pipeline",
      "summarizeUntrusted",
      "TextTransport",
      "AnthropicRequestSchema",
      "parseAnthropicResponse",
    ];
    let from = 0;
    for (const marker of order) {
      const at = trace.indexOf(marker, from);
      expect(at, marker).toBeGreaterThanOrEqual(0);
      from = at;
    }
    const found = steps();
    expect(found.map((s) => s.step)).toEqual(found.map((_, i) => i + 1));
    expect(found.length).toBeGreaterThanOrEqual(7);
  });

  it("names a real file and a real symbol in it for every step, and proves each with a real test", () => {
    expect(steps().length).toBeGreaterThanOrEqual(7);
    for (const step of steps()) {
      const path = join(REPO_ROOT, step.file);
      expect(existsSync(path), `step ${step.step} ${step.file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `step ${step.step} ${step.symbol}`).toContain(step.symbol);
      expect(step.proofs.length, `step ${step.step}`).toBeGreaterThan(0);
      for (const proof of step.proofs) {
        const proofPath = join(REPO_ROOT, proof.file);
        expect(existsSync(proofPath), `step ${step.step} ${proof.file}`).toBe(true);
        expect(readFileSync(proofPath, "utf8"), `step ${step.step} ${proof.file}`).toContain(
          proof.quote,
        );
      }
    }
  });

  it("states the three enforcement layers of plan 07-02 by name and the two conclusions", () => {
    for (const layer of ["eslint boundary element", "compiler layer", "backstop rule 17"]) {
      expect(trace, layer).toContain(layer);
    }
    expect(trace).toMatch(/cannot invoke a tool/);
    expect(trace).toMatch(/cannot write a file/);
    expect(trace).toContain('"types": []');
  });

  it("reflects the provenance model: the operational store, not the vault, vouches for a quote", () => {
    expect(trace).toContain("ADR 0030");
    expect(trace).toMatch(/operational store/);
    expect(trace).toContain("research_source_records");
    expect(trace).toContain("research_report_records");
  });
});

run("security scan inputs (Test 5)", () => {
  const scan = section(evidence, "Security scan inputs");

  it("names each trust boundary, each attack attempt and the accepted risks", () => {
    for (const word of [
      "Outbound fetcher",
      "Sanitiser and feed parser",
      "Delimiter",
      "Untrusted port",
      "Transport",
      "Trusted validation",
      "Vault writers",
      "Provenance store",
      "Routes and guard",
      "Keychain read",
      "SSRF",
      "Forged delimiter",
      "Prompt injection",
      "Image beacon",
      "tool_use",
      "Hostile frontmatter",
      "Traversal",
      "Oversized",
      "Test override in the installed service",
      "Forged report and raw note",
      "Edited report",
      "Accepted risks",
      "stylesheet-hidden",
      "existing vault",
      "assumption A1",
    ]) {
      expect(scan, word).toContain(word);
    }
  });

  it("gives the SSRF attempts as a table of hosts and redirects", () => {
    const table = scan.split("\n").filter((line) => /^\| `/.test(line));
    expect(table.length).toBeGreaterThan(10);
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "2130706433",
      "[::ffff:7f00:1]",
      "redirect",
      "rebinding",
    ]) {
      expect(scan, host).toContain(host);
    }
  });

  it("states the redirect rules the fetcher enforces (07-FIX8)", () => {
    const rows = scan.split("\n").filter((line) => /^\| `redirect/.test(line));
    const row = (needle: string): string => rows.find((line) => line.includes(needle)) ?? "";
    // Another host is refused after one request; the same host or a www. toggle is followed.
    expect(row("another host")).toContain("unsafe-redirect after one request");
    expect(row("the same host")).toContain("followed");
    expect(row("the same host")).toContain("www.");
    // The cap: the code is redirect-limit, on the fourth redirect response, four requests in all.
    const cap = row("more than three hops");
    expect(cap).toContain("redirect-limit");
    expect(cap).toContain("four requests");
    expect(cap).not.toContain("unsafe-redirect");
    expect(cap).not.toContain("no fourth request");
  });

  it("lists only paths that exist", () => {
    const paths = [...scan.matchAll(/`((?:packages|docs|scripts)\/[^`\s]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
  });
});

function packageScripts(): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}

run("merge-gate runbook (Task 3, Tests 1 to 3)", () => {
  it("orders the sections as the plan requires", () => {
    const order = [
      "Post-wave gates",
      "Full unfiltered test run",
      "Migration-position re-check",
      "Container visual comparison",
      "Full automated UAT run",
      "Judge panel",
      "Codex blocking judge",
      "Owner live items",
      "Merge and publish",
      "Closing checklist",
    ];
    const positions = order.map((title, index) => gates.indexOf(`## ${index + 1}. ${title}`));
    for (const [index, position] of positions.entries()) {
      expect(position, order[index]).toBeGreaterThan(-1);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names only commands, scripts, runner subcommands and flags that exist", () => {
    const scripts = packageScripts();
    const e2eScripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "packages", "e2e", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
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
    for (const line of gates.split("\n").filter((l) => l.includes("packages/e2e/dist/cli.js"))) {
      const command = /packages\/e2e\/dist\/cli\.js ([a-z-]+)/.exec(line)?.[1] as string;
      const key = command.includes("-") ? `"${command}"` : command;
      expect(cli, `runner command ${command}`).toContain(key);
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
        const name = flag.slice(2);
        expect(
          cliArgs.includes(`"${name}"`) || new RegExp(`\\b${name}: \\{ type:`).test(cliArgs),
          `${command} ${flag}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
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
  });

  it("states the policies the plan requires", () => {
    expect(gates).toMatch(
      /generated on top of the merged journal and never at a number written in advance/,
    );
    expect(gates).toMatch(/full unfiltered run is the post-merge gate/);
    expect(gates).toMatch(/live owner items must be recorded before phase closure/);
    expect(gates).toMatch(/never used to execute plans marked high risk/i);
    expect(gates).toMatch(/80 percent of the weekly allowance/);
    expect(gates).toMatch(/blind dual review and debate/);
    expect(gates).toMatch(/accept auto-results of run/);
    for (const judge of [
      "gsd-verifier",
      "code-review",
      "prd-compliance-review",
      "claude-security",
    ]) {
      expect(gates, judge).toContain(judge);
    }
    expect(gates).toContain("Security scan inputs");
    expect(gates).toContain("07-THREAT-EVIDENCE.md");
    expect(gates).toContain("07-UAT-AUTO-REPORT.md");
    expect(gates).toContain("ADR 0030");
  });

  it("lists the high-risk plans by reading each plan's front matter", () => {
    const high = planFiles()
      .filter((name) => /^risk: high$/m.test(readFileSync(join(dir, name), "utf8")))
      .map((name) => name.slice(0, 5));
    expect(high.length).toBeGreaterThan(0);
    const listed = /High-risk plans[^:]*: ([^\n]+)/.exec(gates)?.[1] ?? "";
    for (const plan of high) expect(listed, plan).toContain(plan);
    const named = [...listed.matchAll(/07-\d\d/g)].map((m) => m[0]);
    expect(named.sort()).toEqual([...high].sort());
  });
});

run("validation map (Task 3, Test 4)", () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(validation)?.[1] ?? "";
  const mapSection = section(validation, "Per-Task Verification Map");

  interface MapRow {
    readonly plan: string;
    readonly task: number;
    readonly commands: string[];
    readonly status: string;
  }

  function mapRows(): MapRow[] {
    const out: MapRow[] = [];
    for (const line of mapSection.split("\n")) {
      const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
      const id = /^(07-\d\d)-T(\d+)$/.exec(cells[1] ?? "");
      if (id === null) continue;
      out.push({
        plan: id[1] as string,
        task: Number(id[2]),
        commands: [...(cells[5] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
        status: cells[6] ?? "",
      });
    }
    return out;
  }

  const statuses = ["\u2705 green", "\u2B1C merge gate"];

  it("has one row per task of every 07-NN plan, with a command and a status", () => {
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
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      expect(row.commands.length, `${row.plan} T${row.task}`).toBeGreaterThan(0);
      expect(statuses, `${row.plan} T${row.task}`).toContain(row.status);
    }
  });

  it("carries each task's automated command from its plan, with only live-runner rows not green", () => {
    const rows = mapRows();
    for (const file of planFiles()) {
      const plan = file.slice(0, 5);
      const blocks = [
        ...readFileSync(join(dir, file), "utf8").matchAll(/<task type=[^>]*>([\s\S]*?)<\/task>/g),
      ];
      for (const [index, block] of blocks.entries()) {
        const planned = [
          ...(block[1] as string).matchAll(/<automated>([\s\S]*?)<\/automated>/g),
        ].map((m) => (m[1] as string).trim());
        const row = rows.find((r) => r.plan === plan && r.task === index + 1);
        expect(planned.length, `${plan} T${index + 1}`).toBeGreaterThan(0);
        for (const command of planned) {
          // The two plan-time test paths whose extension changed are the only allowed rewrites.
          const normal = (text: string) =>
            text
              .replace(/\s+/g, " ")
              .replace(/src\/research\/(events|wiring)\.test\.ts\b/g, "src/research/$1.test.tsx")
              .replace(
                /\bpnpm --filter @ccc\/e2e run (uat|uat:lint) -- /g,
                "pnpm --filter @ccc/e2e run $1 ",
              );
          const cell = (row?.commands ?? []).map((c) => normal(c.replace(/\\\|/g, "|")));
          expect(cell, `${plan} T${index + 1}: ${command.slice(0, 60)}`).toContain(normal(command));
        }
      }
    }
    for (const row of rows.filter((r) => r.status !== statuses[0])) {
      expect(row.commands.join(" "), `${row.plan} T${row.task}`).toMatch(/e2e run uat /);
    }
  });

  it("names only test files that exist in the package the command filters to", () => {
    let checked = 0;
    for (const row of mapRows()) {
      for (const command of row.commands) {
        for (const match of command.matchAll(
          /--filter @ccc\/([a-z0-9-]+) exec vitest run ([^&;]*)/g,
        )) {
          for (const path of (match[2] as string)
            .split(/\s+/)
            .filter((p) => /\.test\.tsx?$/.test(p))) {
            expect(
              existsSync(join(REPO_ROOT, "packages", match[1] as string, path)),
              `${row.plan} T${row.task} ${path}`,
            ).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("sets wave_0_complete only when no reference is MISSING, and nyquist_compliant only when nothing is still a merge gate", () => {
    const missing =
      /\bMISSING\b/.test(mapSection) ||
      /\bMISSING\b/.test(section(validation, "Wave 0 Requirements"));
    const open = mapRows().filter((row) => row.status !== statuses[0]);
    const nyquist = /^nyquist_compliant: (true|false)$/m.exec(front)?.[1];
    const wave0 = /^wave_0_complete: (true|false)$/m.exec(front)?.[1];
    expect(["true", "false"]).toContain(nyquist);
    expect(["true", "false"]).toContain(wave0);
    // Wave 0 is about files that must exist before work: a MISSING one is the only thing against it.
    expect(wave0).toBe(missing ? "false" : "true");
    // Nyquist compliance means every task has an automated check that has passed. A row that still
    // reads "merge gate" has not passed one yet, so the flag stays false until the runner reports
    // (07-FIX7, MINOR e).
    expect(nyquist).toBe(missing || open.length > 0 ? "false" : "true");
    if (open.length > 0) expect(nyquist, "rows still read merge gate").toBe("false");
  });

  it("fills every Wave 0 gap with files that exist", () => {
    const wave0 = section(validation, "Wave 0 Requirements");
    const paths = [...wave0.matchAll(/`((?:packages|scripts|docs|\.planning)\/[^`\s]+)`/g)].map(
      (m) => m[1],
    );
    expect(paths.length).toBeGreaterThan(14);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
    const rows = wave0.split("\n").filter((line) => /^\| W0-\d/.test(line));
    expect(rows.length).toBe(8);
    for (const row of rows) expect(row, row).toMatch(/\u2705 filled/);
  });
});
